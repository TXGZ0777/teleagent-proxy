// Responses API 适配层：/v1/responses（Codex CLI ≥ 0.12x）
//
// 支持工具中继：
//   Codex 的 tools → MCP 工具 → kernel 调用 → 挂起 → 翻成 function_call 交回 Codex
//   → 下一轮请求带 function_call_output → 放行挂起的 MCP 调用 → kernel 接着生成
//
// 收尾事件只有 completed / failed，没有 data: [DONE]。
import crypto from 'node:crypto';
import { consumeEvents } from './events.mjs';

const sessions = new Map();
const TTL = 6 * 60 * 60 * 1000;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    if (typeof p.text === 'string') parts.push(p.text);
    else if (p.type === 'input_image') parts.push('【图片】');
    else if (p.type === 'input_file') parts.push('【文件】');
  }
  return parts.join('\n');
}

/** Responses 的 input（string | item[]）→ OpenAI 风格 messages */
export function toChatMessages(body) {
  const out = [];
  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    out.push({ role: 'system', content: body.instructions });
  }
  const input = body.input;
  if (typeof input === 'string') {
    out.push({ role: 'user', content: input });
    return out;
  }
  if (!Array.isArray(input)) return out;

  const developer = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'message' || item.role) {
      const role = item.role === 'developer' ? 'system' : (item.role ?? 'user');
      const text = textOf(item.content);
      if (!text) continue;
      if (role === 'system') developer.push(text);
      else out.push({ role: role === 'assistant' ? 'assistant' : 'user', content: text });
    } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      out.push({ role: 'assistant', content: `【工具调用】${item.name ?? ''} ${item.arguments ?? item.input ?? ''}` });
    } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      out.push({ role: 'user', content: `【工具结果】\n${textOf(item.output)}` });
    }
  }
  if (developer.length > 0) out.unshift({ role: 'system', content: developer.join('\n') });
  return out;
}

/** 从 input 里取本轮的 function_call_output → { call_id: text } */
function collectToolOutputs(input) {
  const outputs = {};
  if (!Array.isArray(input)) return outputs;
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      if (typeof item.call_id === 'string') outputs[item.call_id] = textOf(item.output);
    }
  }
  return outputs;
}

/**
 * Codex 的工具定义（Responses 形状）→ 给 MCP 的 {name, description, parameters, kind}
 *
 * kind:
 *   function —— 普通 JSON 参数工具
 *   custom   —— FREEFORM 工具（典型是 apply_patch）：模型输出一段纯文本，不是 JSON。
 *               对模型侧包装成只有一个字符串参数 input 的工具；回传时再还原成
 *               custom_tool_call，否则 Codex 会当成未知工具。
 */
export function collectTools(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  const seen = new Set();
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    const name = t.name ?? t.function?.name;
    if (typeof name !== 'string' || seen.has(name)) continue;

    if (t.type === 'custom') {
      seen.add(name);
      out.push({
        name,
        kind: 'custom',
        description: `${t.description ?? ''}\n\n（freeform 工具：把完整的文本内容放进 input 字段，不要包成 JSON）`,
        parameters: {
          type: 'object',
          properties: {
            input: { type: 'string', description: 'freeform 输入，原样传给客户端' },
          },
          required: ['input'],
        },
      });
      continue;
    }

    if (t.type && t.type !== 'function') continue; // web_search / file_search 等内置类型跳过
    seen.add(name);
    out.push({
      name,
      kind: 'function',
      description: t.description ?? t.function?.description ?? '',
      parameters: t.parameters ?? t.function?.parameters ?? { type: 'object', properties: {} },
    });
  }
  return out;
}

/** 从 Codex 的 <environment_context> 里取 cwd，避免模型按 kernel 自己的目录写绝对路径 */
export function extractCwd(input) {
  if (!Array.isArray(input)) return null;
  for (const item of input) {
    const text = textOf(item?.content);
    const m = /<cwd>([\s\S]*?)<\/cwd>/.exec(text);
    if (m) return m[1].trim();
  }
  return null;
}

