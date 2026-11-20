// 本地 OpenAI 兼容端点：把 /v1/chat/completions 转成 kernel 的 session/prompt
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { consumeEvents, usageOf, newCompletionId, normalizeFailure } from './events.mjs';
import { handleAnthropic } from './anthropic.mjs';
import { handleResponses } from './responses.mjs';
import { createAdmin } from './admin.mjs';

let VERSION = '0.0.0';
try {
  VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
} catch {}

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

/**
 * OpenAI tools → MCP 工具定义。
 * 兼容 {type:'function', function:{name,description,parameters}} 与扁平 {name,description,parameters}。
 * 内置类型（web_search 等）跳过——它们没有可执行的 JSON schema，交回客户端也没法跑。
 */
export function collectChatTools(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  const seen = new Set();
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    const fn = t.function ?? t;
    const name = fn?.name;
    if (typeof name !== 'string' || !name || seen.has(name)) continue;
    if (t.type && t.type !== 'function') continue;
    seen.add(name);
    out.push({
      name,
      description: fn.description ?? '',
      parameters: fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} },
    });
  }
  return out;
}

/** 从 OpenAI messages 里取本轮回灌的工具结果 → { tool_call_id: text } */
function collectChatToolOutputs(messages) {
  const outputs = {};
  if (!Array.isArray(messages)) return outputs;
  for (const m of messages) {
    if (m?.role === 'tool' && typeof m.tool_call_id === 'string') {
      outputs[m.tool_call_id] = contentToText(m.content);
    }
  }
  return outputs;
}

/** MCP 调用 → OpenAI assistant.tool_calls 条目 */
function callToToolCall(call) {
  return {
    id: call.id,
    type: 'function',
    function: { name: call.tool, arguments: JSON.stringify(call.args ?? {}) },
  };
}

/**
 * 合并客户端下发的全部系统提示词。
 *
 * 客户端可能把提示词拆成多条（`system` / `developer`），也可能把它放在数组末尾；
 * 只取第一条会让真正的提示词丢失，内核随即回落到自己的「星辰」人设。
 */
export function mergeSystemPrompt(messages = []) {
  return messages
    .filter((m) => m && (m.role === 'system' || m.role === 'developer'))
    .map((m) => contentToText(m.content).trim())
    .filter(Boolean)
    .join('\n\n');
}

/** 会话指纹：显式 id 优先，否则用首条用户消息前 400 字。prefix 用于隔离不同协议的会话表 */
export function conversationKey(body, messages, prefix = '') {
  const explicit = body?.user ?? body?.conversation_id ?? body?.session_id;
  let base;
  if (typeof explicit === 'string' && explicit) {
    base = explicit;
  } else {
    const firstUser = messages.find((m) => m.role === 'user');
    const hash = crypto.createHash('sha1').update(contentToText(firstUser?.content ?? '').slice(0, 400)).digest('hex');
    base = `auto-${hash.slice(0, 16)}`;
  }
  return prefix ? `${prefix}:${base}` : base;
}

/**
 * 本轮发什么文本：首轮折叠全部对话，后续只发新增的 user/tool 消息。
 * （kernel 自己保存会话历史，助手消息无需回放）
 *
 * 注意：system 消息**不**拼进用户文本。它已经作为 agent prompt 进了内核的 system 消息，
 * 再复述一遍等于给模型两份互相竞争的指令，只会让身份/风格更混乱。
 */
