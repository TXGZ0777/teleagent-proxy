// 本地 OpenAI 兼容端点：把 /v1/chat/completions 转成 kernel 的 session/prompt
import http from 'node:http';
import crypto from 'node:crypto';
import { consumeEvents, usageOf, newCompletionId, normalizeFailure } from './events.mjs';
import { handleAnthropic } from './anthropic.mjs';
import { handleResponses } from './responses.mjs';

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => (typeof p === 'string' ? p : p?.text ?? ''))
    .filter(Boolean)
    .join('\n');
}

/** 会话指纹：显式 id 优先，否则用首条用户消息前 400 字 */
export function conversationKey(body, messages) {
  const explicit = body?.user ?? body?.conversation_id ?? body?.session_id;
  if (typeof explicit === 'string' && explicit) return explicit;
  const firstUser = messages.find((m) => m.role === 'user');
  const hash = crypto.createHash('sha1').update(contentToText(firstUser?.content ?? '').slice(0, 400)).digest('hex');
  return `auto-${hash.slice(0, 16)}`;
}

/**
 * 本轮发什么文本：首轮把 system + 全部对话折叠；后续只发新增的 user/tool 消息。
 * （kernel 自己保存会话历史，助手消息无需回放）
 */
export function planTurn(record, messages) {
  const sys = messages.filter((m) => m.role === 'system').map((m) => contentToText(m.content));
  const users = messages.filter((m) => m.role === 'user');
  const tools = messages.filter((m) => m.role === 'tool');

  if (!record) {
    const convo = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
    const body = convo.map((m) => `${m.role === 'assistant' ? '助手' : '用户'}：${contentToText(m.content)}`).join('\n');
    return {
      text: (sys.length ? `${sys.join('\n')}\n\n` : '') + body,
      seenUserCount: users.length,
      seenToolCount: tools.length,
    };
  }

  const freshUsers = users.slice(record.seenUserCount ?? 0).map((m) => contentToText(m.content));
  const freshTools = tools.slice(record.seenToolCount ?? 0).map((m) => `【工具结果】\n${contentToText(m.content)}`);
  const chunks = [...freshUsers, ...freshTools];
  const text = chunks.length ? chunks.join('\n') : contentToText(users.at(-1)?.content ?? '');
  return { text, seenUserCount: users.length, seenToolCount: tools.length };
}

