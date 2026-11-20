// Anthropic Messages API 适配层：/v1/messages（Claude Code / cc-switch 走这里）
//
// 工具中继：客户端 tools → MCP 桥 → kernel 调用 → 挂起 → 翻成 tool_use 交回
// → 客户端执行后回灌 tool_result → 放行挂起调用 → kernel 续跑。
// 与 chat 共用 shim 的 runTurn 状态机，靠 keyPrefix:'anthropic' 隔离会话。
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

/**
 * Anthropic tools（{name, description, input_schema}）→ MCP 工具定义。
 * Anthropic 用 input_schema，MCP/OpenAI 侧用 parameters，这里做字段映射。
 */
export function collectAnthropicTools(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  const seen = new Set();
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    const name = t.name;
    if (typeof name !== 'string' || !name || seen.has(name)) continue;
    seen.add(name);
    const schema = t.input_schema && typeof t.input_schema === 'object' ? t.input_schema : { type: 'object', properties: {} };
    out.push({ name, description: typeof t.description === 'string' ? t.description : '', parameters: schema });
  }
  return out;
}

/**
 * 从 messages 里取本轮回灌的工具结果 → { bridgeCallId: text }
 * Anthropic 的 tool_result 放在 user 消息的 content 块里，按 tool_use_id 对应。
 */
export function collectAnthropicToolOutputs(messages) {
  const outputs = {};
  if (!Array.isArray(messages)) return outputs;
  for (const msg of messages) {
    const content = msg?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
      outputs[fromAnthropicToolId(block.tool_use_id)] = blocksToText(block.content);
    }
  }
  return outputs;
}

/** bridge 的 call_xxx ↔ Anthropic 的 toolu_xxx：无状态前缀互换，保证回灌能对上挂起项 */
function toAnthropicToolId(callId) {
  return typeof callId === 'string' && callId.startsWith('call_') ? `toolu_${callId.slice(5)}` : `toolu_${callId}`;
}
function fromAnthropicToolId(id) {
  return typeof id === 'string' && id.startsWith('toolu_') ? `call_${id.slice(6)}` : id;
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
 * @param {(...args)=>Promise<{text:string,calls?:Array,reasoning?:string,tokens?:object,error?:object}>} args.runTurn
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
  const anthropicTools = collectAnthropicTools(body.tools);
  const toolOutputs = collectAnthropicToolOutputs(body.messages);
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  const id = `msg_${crypto.randomUUID().replace(/-/g, '')}`;

  // 一轮 runTurn 的公共参数：工具 + 回灌结果 + 协议隔离的会话前缀
  const turnArgs = {
    body, messages, modelID, signal: controller.signal,
    tools: anthropicTools, outputs: toolOutputs, keyPrefix: 'anthropic',
  };

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
      const result = await runTurn(turnArgs);
      if (result.error) {
        const detail = result.error?.data?.responseBody ?? result.error?.data?.message ?? '上游错误';
        return fail(result.error?.data?.statusCode ?? 502, String(detail).slice(0, 400), 'upstream_error');
      }
      const calls = result.calls ?? [];
      const content = [];
      if (result.text) content.push({ type: 'text', text: result.text });
      for (const call of calls) {
        content.push({
          type: 'tool_use',
          id: toAnthropicToolId(call.id),
          name: call.tool,
          input: call.args ?? {},
        });
      }
      return jsonOut(res, 200, {
        id,
        type: 'message',
        role: 'assistant',
        model: modelEcho,
        content,
        stop_reason: calls.length > 0 ? 'tool_use' : 'end_turn',
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

    // 文本块按需开启：纯工具调用轮不应发一个空的 text 块
    let textIndex = -1;
    let textStarted = false;
    const ensureTextBlock = () => {
      if (textStarted) return;
      textStarted = true;
      textIndex = 0;
      sse(res, 'content_block_start', { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } });
    };

    const result = await runTurn({
      ...turnArgs,
      onDelta: (delta) => {
        ensureTextBlock();
        sse(res, 'content_block_delta', { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: delta } });
      },
    });

    if (result.error) {
      const detail = result.error?.data?.responseBody ?? result.error?.data?.message ?? '上游错误';
      sse(res, 'error', { type: 'error', error: { type: 'upstream_error', message: String(detail).slice(0, 400) } });
      return;
    }

    if (textStarted) sse(res, 'content_block_stop', { type: 'content_block_stop', index: textIndex });

    const calls = result.calls ?? [];
    let blockIndex = textStarted ? 1 : 0;
    for (const call of calls) {
      const toolId = toAnthropicToolId(call.id);
      const inputJson = JSON.stringify(call.args ?? {});
      sse(res, 'content_block_start', {
        type: 'content_block_start',
        index: blockIndex,
        content_block: { type: 'tool_use', id: toolId, name: call.tool, input: {} },
      });
      sse(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'input_json_delta', partial_json: inputJson },
      });
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
      blockIndex += 1;
    }

    sse(res, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: calls.length > 0 ? 'tool_use' : 'end_turn', stop_sequence: null },
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
