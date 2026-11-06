// Anthropic Messages API 适配层：/v1/messages（Claude Code / cc-switch 走这里）
import crypto from 'node:crypto';

const ANTHROPIC_VERSION = '2023-06-01';

function blocksToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'tool_result') parts.push(`【工具结果】\n${blocksToText(block.content)}`);
    else if (block.type === 'tool_use') parts.push(`【工具调用】${block.name ?? ''} ${JSON.stringify(block.input ?? {})}`);
    else if (block.type === 'image') parts.push('【图片】');
    else if (typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/** Anthropic 请求体 → OpenAI 风格 messages（system 提到最前面） */
export function toChatMessages(body) {
  const out = [];
  const system = typeof body.system === 'string' ? body.system : blocksToText(body.system);
  if (system) out.push({ role: 'system', content: system });
  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    if (!msg?.role) continue;
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    out.push({ role, content: blocksToText(msg.content) });
  }
  return out;
}

/** 选一个 kernel 能跑的模型：显式匹配优先，否则退回默认 */
export function resolveModel(models, requested, fallback) {
  const hit = models.find((m) => m.id === requested);
  if (hit) return hit.id;
  const byAlias = models.find((m) => requested?.includes?.(m.id));
  if (byAlias) return byAlias.id;
  return fallback ?? models.find((m) => m.id === 'chat-pro')?.id ?? models[0]?.id;
}

function estimateTokens(text) {
  // 粗估：中文约 1 字 1 token，英文约 4 字符 1 token；Claude Code 只用它做预算判断
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  return Math.max(1, cjk + Math.ceil((text.length - cjk) / 4));
}

function sse(res, event, data) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * 处理 /v1/messages 与 /v1/messages/count_tokens。
 * @param {object} args
 * @param {(args:{body:object,messages:object[],modelID:string,signal:AbortSignal,onDelta?:Function,onReasoningDelta?:Function})=>Promise<{text:string,reasoning?:string,tokens?:object,error?:object}>} args.runTurn
 */
export async function handleAnthropic({ req, res, body, models, runTurn, defaultModel }) {
  const path = req.url.split('?')[0];

  if (path === '/v1/messages/count_tokens') {
    const text = toChatMessages(body).map((m) => m.content).join('\n');
    return jsonOut(res, 200, { input_tokens: estimateTokens(text) });
  }

  if (path !== '/v1/messages') {
    return jsonOut(res, 404, { type: 'error', error: { type: 'not_found_error', message: `not found: ${path}` } });
  }

  if (!body || typeof body !== 'object') {
    return jsonOut(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'invalid JSON body' } });
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return jsonOut(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'messages is required' } });
  }

  const messages = toChatMessages(body);
  const modelID = resolveModel(models, body.model, defaultModel);
  const modelEcho = typeof body.model === 'string' && body.model ? body.model : modelID;
  const wantStream = body.stream === true;
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  const id = `msg_${crypto.randomUUID().replace(/-/g, '')}`;

  const fail = (status, message, type = 'api_error') => {
    if (res.headersSent) {
      sse(res, 'error', { type: 'error', error: { type, message } });
      res.end();
      return;
    }
    jsonOut(res, status, { type: 'error', error: { type, message } });
  };

  if (!wantStream) {
    try {
      const result = await runTurn({ body, messages, modelID, signal: controller.signal });
      if (result.error) {
        const detail = result.error?.data?.responseBody ?? result.error?.data?.message ?? '上游错误';
        return fail(result.error?.data?.statusCode ?? 502, String(detail).slice(0, 400), 'upstream_error');
      }
      return jsonOut(res, 200, {
        id,
        type: 'message',
        role: 'assistant',
        model: modelEcho,
        content: [{ type: 'text', text: result.text }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: result.tokens?.input ?? 0,
          output_tokens: result.tokens?.output ?? 0,
        },
      });
    } catch (err) {
      return fail(err.status ?? 502, err.message, 'upstream_error');
    }
  }

  // ---- 流式 ----
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) sse(res, 'ping', { type: 'ping' });
  }, 15000);
  heartbeat.unref?.();

  try {
    sse(res, 'message_start', {
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model: modelEcho,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });

    let started = false;
    const result = await runTurn({
      body,
      messages,
      modelID,
      signal: controller.signal,
      onDelta: (delta) => {
        started = true;
        sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta } });
      },
    });

    if (result.error) {
      const detail = result.error?.data?.responseBody ?? result.error?.data?.message ?? '上游错误';
      sse(res, 'error', { type: 'error', error: { type: 'upstream_error', message: String(detail).slice(0, 400) } });
      return;
    }

    sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    sse(res, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: {
        input_tokens: result.tokens?.input ?? 0,
        output_tokens: result.tokens?.output ?? 0,
      },
    });
    sse(res, 'message_stop', { type: 'message_stop' });
  } catch (err) {
    if (!controller.signal.aborted) {
      sse(res, 'error', { type: 'error', error: { type: 'upstream_error', message: err.message } });
    }
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
}

export function anthropicHeadersOk() {
  return { 'anthropic-version': ANTHROPIC_VERSION };
}

function jsonOut(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