export function planTurn(record, messages) {
  const users = messages.filter((m) => m.role === 'user');
  const tools = messages.filter((m) => m.role === 'tool');

  if (!record) {
    const convo = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
    const body = convo.map((m) => `${m.role === 'assistant' ? '助手' : '用户'}：${contentToText(m.content)}`).join('\n');
    return {
      text: body,
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

function hashOf(text) {
  return crypto.createHash('sha1').update(String(text ?? '')).digest('hex').slice(0, 12);
}

function systemTextOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => (typeof p === 'string' ? p : p?.text ?? ''))
    .filter(Boolean)
    .join('\n');
}

export async function createShim({
  getKernel,
  kernel: initialKernel = null,
  kernelStatus = null,
  bridge = null,
  models,
  apiKey = null,
  keystore = null,
  gatewayInfo = null,
  adminToken = null,
  port = 0,
  host = '127.0.0.1',
  logger = console,
}) {
  // 兼容两种传法：固定 kernel（测试用）或按请求取 kernel（生产用，跟随客户端提示词）
  const resolveKernel = typeof getKernel === 'function' ? getKernel : async () => initialKernel;
  const sessions = new Map();
  const TTL = 6 * 60 * 60 * 1000;
  const startedAt = Date.now();

  const gatewayState = () => ({
    baseUrl: `http://127.0.0.1:${server.address()?.port ?? port}/v1`,
    port: server.address()?.port ?? port,
    version: VERSION,
    kernel: (typeof kernelStatus === 'function' ? kernelStatus() : null)?.origin ?? initialKernel?.origin ?? null,
    agent: (() => {
      const s = typeof kernelStatus === 'function' ? kernelStatus() : null;
      return s ? { client: s.client ?? null, promptChars: s.promptChars ?? null, promptSha: s.promptSha ?? null, verified: s.verified ?? null } : null;
    })(),
    models: models.map((m) => m.id),
    authRequired: keystore ? keystore.required(apiKey) : Boolean(apiKey),
    hasEnvKey: Boolean(apiKey),
    keysFile: keystore?.file ?? null,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    ...(typeof gatewayInfo === 'function' ? gatewayInfo() : {}),
  });

  const admin = keystore ? createAdmin({ keystore, info: gatewayState, adminToken }) : null;

  /** 多密钥校验：环境变量主密钥 → 密钥表 → 匿名（未开启鉴权时） */
  function authenticate(req) {
    const authHeader = req.headers.authorization ?? '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const given = bearer || String(req.headers['x-api-key'] ?? '').trim();
    if (apiKey && given === apiKey) return { ok: true, record: null, envKey: true };
    const verdict = keystore && given ? keystore.verify(given) : { ok: false, reason: given ? 'unknown' : 'missing' };
    if (verdict.ok) return { ok: true, record: verdict.record };
    const required = keystore ? keystore.required(apiKey) : Boolean(apiKey);
    if (!required) return { ok: true, record: null };
    return { ok: false, reason: verdict.reason ?? 'unknown' };
  }

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

  async function newSession(kernel, key) {
    const res = await kernel.call('POST', '/session', { title: `shim-${key.slice(0, 8)}` });
    const id = res.json?.id;
    if (!id) throw new Error(`建会话失败：${res.status} ${String(res.text).slice(0, 200)}`);
    return id;
  }

  async function promptAsync(kernel, sessionID, modelID, text, toolFlags) {
    const body = { model: { providerID: 'NewApi', modelID }, parts: [{ type: 'text', text }] };
    // 工具中继轮：关掉内核自带工具，只留 MCP 桥挂进来的那些（避免内核自说自话地执行 bash/read）
    if (toolFlags && Object.keys(toolFlags).length > 0) body.tools = toolFlags;
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
  /**
   * 执行一轮。返回 { text, reasoning, tokens, error, interrupted, calls }
   *
   * 工具中继状态机（chat / anthropic 共用；Responses 有自己独立的一套）：
   *  - 本轮带 tools：挂 MCP 桥、关内核自带工具，把模型发起的调用挂起交给客户端
   *  - 本轮带 outputs：放行上一轮挂起的调用，kernel 接着生成（不再发新 prompt）
   * 不带工具也不带 outputs 时，行为与旧版完全一致（纯对话）。
   */
  async function runTurn({
    kernel, body, messages, modelID, signal, onDelta, onReasoningDelta,
    tools = null, outputs = null, keyPrefix = '',
  }) {
    const key = conversationKey(body, messages, keyPrefix);
    const rec = getRecord(key);
    const plan = planTurn(rec, messages);
    const sessionID = rec?.sessionID ?? (await newSession(kernel, key));

    const hasOutputs = outputs && typeof outputs === 'object' && Object.keys(outputs).length > 0;
    const resuming = Boolean(rec?.awaiting && hasOutputs && bridge);

    // 上一轮挂了工具但结果没送达（客户端中断/超时）：放掉挂起调用、abort 会话，本轮按新提问重来
    if (rec?.awaiting && !resuming && bridge) {
      bridge.cancel('上一轮工具结果未送达');
      try { await kernel.call('POST', `/session/${sessionID}/abort`, {}); } catch {}
      sessions.delete(key);
      return runTurn({ kernel, body, messages, modelID, signal, onDelta, onReasoningDelta, tools, outputs: null, keyPrefix });
    }

    let toolFlags = null;
    try {
      if (!resuming && tools && tools.length > 0 && bridge) {
        const changed = bridge.setTools(tools);
        try {
          await bridge.mount({ force: changed || !bridge.mountedOnce });
          await bridge.waitForRegistration({ expected: tools.length, timeoutMs: 4000 });
          toolFlags = await bridge.builtinFlags();
        } catch (err) {
          logger.warn?.('[teleagent] 工具桥挂载失败，本轮降级为纯对话：', err?.message ?? err);
          toolFlags = null;
        }
      }

      let result;
      if (resuming) {
        // 放行挂起的 MCP 调用，接着读同一条事件流；kernel 已持有上下文，不再发新 prompt
        const resolved = bridge.resolve(outputs);
        logger.log?.(`[teleagent] 放行工具结果 ${resolved} 个，kernel 续跑`);
        result = await consumeEvents({
          kernel, sessionID, signal, onDelta, onReasoningDelta,
          callWatcher: () => bridge.hasCalls(),
        });
      } else {
        result = await consumeEvents({
          kernel, sessionID, signal, onDelta, onReasoningDelta,
          sentText: plan.text,
          callWatcher: () => (bridge ? bridge.hasCalls() : false),
          onReady: () => promptAsync(kernel, sessionID, modelID, plan.text, toolFlags),
        });
      }

      const calls = bridge ? bridge.takeCalls() : [];
      sessions.set(key, {
        sessionID,
        seenUserCount: plan.seenUserCount,
        seenToolCount: plan.seenToolCount,
        awaiting: calls.length > 0,
        usedAt: Date.now(),
      });
      return { ...result, calls };
    } catch (err) {
      // 本轮失败：abort 掉内核会话，避免会话永远 busy；放掉可能挂起的调用
      try { await kernel.call('POST', `/session/${sessionID}/abort`, {}); } catch {}
      sessions.delete(key);
      if (bridge) bridge.cancel(err?.message ?? 'error');
      throw err;
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const urlPath = (req.url ?? '/').split('?')[0];

      // ---- 管理台（本机页面 + 管理接口，不走 API key 鉴权）----
      if (admin && (urlPath === '/admin' || urlPath === '/admin/' || urlPath.startsWith('/admin/'))) {
        const handled = await admin(req, res, urlPath === '/admin/' ? '/admin' : urlPath);
        if (handled) return;
      }
      if (req.method === 'GET' && (urlPath === '/' || urlPath === '/index.html')) {
        if (admin) {
          res.writeHead(302, { location: '/admin' });
          res.end();
          return;
        }
      }

      if (req.method === 'GET' && (req.url === '/v1/models' || req.url === '/models')) {
        return json(res, 200, {
          object: 'list',
          data: models.map((m) => ({ id: m.id, object: 'model', owned_by: 'teleagent', created: 0 })),
        });
      }

      if (req.method === 'GET' && (req.url === '/healthz' || req.url === '/health')) {
        const status = typeof kernelStatus === 'function' ? kernelStatus() : null;
        return json(res, 200, {
          ok: true,
          kernel: status?.origin ?? initialKernel?.origin ?? null,
          models: models.length,
          authRequired: keystore ? keystore.required(apiKey) : Boolean(apiKey),
          keys: keystore ? keystore.stats().activeKeys : 0,
          // 当前生效的提示词来源：codex / claude / chat / neutral，verified 表示已回读内核确认
          agent: status
            ? { client: status.client ?? null, promptChars: status.promptChars ?? null, promptSha: status.promptSha ?? null, verified: status.verified ?? null }
            : null,
        });
      }

      const pathOnly = urlPath;
      const isMessages = pathOnly === '/v1/messages' || pathOnly === '/v1/messages/count_tokens';
      const isChat = pathOnly === '/v1/chat/completions' || pathOnly === '/chat/completions';
      const isResponses = pathOnly === '/v1/responses';

      if (req.method !== 'POST' || (!isChat && !isMessages && !isResponses)) {
        return json(res, 404, { error: { message: `not found: ${req.method} ${req.url}`, type: 'invalid_request_error' } });
      }

      const auth = authenticate(req);
      if (!auth.ok) {
        const messagesByReason = {
          missing: ['missing api key', 'invalid_api_key'],
          unknown: ['invalid api key', 'invalid_api_key'],
          disabled: ['api key disabled', 'key_disabled'],
          expired: ['api key expired', 'key_expired'],
        };
        const [message, code] = messagesByReason[auth.reason] ?? messagesByReason.unknown;
        return json(res, 401, { error: { message, type: 'invalid_request_error', code } });
      }

      // 计量：等响应收尾时记一笔（成功/失败都算，便于排查）
      const reqStartedAt = Date.now();
      let usageTokens = null;
      let usageModel = '';
      let usageProtocol = isMessages ? 'anthropic' : isResponses ? 'responses' : 'openai';
      if (keystore) {
        res.on('finish', () => {
          try {
            keystore.record({
              keyId: auth.record?.id ?? null,
              model: usageModel,
              protocol: usageProtocol,
              stream: res.__stream === true,
              status: res.statusCode,
              ms: Date.now() - reqStartedAt,
              tokens: usageTokens,
            });
          } catch (err) {
            logger.error?.('记录用量失败', err);
          }
        });
      }
      const addTokens = (tokens) => {
        if (!tokens) return;
        usageTokens = {
          input: (usageTokens?.input ?? 0) + (tokens.input ?? 0),
          output: (usageTokens?.output ?? 0) + (tokens.output ?? 0),
        };
      };

      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (err) {
        return json(res, 400, { error: { message: `invalid JSON: ${err.message}`, type: 'invalid_request_error' } });
      }

      // 调试：TA_DEBUG_DIR 下按请求落一份原始 body（排查 Codex 形状用，用完记得关）
      if (process.env.TA_DEBUG_DIR) {
        try {
          const path = await import('node:path');
          fs.mkdirSync(process.env.TA_DEBUG_DIR, { recursive: true });
          const name = `${Date.now()}-${path.basename(pathOnly) || 'root'}.json`;
          fs.writeFileSync(path.join(process.env.TA_DEBUG_DIR, name), JSON.stringify(body, null, 2));
        } catch {}
      }

      // Claude Code / cc-switch 走 Anthropic Messages 协议
      if (isMessages) {
        // system 可能是 string 或 text block 数组；两者都要完整并入 agent prompt
        const prompt = systemTextOf(body.system).trim();
        usageModel = typeof body.model === 'string' ? body.model : '';
        res.__stream = body.stream === true;
        const kernel = await resolveKernel({ key: ['claude', hashOf(prompt)].join(':'), prompt });
        return handleAnthropic({
          req,
          res,
          body,
          models,
          kernel,
          runTurn: async (opts) => {
            const result = await runTurn({ kernel, ...opts });
            addTokens(result?.tokens);
            return result;
          },
          defaultModel: process.env.TA_DEFAULT_MODEL || models[0]?.id,
        });
      }

      // Codex CLI 走 Responses 协议（带工具中继）
      if (isResponses) {
        // Codex 的提示词在 instructions；部分客户端还会把 developer/system 消息塞进 input，
        // 两者都收，避免只拿到半截提示词
        const devFromInput = Array.isArray(body.input)
          ? body.input
              .filter((item) => item && (item.role === 'developer' || item.role === 'system'))
              .map((item) => contentToText(item.content).trim())
              .filter(Boolean)
              .join('\n\n')
          : '';
        const prompt = [typeof body.instructions === 'string' ? body.instructions.trim() : '', devFromInput]
          .filter(Boolean)
          .join('\n\n');
        usageModel = typeof body.model === 'string' ? body.model : '';
        res.__stream = body.stream !== false;
        const kernel = await resolveKernel({ key: ['codex', hashOf(prompt)].join(':'), prompt });
        return handleResponses({
          req,
          res,
          body,
          models,
          kernel,
          bridge,
          onUsage: addTokens,
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
      // 合并全部 system/developer 消息，别只取第一条
      const systemPrompt = mergeSystemPrompt(messages);
      const kernel = await resolveKernel({ key: ['chat', hashOf(systemPrompt)].join(':'), prompt: systemPrompt });
      const wantStream = body.stream === true;
      usageModel = body.model;
      res.__stream = wantStream;
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });

      // 本轮工具上下文：body.tools 注册到 MCP 桥；messages 里 role:tool 是上一轮调用的结果
      const chatTools = collectChatTools(body.tools);
      const chatOutputs = collectChatToolOutputs(messages);

      if (!wantStream) {
        try {
          const result = await runTurn({
            kernel, body, messages, modelID: body.model, signal: controller.signal,
            tools: chatTools, outputs: chatOutputs, keyPrefix: 'chat',
          });
          addTokens(result.tokens);
          if (result.error) {
            const failure = normalizeFailure(result.error);
            return json(res, failure.status ?? 502, { error: { message: failure.message, type: 'upstream_error', code: failure.code ?? 'upstream_error' } });
          }
          const calls = result.calls ?? [];
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
                  content: calls.length > 0 ? null : result.text,
                  ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
                  ...(calls.length > 0 ? { tool_calls: calls.map(callToToolCall) } : {}),
                },
                finish_reason: calls.length > 0 ? 'tool_calls' : 'stop',
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
          kernel,
          body,
          messages,
          modelID: body.model,
          signal: controller.signal,
          tools: chatTools,
          outputs: chatOutputs,
          keyPrefix: 'chat',
          onDelta: (d) => send({ content: d }),
          onReasoningDelta: (d) => send({ reasoning_content: d }),
        });
        addTokens(result.tokens);
        if (result.error) {
          const failure = normalizeFailure(result.error);
          res.write(`data: ${JSON.stringify({ error: { message: failure.message, code: failure.code ?? 'upstream_error' } })}\n\n`);
        } else if ((result.calls ?? []).length > 0) {
          // 工具调用轮：按 OpenAI 流式规范逐个发 tool_calls（index/id/type → arguments 增量）
          result.calls.forEach((call, i) => {
            const tc = callToToolCall(call);
            send({ tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: '' } }] });
            send({ tool_calls: [{ index: i, function: { arguments: tc.function.arguments } }] });
          });
          send({ tool_calls: [] }, 'tool_calls', { usage: usageOf(result.tokens) });
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
    server.listen(port, host, resolve);
  });

  return {
    /** kernel 换实例后清空会话映射（旧 sessionID 已失效） */
    resetSessions() {
      sessions.clear();
    },
    port: server.address().port,
    url: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}



