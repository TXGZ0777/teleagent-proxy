// Anthropic Messages API 适配层：/v1/messages（Claude Code / cc-switch 走这里）
//
// 工具中继（与 /v1/responses 同一套桥）：
//   Anthropic 的 tools → MCP 工具 → 模型调用 → 挂起 → 翻成 tool_use 块交回客户端
//   → 下一轮请求带 tool_result → 放行挂起的 MCP 调用 → kernel 接着生成
//
// id 约定：桥的调用 id 形如 call_<hex>，对外翻成 toolu_<hex>（Anthropic 习惯前缀），
// 客户端回传 tool_use_id 时再翻回去，两边一一对应。
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

/** tool_result 块的 content（string | blocks 数组）→ 纯文本 */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (typeof b?.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** assistant 块里的 tool_use 不进文本回放（内核自己记得它发过什么） */
function assistantText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}

const tooluOf = (callId) => String(callId ?? '').replace(/^call_/, 'toolu_');
const callIdOf = (tooluId) => String(tooluId ?? '').replace(/^toolu_/, 'call_');

/**
 * Anthropic 请求体 → OpenAI 风格 messages（system 提到最前面）。
 * user 消息里的 tool_result 块拆成 role:'tool' 消息（带 tool_call_id），
 * 这样 runTurn 恢复轮能把结果放行给挂起的 MCP 调用，纯文本轮也能折叠回放。
 */
export function toChatMessages(body) {
  const out = [];
  const system = typeof body.system === 'string' ? body.system : blocksToText(body.system);
  if (system) out.push({ role: 'system', content: system });
  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    if (!msg?.role) continue;
    if (msg.role === 'assistant') {
      out.push({ role: 'assistant', content: assistantText(msg.content) });
      continue;
    }
    // user 消息：tool_result 块拆出去，text 块留作用户正文
    const blocks = Array.isArray(msg.content)
      ? msg.content
      : [{ type: 'text', text: typeof msg.content === 'string' ? msg.content : '' }];
    const texts = [];
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_result') {
        out.push({
          role: 'tool',
          ...(typeof b.tool_use_id === 'string' && b.tool_use_id ? { tool_call_id: callIdOf(b.tool_use_id) } : {}),
          content: resultText(b.content),
        });
      } else if (typeof b.text === 'string' && b.text) {
        texts.push(b.text);
      }
    }
    if (texts.length) out.push({ role: 'user', content: texts.join('\n') });
  }
  return out;
}

/** Anthropic 的 tools → 桥工具定义（input_schema 即 JSON Schema 参数表） */
export function collectAnthropicTools(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  const seen = new Set();
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    const name = typeof t.name === 'string' ? t.name : null;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      kind: 'function',
      description: typeof t.description === 'string' ? t.description : '',
      parameters:
        t.input_schema && typeof t.input_schema === 'object'
          ? t.input_schema
          : { type: 'object', properties: {} },
    });
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
 * @param {object} args.body Anthropic 请求体
 * @param {object[]} args.models 模型清单
 * @param {(args:{body:object,messages:object[],modelID:string,signal:AbortSignal,tools?:object[],onDelta?:Function})=>Promise<{text:string,reasoning?:string,tokens?:object,error?:object,toolCalls?:object[]}>} args.runTurn
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
  const toolChoice = body.tool_choice;
  const toolDefs = toolChoice === 'none' || toolChoice?.type === 'none' ? [] : collectAnthropicTools(body.tools);
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
      const result = await runTurn({ body, messages, modelID, signal: controller.signal, tools: toolDefs });
      if (result.error) {
        const detail = result.error?.data?.responseBody ?? result.error?.data?.message ?? '上游错误';
        return fail(result.error?.data?.statusCode ?? 502, String(detail).slice(0, 400), 'upstream_error');
      }
      const calls = result.toolCalls ?? [];
      const content = [];
      if (result.text) content.push({ type: 'text', text: result.text });
      for (const c of calls) {
        content.push({ type: 'tool_use', id: tooluOf(c.id), name: c.tool, input: c.args ?? {} });
      }
      return jsonOut(res, 200, {
        id,
        type: 'message',
        role: 'assistant',
        model: modelEcho,
        content: content.length ? content : [{ type: 'text', text: '' }],
        stop_reason: calls.length ? 'tool_use' : 'end_turn',
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

    // 文本块懒启动：纯工具轮（模型只发 tool_use）就不发空文本块
    let blockIndex = -1;
    let textOpen = false;
    const openText = () => {
      if (textOpen) return;
      textOpen = true;
      blockIndex += 1;
      sse(res, 'content_block_start', {
        type: 'content_block_start',
        index: blockIndex,
        content_block: { type: 'text', text: '' },
      });
    };
    const closeText = () => {
      if (!textOpen) return;
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
      textOpen = false;
    };

    const result = await runTurn({
      body,
      messages,
      modelID,
      signal: controller.signal,
      tools: toolDefs,
      onDelta: (delta) => {
        openText();
        sse(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'text_delta', text: delta },
        });
      },
    });

    if (result.error) {
      const detail = result.error?.data?.responseBody ?? result.error?.data?.message ?? '上游错误';
      closeText();
      sse(res, 'error', { type: 'error', error: { type: 'upstream_error', message: String(detail).slice(0, 400) } });
      return;
    }

    closeText();
    const calls = result.toolCalls ?? [];
    for (const c of calls) {
      blockIndex += 1;
      sse(res, 'content_block_start', {
        type: 'content_block_start',
        index: blockIndex,
        content_block: { type: 'tool_use', id: tooluOf(c.id), name: c.tool, input: {} },
      });
      // 整段 JSON 一次下发（客户端按 index 累积 partial_json 再解析）
      sse(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.args ?? {}) },
      });
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
    }

    sse(res, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn', stop_sequence: null },
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