function conversationKey(body, messages) {
  const explicit = body?.prompt_cache_key ?? body?.user ?? body?.conversation_id;
  if (typeof explicit === 'string' && explicit) return explicit;
  const firstUser = messages.find((m) => m.role === 'user');
  const hash = crypto.createHash('sha1').update((firstUser?.content ?? '').slice(0, 400)).digest('hex');
  return `codex-${hash.slice(0, 16)}`;
}

function jsonOut(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const responseId = () => `resp_${crypto.randomBytes(16).toString('hex')}`;

function responseObject({ id, model, output, tokens, status, createdAt, error = null }) {
  return {
    id,
    object: 'response',
    created_at: createdAt,
    status,
    background: false,
    error,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model,
    output,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: 1,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_p: 1,
    truncation: 'disabled',
    usage: {
      input_tokens: tokens?.input ?? 0,
      input_tokens_details: { cached_tokens: tokens?.cache?.read ?? 0 },
      output_tokens: tokens?.output ?? 0,
      output_tokens_details: { reasoning_tokens: tokens?.reasoning ?? 0 },
      total_tokens: tokens?.total ?? (tokens?.input ?? 0) + (tokens?.output ?? 0),
    },
  };
}

function messageItem(text) {
  return {
    id: `msg_${crypto.randomBytes(8).toString('hex')}`,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
}

function functionCallItem(call, kind = 'function') {
  const base = {
    id: `fc_${crypto.randomBytes(8).toString('hex')}`,
    status: 'completed',
    call_id: call.id,
    name: call.tool,
  };
  if (kind === 'custom') {
    return {
      ...base,
      type: 'custom_tool_call',
      input: typeof call.args?.input === 'string' ? call.args.input : JSON.stringify(call.args ?? ''),
    };
  }
  return {
    ...base,
    type: 'function_call',
    arguments: JSON.stringify(call.args ?? {}),
  };
}

/**
 * @param {object} args
 * @param {object} args.kernel   startKernel() 的返回值
 * @param {object} args.bridge   createToolBridge() 的返回值
 */
export async function handleResponses({ req, res, body, models, kernel, bridge, defaultModel }) {
  if (!body || typeof body !== 'object') {
    return jsonOut(res, 400, { error: { type: 'invalid_request_error', message: 'invalid JSON body' } });
  }
  const input = body.input;
  if (typeof input !== 'string' && !Array.isArray(input)) {
    return jsonOut(res, 400, { error: { type: 'invalid_request_error', message: 'input is required' } });
  }

  const messages = toChatMessages(body);
  const key = conversationKey(body, messages);
  const tools = collectTools(body.tools);
  const kinds = new Map(tools.map((t) => [t.name, t.kind ?? 'function']));
  const outputs = collectToolOutputs(body.input);

  const rec = sessions.get(key);
  const fresh = !rec || Date.now() - rec.usedAt > TTL;

  // 模型名：客户端传的可能是别家的名字，映射到本机模型
  const requested = typeof body.model === 'string' && body.model ? body.model : '';
  const known = models.some((m) => m.id === requested);
  const modelID = known ? requested : (defaultModel ?? models[0]?.id);
  const modelEcho = requested || modelID;

  const wantStream = body.stream !== false;
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  const id = responseId();
  const createdAt = Math.floor(Date.now() / 1000);

  // 本轮是"工具结果回灌"还是"正常提问"
  const resuming = Boolean(!fresh && rec.awaiting && Object.keys(outputs).length > 0);
  if (!fresh && rec.awaiting && !resuming) {
    // 上一轮挂了工具但结果没回来（客户端中断/超时）：放掉挂起调用，重开会话
    bridge.cancel('上一轮工具结果未送达');
    try {
      await kernel.call('POST', `/session/${rec.sessionID}/abort`, {});
    } catch {}
    sessions.delete(key);
  }

  // 流式骨架
  let seq = 0;
  const sse = (type, payload) => {
    if (res.writableEnded) return;
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...payload })}\n\n`);
  };

  const startStream = () => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const base = responseObject({ id, model: modelEcho, output: [], tokens: null, status: 'in_progress', createdAt });
    sse('response.created', { response: base });
    sse('response.in_progress', { response: base });
  };

  const finish = (output, tokens, textForStream, streamed) => {
    if (wantStream) {
      if (!streamed && textForStream) {
        // 没走过 delta（例如纯工具调用轮），补一个完整文本块
      }
      sse('response.completed', {
        response: responseObject({ id, model: modelEcho, output, tokens, status: 'completed', createdAt }),
      });
      res.end();
    } else {
      jsonOut(res, 200, responseObject({ id, model: modelEcho, output, tokens, status: 'completed', createdAt }));
    }
  };

  const failRes = (message, tokens) => {
    if (wantStream) {
      sse('response.failed', {
        response: responseObject({ id, model: modelEcho, output: [], tokens, status: 'failed', createdAt, error: { code: 'upstream_error', message } }),
      });
      res.end();
    } else {
      jsonOut(res, 502, { error: { type: 'upstream_error', message } });
    }
  };

  let heartbeat = null;
  try {
    let sessionID = resuming ? rec.sessionID : rec?.sessionID;
    let flags = null;

    if (!resuming) {
      if (tools.length > 0 && bridge) {
        const changed = bridge.setTools(tools);
        try {
          await bridge.mount({ force: changed || !bridge.mountedOnce });
          await bridge.waitForRegistration({ expected: tools.length, timeoutMs: 4000 });
          flags = await bridge.builtinFlags();
        } catch (err) {
          console.warn('[teleagent] 工具桥挂载失败，本轮降级为纯对话：', err.message);
          flags = null;
        }
      }
      if (!sessionID) {
        const created = await kernel.call('POST', '/session', { title: `codex-${key.slice(-8)}` });
        sessionID = created.json?.id;
        if (!sessionID) throw new Error(`建会话失败：${created.status} ${String(created.text).slice(0, 200)}`);
      }
    }

    if (wantStream) {
      startStream();
      heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(': keep-alive\n\n');
      }, 15000);
      heartbeat.unref?.();
    }

    // 文本块（仅当模型输出了正文才发）
    const itemId = `msg_${crypto.randomBytes(8).toString('hex')}`;
    let textStarted = false;
    let streamedText = '';

    const ensureTextBlock = () => {
      if (textStarted || !wantStream) return;
      textStarted = true;
      sse('response.output_item.added', {
        output_index: 0,
        item: { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
      });
      sse('response.content_part.added', {
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
    };

    const t0 = Date.now();
    let tPromptSent = 0;
    let tFirstDelta = 0;

    const onDelta = (delta) => {
      if (!tFirstDelta) tFirstDelta = Date.now();
      if (!wantStream) return;
      ensureTextBlock();
      streamedText += delta;
      sse('response.output_text.delta', { item_id: itemId, output_index: 0, content_index: 0, delta, logprobs: [] });
    };

    const runOnce = (opts) =>
      consumeEvents({
        kernel,
        sessionID,
        signal: controller.signal,
        onDelta,
        callWatcher: () => (bridge ? bridge.hasCalls() : false),
        ...opts,
      });

    let result;
    if (resuming) {
      // 放行挂起的 MCP 调用，然后接着读同一条事件流
      bridge.resolve(outputs);
      result = await runOnce({});
    } else {
      const promptBody = {
        model: { providerID: 'NewApi', modelID },
        parts: [{
          type: 'text',
          text: (() => {
            const cwd = extractCwd(body.input);
            const head = cwd
              ? `【工作目录】${cwd}\n所有文件路径以该目录为准；优先用相对路径，不要用 runtime/ 或其它绝对路径。\n\n`
              : '';
            return head + messages.map((m) => (m.role === 'assistant' ? `助手：${m.content}` : m.content)).join('\n');
          })(),
        }],
      };
      if (flags && Object.keys(flags).length > 0) promptBody.tools = flags;
      result = await runOnce({
        sentText: '',
        onReady: async () => {
          const sent = await kernel.call('POST', `/session/${sessionID}/prompt_async`, promptBody);
          tPromptSent = Date.now();
          if (sent.status >= 400) throw new Error(`prompt_async 失败：${sent.status} ${String(sent.text).slice(0, 200)}`);
        },
      });
    }

    const calls = bridge ? bridge.takeCalls() : [];

    if (result.error) {
      const detail = result.error?.data?.responseBody ?? result.error?.data?.message ?? '上游错误';
      sessions.set(key, { sessionID, awaiting: false, usedAt: Date.now() });
      return failRes(String(detail).slice(0, 400), result.tokens);
    }

    // 分段计时（TA_TIMING=0 可关）
    if (process.env.TA_TIMING !== '0') {
      const now = Date.now();
      console.log(
        `[timing] ${resuming ? 'resume' : 'turn'} model=${modelID} ` +
          `prompt_sent=${tPromptSent ? tPromptSent - t0 : '-'}ms ` +
          `ttft=${tFirstDelta ? tFirstDelta - t0 : '-'}ms ` +
          `total=${now - t0}ms ` +
          `in=${result.tokens?.input ?? 0} out=${result.tokens?.output ?? 0} cached=${result.tokens?.cache?.read ?? 0}`,
      );
    }

    // 收尾：工具调用轮 vs 普通回答
    if (calls.length > 0) {
      if (wantStream) {
        if (textStarted) {
          sse('response.output_text.done', { item_id: itemId, output_index: 0, content_index: 0, text: streamedText, logprobs: [] });
          sse('response.content_part.done', {
            item_id: itemId,
            output_index: 0,
            content_index: 0,
            part: { type: 'output_text', text: streamedText, annotations: [] },
          });
          sse('response.output_item.done', { output_index: 0, item: messageItem(streamedText) });
        }
        let index = textStarted ? 1 : 0;
        for (const call of calls) {
          const kind = kinds.get(call.tool) ?? 'function';
          const item = functionCallItem(call, kind);
          if (kind === 'custom') {
            sse('response.output_item.added', {
              output_index: index,
              item: { ...item, status: 'in_progress', input: '' },
            });
            sse('response.custom_tool_call_input.delta', { item_id: item.id, output_index: index, delta: item.input });
            sse('response.custom_tool_call_input.done', { item_id: item.id, output_index: index, input: item.input });
          } else {
            sse('response.output_item.added', {
              output_index: index,
              item: { ...item, status: 'in_progress', arguments: '' },
            });
            sse('response.function_call_arguments.delta', { item_id: item.id, output_index: index, delta: item.arguments });
            sse('response.function_call_arguments.done', { item_id: item.id, output_index: index, arguments: item.arguments });
          }
          sse('response.output_item.done', { output_index: index, item });
          index += 1;
        }
      }
      const output = [
        ...(textStarted && streamedText ? [messageItem(streamedText)] : []),
        ...calls.map((call) => functionCallItem(call, kinds.get(call.tool) ?? 'function')),
      ];
      sessions.set(key, { sessionID, awaiting: true, usedAt: Date.now() });
      return finish(output, result.tokens, streamedText, true);
    }

    const finalText = result.text ?? streamedText;
    if (wantStream) {
      ensureTextBlock();
      if (streamedText !== finalText) {
        // 非增量场景（极少）：补发完整文本
        const missing = finalText.startsWith(streamedText) ? finalText.slice(streamedText.length) : finalText;
        if (missing) sse('response.output_text.delta', { item_id: itemId, output_index: 0, content_index: 0, delta: missing, logprobs: [] });
        streamedText = finalText;
      }
      sse('response.output_text.done', { item_id: itemId, output_index: 0, content_index: 0, text: finalText, logprobs: [] });
      sse('response.content_part.done', {
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: finalText, annotations: [] },
      });
      sse('response.output_item.done', { output_index: 0, item: messageItem(finalText) });
    }
    sessions.set(key, { sessionID, awaiting: false, usedAt: Date.now() });
    return finish([messageItem(finalText)], result.tokens, finalText, true);
  } catch (err) {
    if (bridge) bridge.cancel(err.message);
    if (!controller.signal.aborted) return failRes(err.message);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
}

export function resetSessions() {
  sessions.clear();
}

export function sweepSessions() {
  const now = Date.now();
  for (const [k, v] of sessions) if (now - v.usedAt > TTL) sessions.delete(k);
}

