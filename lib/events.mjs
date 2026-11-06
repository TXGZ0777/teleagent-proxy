// kernel /event SSE 消费：把 opencode 事件流翻译成正文/思维链增量
import crypto from 'node:crypto';

/** 打开 kernel 事件流（SSE） */
export async function openEventStream(kernel, { signal } = {}) {
  const ac = new AbortController();
  if (signal) signal.addEventListener('abort', () => ac.abort(), { once: true });
  const { headers } = kernel.sign('GET', '/event');
  const res = await fetch(`${kernel.origin}/event`, { headers, signal: ac.signal });
  if (!res.ok) throw new Error(`kernel /event 失败：${res.status}`);
  return { res, abort: () => { try { ac.abort(); } catch {} } };
}

export function normalizeFailure(payload) {
  const data = payload?.data ?? payload ?? {};
  const raw = typeof data.message === 'string' ? data.message : (payload?.name ?? '');
  let detail;
  if (typeof data.responseBody === 'string') {
    try {
      const parsed = JSON.parse(data.responseBody);
      detail = parsed?.resultMsg ?? parsed?.message;
    } catch {}
  }
  const status = typeof data.statusCode === 'number' ? data.statusCode : undefined;
  const code = data.responseCode ?? data.code;
  const text = [raw, detail].filter(Boolean).join(' ');
  const quota = /insufficient[\s_-]+(?:quota|balance|credits?)|额度不足|余额不足|积分不足|配额不足/i.test(text);
  return {
    message: quota ? `insufficient quota: ${detail ?? raw}` : `上游错误：${detail ?? raw ?? '未知错误'}`,
    status,
    code: typeof code === 'number' ? code : undefined,
    quota,
  };
}

/**
 * 消费一轮事件流。
 * @returns {Promise<{text:string, reasoning:string, tokens?:object, error?:object}>}
 */
export async function consumeEvents({
  kernel,
  sessionID,
  signal,
  onDelta,
  onReasoningDelta,
  onReady,
  callWatcher,
  timeoutMs = 20 * 60 * 1000,
  sentText = '',
}) {
  const stream = await openEventStream(kernel, { signal });
  const reader = stream.res.body.getReader();
  const decoder = new TextDecoder();

  const roles = new Map();
  const texts = new Map();
  const reasoningByPart = new Map();
  const reasoningByMessage = new Map();
  const pending = new Map();
  let currentID = null;
  let full = '';
  let tokens;
  let errorPayload = null;
  let done = false;
  let interrupted = false;
  const deadline = Date.now() + timeoutMs;

  if (onReady) await onReady();

  function applyAssistantPart(part, messageID) {
    if (messageID !== currentID) {
      currentID = messageID;
      full = texts.get(messageID) ?? '';
    }
    if (part.type === 'text' && typeof part.text === 'string') {
      const prev = texts.get(messageID) ?? '';
      if (part.text.length > prev.length) {
        texts.set(messageID, part.text);
        full = part.text;
        onDelta?.(part.text.slice(prev.length), part.text);
      }
      if (part.tokens) tokens = part.tokens;
    } else if (part.type === 'reasoning' && typeof part.text === 'string') {
      const partID = part.id ?? `${messageID}:reasoning`;
      const prev = reasoningByPart.get(partID) ?? '';
      if (part.text.length > prev.length) {
        const delta = part.text.slice(prev.length);
        reasoningByPart.set(partID, part.text);
        reasoningByMessage.set(messageID, (reasoningByMessage.get(messageID) ?? '') + delta);
        onReasoningDelta?.(delta, part.text);
      }
    }
  }

  function onPart(part) {
    if (!part || typeof part !== 'object') return;
    if (typeof part.sessionID === 'string' && part.sessionID !== sessionID) return;
    const messageID = part.messageID;
    if (typeof messageID !== 'string') return;
    const role = roles.get(messageID);
    if (role !== undefined && role !== 'assistant') return;
    if (role === undefined) {
      pending.set(messageID, part);
      return;
    }
    applyAssistantPart(part, messageID);
  }

  let buf = '';
  const WAKE_MS = 150;
  try {
    let pendingRead = reader.read();
    pendingRead.catch(() => {}); // 中止时会 reject，提前吞掉避免未处理拒绝
    while (!done) {
      if (Date.now() > deadline) throw new Error('等待模型响应超时');
      // 工具桥拦到调用：本轮立刻收尾，把调用交给客户端执行
      if (typeof callWatcher === 'function' && callWatcher() === true) {
        interrupted = true;
        break;
      }
      const winner = await Promise.race([
        pendingRead.then((read) => ({ read })),
        new Promise((resolve) => {
          const t = setTimeout(() => resolve({ wake: true }), WAKE_MS);
          t.unref?.();
        }),
      ]);
      if (winner.wake) continue;
      const { value, done: streamDone } = winner.read;
      if (streamDone) break;
      pendingRead = reader.read();
      pendingRead.catch(() => {});
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split('\n\n');
      buf = frames.pop() ?? '';
      for (const frame of frames) {
        if (!frame.startsWith('data: ')) continue;
        let ev;
        try {
          ev = JSON.parse(frame.slice(6));
        } catch {
          continue;
        }
        const props = ev?.properties ?? {};

        if (ev.type === 'message.updated') {
          const info = props.info;
          if (!info?.id || !info.role) continue;
          if (info.sessionID !== sessionID) continue;
          roles.set(info.id, info.role);
          if (info.role !== 'assistant') {
            pending.delete(info.id);
            continue;
          }
          if (currentID === null) currentID = info.id;
          if (info.id === currentID) {
            if (info.tokens) tokens = info.tokens;
            if (info.error) errorPayload = info.error;
          }
          const queued = pending.get(info.id);
          if (queued) {
            pending.delete(info.id);
            applyAssistantPart(queued, info.id);
          }
        }

        if (ev.type === 'message.part.updated') onPart(props.part);

        if (ev.type === 'session.error' && props.sessionID === sessionID) {
          errorPayload = errorPayload ?? props.error;
          done = true;
        }

        if (ev.type === 'session.status' && props.sessionID === sessionID && props.status?.type === 'idle') {
          done = true;
        }
      }
    }
  } finally {
    stream.abort();
    try {
      await reader.cancel();
    } catch {}
  }

  // 兜底：角色未知但正文非空，且不是回显的提示词
  if ((currentID === null || (texts.get(currentID) ?? full) === '') && pending.size > 0) {
    for (const [id, part] of pending) {
      if (part?.type !== 'text' || !part.text) continue;
      if (sentText && sentText.startsWith(part.text)) continue;
      applyAssistantPart(part, id);
    }
  }

  const text = currentID !== null ? (texts.get(currentID) ?? full) : full;
  const reasoning = currentID !== null ? (reasoningByMessage.get(currentID) ?? '') : '';
  return { text, reasoning, tokens, error: errorPayload, interrupted };
}

export function usageOf(tokens) {
  const t = tokens ?? {};
  const input = t.input ?? 0;
  const output = t.output ?? 0;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: t.total ?? input + output,
    prompt_tokens_details: { cached_tokens: t.cache?.read ?? 0 },
  };
}

export function newCompletionId() {
  return `chatcmpl-${crypto.randomUUID()}`;
}