export async function createShim({ kernel, bridge = null, models, apiKey = null, port = 0, logger = console }) {
  const sessions = new Map();
  const TTL = 6 * 60 * 60 * 1000;

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of sessions) if (now - v.usedAt > TTL) sessions.delete(k);
  }, 10 * 60 * 1000);
  sweep.unref?.();

  function getRecord(key) {
    const rec = sessions.get(key);
    if (!rec) return undefined;
    if (Date.now() - rec.usedAt > TTL) {
      sessions.delete(key);
      return undefined;
    }
    rec.usedAt = Date.now();
    return rec;
  }

  async function newSession(key) {
    const res = await kernel.call('POST', '/session', { title: `shim-${key.slice(0, 8)}` });
    const id = res.json?.id;
    if (!id) throw new Error(`建会话失败：${res.status} ${String(res.text).slice(0, 200)}`);
    return id;
  }

  async function promptAsync(sessionID, modelID, text) {
    const body = { model: { providerID: 'NewApi', modelID }, parts: [{ type: 'text', text }] };
    const res = await kernel.call('POST', `/session/${sessionID}/prompt_async`, body);
    if (res.status >= 400) {
      const detail = res.json?.data?.message ?? res.json?.message ?? String(res.text).slice(0, 200);
      const err = new Error(`prompt_async 失败：${res.status} ${detail}`);
      err.status = res.status;
      err.upstream = res.json;
      throw err;
    }
  }

  /** 执行一轮，返回 { text, reasoning, tokens } */
  async function runTurn({ body, messages, modelID, signal, onDelta, onReasoningDelta }) {
    const key = conversationKey(body, messages);
    const rec = getRecord(key);
    const plan = planTurn(rec, messages);
    const sessionID = rec?.sessionID ?? (await newSession(key));

    const sent = plan.text;
    let result;
    try {
      result = await consumeEvents({
        kernel,
        sessionID,
        signal,
        onDelta,
        onReasoningDelta,
        sentText: sent,
        onReady: () => promptAsync(sessionID, modelID, sent),
      });
    } catch (err) {
      // 本轮失败：abort 掉内核会话，避免会话永远 busy
      try {
        await kernel.call('POST', `/session/${sessionID}/abort`, {});
      } catch {}
      sessions.delete(key);
      throw err;
    }

    sessions.set(key, { sessionID, seenUserCount: plan.seenUserCount, seenToolCount: plan.seenToolCount, usedAt: Date.now() });
    return result;
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && (req.url === '/v1/models' || req.url === '/models')) {
        return json(res, 200, {
          object: 'list',
          data: models.map((m) => ({ id: m.id, object: 'model', owned_by: 'teleagent', created: 0 })),
        });
      }

      if (req.method === 'GET' && (req.url === '/healthz' || req.url === '/health')) {
        return json(res, 200, { ok: true, kernel: kernel.origin, models: models.length });
      }

      const pathOnly = req.url.split('?')[0];
      const isMessages = pathOnly === '/v1/messages' || pathOnly === '/v1/messages/count_tokens';
      const isChat = pathOnly === '/v1/chat/completions' || pathOnly === '/chat/completions';
      const isResponses = pathOnly === '/v1/responses';

      if (req.method !== 'POST' || (!isChat && !isMessages && !isResponses)) {
        return json(res, 404, { error: { message: `not found: ${req.method} ${req.url}`, type: 'invalid_request_error' } });
      }

      if (apiKey) {
        const auth = req.headers.authorization ?? '';
        const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        const given = bearer || String(req.headers['x-api-key'] ?? '');
        if (given !== apiKey) {
          return json(res, 401, { error: { message: 'invalid api key', type: 'invalid_request_error', code: 'invalid_api_key' } });
        }
      }

      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (err) {
        return json(res, 400, { error: { message: `invalid JSON: ${err.message}`, type: 'invalid_request_error' } });
      }

      // 调试：TA_DEBUG_DIR 下按请求落一份原始 body（排查 Codex 形状用，用完记得关）
      if (process.env.TA_DEBUG_DIR) {
        try {
          const fs = await import('node:fs');
          const path = await import('node:path');
          fs.mkdirSync(process.env.TA_DEBUG_DIR, { recursive: true });
          const name = `${Date.now()}-${path.basename(pathOnly) || 'root'}.json`;
          fs.writeFileSync(path.join(process.env.TA_DEBUG_DIR, name), JSON.stringify(body, null, 2));
        } catch {}
      }

      // Claude Code / cc-switch 走 Anthropic Messages 协议
      if (isMessages) {
        return handleAnthropic({ req, res, body, models, runTurn, defaultModel: process.env.TA_DEFAULT_MODEL || models[0]?.id });
      }

      // Codex CLI 走 Responses 协议（带工具中继）
      if (isResponses) {
        return handleResponses({
          req,
          res,
          body,
          models,
          kernel,
          bridge,
          defaultModel: process.env.TA_DEFAULT_MODEL || models[0]?.id,
        });
      }

      if (!body?.model || typeof body.model !== 'string') {
        return json(res, 400, { error: { message: 'model is required', type: 'invalid_request_error' } });
      }
      if (!models.some((m) => m.id === body.model)) {
        return json(res, 400, {
          error: { message: `unknown model: ${body.model}`, type: 'invalid_request_error', code: 'model_not_found' },
        });
      }

      const messages = Array.isArray(body.messages) ? body.messages : [];
      const wantStream = body.stream === true;
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });

      if (!wantStream) {
        try {
          const result = await runTurn({ body, messages, modelID: body.model, signal: controller.signal });
          if (result.error) {
            const failure = normalizeFailure(result.error);
            return json(res, failure.status ?? 502, { error: { message: failure.message, type: 'upstream_error', code: failure.code ?? 'upstream_error' } });
          }
          return json(res, 200, {
            id: newCompletionId(),
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: result.text,
                  ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
                },
                finish_reason: 'stop',
              },
            ],
            usage: usageOf(result.tokens),
          });
        } catch (err) {
          const status = err.status ?? 502;
          return json(res, status, { error: { message: err.message, type: 'upstream_error', code: 'upstream_error' } });
        }
      }

      // ---- 流式 ----
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });

      const id = newCompletionId();
      const created = Math.floor(Date.now() / 1000);
      const send = (delta, finish = null, extra = {}) => {
        if (res.writableEnded) return;
        res.write(
          `data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model: body.model,
            choices: [{ index: 0, delta, finish_reason: finish }],
            ...extra,
          })}\n\n`,
        );
      };

      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(': ping\n\n');
      }, 15000);
      heartbeat.unref?.();

      try {
        send({ role: 'assistant', content: '' });
        const result = await runTurn({
          body,
          messages,
          modelID: body.model,
          signal: controller.signal,
          onDelta: (d) => send({ content: d }),
          onReasoningDelta: (d) => send({ reasoning_content: d }),
        });
        if (result.error) {
          const failure = normalizeFailure(result.error);
          res.write(`data: ${JSON.stringify({ error: { message: failure.message, code: failure.code ?? 'upstream_error' } })}\n\n`);
        } else {
          send({}, 'stop', { usage: usageOf(result.tokens) });
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          res.write(`data: ${JSON.stringify({ error: { message: err.message, code: 'upstream_error' } })}\n\n`);
        }
      } finally {
        clearInterval(heartbeat);
        if (!res.writableEnded) {
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }
    } catch (err) {
      logger.error?.('shim 内部错误', err);
      if (!res.headersSent) json(res, 500, { error: { message: err.message, type: 'internal_error' } });
      else if (!res.writableEnded) res.end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  return {
    port: server.address().port,
    url: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
