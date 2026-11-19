// 本地 OpenAI 兼容端点：把 /v1/chat/completions 转成 kernel 的 session/prompt
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { consumeEvents, usageOf, newCompletionId, normalizeFailure } from './events.mjs';
import { fitEntries, trimMiddle } from './text.mjs';
import { writeArchive, makeArchivePath, recentExcerpt, archivePointer } from './archive.mjs';
import { warn } from './log.mjs';
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

/** 会话指纹：显式 id 优先（含 Anthropic 的 metadata.user_id），否则用首条用户消息前 400 字 */
export function conversationKey(body, messages) {
  const explicit =
    body?.user ?? body?.conversation_id ?? body?.session_id ?? body?.metadata?.user_id;
  if (typeof explicit === 'string' && explicit) return explicit;
  const firstUser = messages.find((m) => m.role === 'user');
  const hash = crypto.createHash('sha1').update(contentToText(firstUser?.content ?? '').slice(0, 400)).digest('hex');
  return `auto-${hash.slice(0, 16)}`;
}

/**
 * OpenAI Chat 的 tools → 桥工具定义（与 Responses 的 collectTools 同一形状）。
 * 只收 type=function（其它内置类型跳过），anthropic.mjs 自己有 Anthropic 形状的收集器。
 */
export function collectChatTools(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  const seen = new Set();
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    if (t.type && t.type !== 'function') continue; // web_search 等内置类型跳过
    const fn = t.function ?? t;
    const name = typeof fn?.name === 'string' ? fn.name : null;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      kind: 'function',
      description: typeof fn.description === 'string' ? fn.description : '',
      parameters:
        fn.parameters && typeof fn.parameters === 'object'
          ? fn.parameters
          : { type: 'object', properties: {} },
    });
  }
  return out;
}

/** 历史里 role:'tool' 消息 → { call_id: text }（恢复轮用它放行挂起的 MCP 调用） */
export function collectChatToolOutputs(messages) {
  const outputs = {};
  if (!Array.isArray(messages)) return outputs;
  for (const m of messages) {
    if (m?.role === 'tool' && typeof m.tool_call_id === 'string' && m.tool_call_id) {
      outputs[m.tool_call_id] = contentToText(m.content);
    }
  }
  return outputs;
}

/**
 * 内核提示词的工具开关表。
 * keepMcp=true  → 关掉内核内置工具、保留桥过去的 MCP 工具（工具中继轮）；
 * keepMcp=false → 全部关掉（无工具轮，防止模型自作主张调用别的会话挂上来的工具）。
 */
async function kernelToolFlags(kernel, bridge, { keepMcp = false } = {}) {
  const ids = await bridge.listRegistered(kernel);
  const flags = {};
  for (const id of ids) {
    if (keepMcp && id.startsWith('ta_')) continue; // MCP 工具保持默认开启
    flags[id] = false;
  }
  return flags;
}

/**
 * 本轮发什么文本：首轮折叠全部对话，后续只发新增的 user/tool 消息。
 * （kernel 自己保存会话历史，助手消息无需回放）
 *
 * 注意：system 消息**不**拼进用户文本。它已经作为 agent prompt 进了内核的 system 消息，
 * 再复述一遍等于给模型两份互相竞争的指令，只会让身份/风格更混乱。
 */
export function planTurn(
  record,
  messages,
  {
    maxChars = Number(process.env.TA_MAX_FOLD_CHARS ?? 40000),
    archive = null, // { dir, key }：提供时首轮改为「完整历史落盘 + 只发最近摘要 + 检索指针」
    recentChars = Number(process.env.TA_RECENT_CHARS ?? 10000),
  } = {},
) {
  const users = messages.filter((m) => m.role === 'user');
  const tools = messages.filter((m) => m.role === 'tool');

  if (!record) {
    // 存档模式：完整历史写文件，只把最近若干条 + 检索指针发给模型。
    // 用于长对话——全量折叠会把 chat-pro 拖进 240s 静默超时（2026-11-17 实测）。
    if (archive?.dir) {
      const file = makeArchivePath(archive.dir, archive.key);
      const saved = writeArchive(file, messages);
      // 只有当历史确实不小才启用摘要模式；小对话仍走原来的全量折叠，避免无谓复杂化
      const threshold = Number(process.env.TA_ARCHIVE_MIN_CHARS ?? 12000);
      if (saved.chars > threshold) {
        const { text: recent, kept } = recentExcerpt(messages, recentChars);
        const text = `${archivePointer({ file, totalRounds: saved.rounds, kept })}\n${recent}`;
        return {
          text,
          seenUserCount: users.length,
          seenToolCount: tools.length,
          trimmed: 0,
          foldedChars: text.length,
          archived: { file, chars: saved.chars, rounds: saved.rounds, kept },
        };
      }
    }
    // 原逻辑：折叠全部对话，超限先丢旧工具结果、再截尾。
    const entries = [];
    for (const m of messages) {
      if (m.role === 'user') entries.push({ kind: 'user', text: `用户：${contentToText(m.content)}` });
      else if (m.role === 'assistant') {
        const text = contentToText(m.content);
        if (text) entries.push({ kind: 'assistant', text: `助手：${text}` });
      } else if (m.role === 'tool') {
        const text = contentToText(m.content);
        if (text) entries.push({ kind: 'tool', text: `【工具结果】\n${text}` });
      }
    }
    const sizeOf = () => entries.reduce((n, e) => (e ? n + e.text.length + 1 : n), 0);
    let trimmed = 0;
    if (maxChars > 0) {
      for (let i = 0; i < entries.length && sizeOf() > maxChars; i += 1) {
        if (!entries[i] || entries[i].kind !== 'tool') continue;
        entries[i] = null;
        trimmed += 1;
      }
    }
    let text = entries.filter(Boolean).map((e) => e.text).join('\n');
    if (maxChars > 0 && text.length > maxChars) {
      // 工具结果都丢掉还超限：只保留最近的一段
      text = `（较早内容已省略）\n${text.slice(text.length - maxChars)}`;
    } else if (trimmed > 0) {
      text = `（较早的 ${trimmed} 条工具结果已省略，以控制上下文长度）\n${text}`;
    }
    return { text, seenUserCount: users.length, seenToolCount: tools.length, trimmed, foldedChars: text.length };
  }

  // 增量轮同样要控体积：大工具结果（读大文件、长命令输出）或上一轮失败后重试积压的
  // 一批消息，会把本轮 prompt 撑得过大，触发与首轮折叠完全相同的「输入大→长时间
  // 静默思考→空闲超时」——这就是「运行一段时间后必超时、要反复发『请继续』」的机制。
  const perToolChars = Number(process.env.TA_MAX_TOOL_CHARS ?? 12000);
  let shortened = 0;
  const freshUserMsgs = users.slice(record.seenUserCount ?? 0);
  const freshToolMsgs = tools.slice(record.seenToolCount ?? 0);
  const entries = [];
  for (const m of freshUserMsgs) {
    const text = contentToText(m.content);
    if (text) entries.push({ kind: 'user', text });
  }
  for (const m of freshToolMsgs) {
    const text = contentToText(m.content);
    if (!text) continue;
    if (perToolChars > 0 && text.length > perToolChars) {
      shortened += 1;
      entries.push({ kind: 'tool', text: `【工具结果】\n${trimMiddle(text, perToolChars)}` });
    } else {
      entries.push({ kind: 'tool', text: `【工具结果】\n${text}` });
    }
  }
  const { text: fittedText, dropped, tailTrimmed } = fitEntries(entries, maxChars);
  let text = fittedText;
  if (!tailTrimmed && dropped === 0 && shortened > 0) {
    text = `（${shortened} 条超长工具结果已截取首尾，如需完整内容请重新读取）\n${text}`;
  }
  if (!text && freshUserMsgs.length === 0 && freshToolMsgs.length === 0) {
    text = contentToText(users.at(-1)?.content ?? '');
  }
  return { text, seenUserCount: users.length, seenToolCount: tools.length, inc: { dropped, shortened, batchChars: text.length } };
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
  runtimeConfig = null,
  points = null,
  port = 0,
  host = '127.0.0.1',
  logger = console,
  archiveDir = null, // 长对话历史存档目录；为 null 时不启用存档模式
}) {
  // 兼容两种传法：固定 kernel（测试用）或按请求取 kernel（生产用，跟随客户端提示词）
  const resolveKernel = typeof getKernel === 'function' ? getKernel : async () => initialKernel;
  const sessions = new Map();
  const TTL = 6 * 60 * 60 * 1000;
  // 连续卡死熔断：同一对话在窗口内连续被上游静默卡死，就快速返回 400，
  // 避免客户端按「5 次重试 × 每次 5 分钟」把时间耗光，并把「该换新对话」说清楚。
  const stallStreak = new Map(); // conversationKey -> { count, at, code }
  const STALL_WINDOW_MS = 10 * 60 * 1000;
  const STALL_LIMIT = 2;
  const stallOf = (key) => {
    const s = stallStreak.get(key);
    if (!s) return null;
    if (Date.now() - s.at > STALL_WINDOW_MS) {
      stallStreak.delete(key);
      return null;
    }
    // 窗口内累计不足 STALL_LIMIT 次不算熔断：
    // 单次失败（尤其可能是客户端主动中断）不该把整个对话封掉 10 分钟
    return s.count >= STALL_LIMIT ? s : null;
  };
  const stallMessage = (s, count) =>
    `该对话最近 ${count} 次生成被上游中断（${s ?? 'UPSTREAM_IDLE'}），继续重试大概率无效。` +
    '建议：新建对话、压缩上下文，或切换到其他模型后再试。';
  const startedAt = Date.now();
  // Docker/NAS 部署可设 TA_REQUIRE_AUTH=1：鉴权强制开启，优先于密钥表与管理台的 requireAuth 设置
  const authForced = process.env.TA_REQUIRE_AUTH === '1';

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
    authRequired: authForced || (keystore ? keystore.required(apiKey) : Boolean(apiKey)),
    authForced,
    hasEnvKey: Boolean(apiKey),
    keysFile: keystore?.file ?? null,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    ...(typeof gatewayInfo === 'function' ? gatewayInfo() : {}),
  });

  const admin = keystore ? createAdmin({ keystore, info: gatewayState, adminToken, runtimeConfig, points }) : null;

  /** 多密钥校验：环境变量主密钥 → 密钥表 → 匿名（未开启鉴权时） */
  function authenticate(req) {
    const authHeader = req.headers.authorization ?? '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const given = bearer || String(req.headers['x-api-key'] ?? '').trim();
    if (apiKey && given === apiKey) return { ok: true, record: null, envKey: true };
    const verdict = keystore && given ? keystore.verify(given) : { ok: false, reason: given ? 'unknown' : 'missing' };
    if (verdict.ok) return { ok: true, record: verdict.record };
    const required = authForced || (keystore ? keystore.required(apiKey) : Boolean(apiKey));
    if (!required) return { ok: true, record: null };
    return { ok: false, reason: verdict.reason ?? 'unknown' };
  }

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of sessions) if (now - v.usedAt > TTL) sessions.delete(k);
    for (const [k, v] of stallStreak) if (now - v.at > STALL_WINDOW_MS) stallStreak.delete(k);
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

  async function promptAsync(kernel, sessionID, modelID, text, tools = null) {
    const body = { model: { providerID: 'NewApi', modelID }, parts: [{ type: 'text', text }] };
    // tools 是内核提示词的工具开关表：中继轮关内置工具、留 MCP 桥；无工具轮全部关掉
    if (tools && typeof tools === 'object' && Object.keys(tools).length > 0) body.tools = tools;
    const res = await kernel.call('POST', `/session/${sessionID}/prompt_async`, body);
    if (res.status >= 400) {
      const detail = res.json?.data?.message ?? res.json?.message ?? String(res.text).slice(0, 200);
      const err = new Error(`prompt_async 失败：${res.status} ${detail}`);
      err.status = res.status;
      err.upstream = res.json;
      throw err;
    }
  }

  /**
   * 执行一轮（底层单次尝试）。三协议共用。tools 非空即启用工具中继。
   * 自动重试与预防性重建在外层 runTurn 里处理。
   */
  async function runTurnOnce({ kernel, body, messages, modelID, signal, onDelta, onReasoningDelta, tools = [], idleMs = null }) {
    const key = conversationKey(body, messages);
    const stalled = stallOf(key);
    if (stalled) {
      const err = new Error(stallMessage(stalled.code, stalled.count));
      err.status = 400;
      err.code = 'CONVERSATION_STALLED';
      throw err;
    }
    let rec = getRecord(key);
    if (rec?.origin && rec.origin !== kernel.origin) {
      // 记录指向别的内核实例（system prompt 不同 → 不同内核）：旧 sessionID 在当前内核上无效，
      // 直接复用会拿别的内核的会话去 prompt（撞 'session not found' / busy），还可能误删别的对话的记录
      try {
        bridge?.cancel('内核实例已更换', rec.sessionID);
      } catch {}
      sessions.delete(key);
      rec = undefined;
    }
    const relay = Array.isArray(tools) && tools.length > 0 && Boolean(bridge);
    const outputs = collectChatToolOutputs(messages);
    const resuming = Boolean(rec?.awaiting && Object.keys(outputs).length > 0);

    if (rec?.awaiting && !resuming) {
      // 上一轮挂了工具但结果没回来（客户端中断/超时）：放掉挂起调用，重开会话
      try {
        bridge?.cancel('上一轮工具结果未送达', rec.sessionID);
      } catch {}
      try {
        await kernel.call('POST', `/session/${rec.sessionID}/abort`, {});
      } catch {}
      sessions.delete(key);
      rec = undefined;
    }

    const plan = planTurn(rec, messages, archiveDir ? { archive: { dir: archiveDir, key } } : {});
    if (plan.archived) {
      warn(
        `长对话已存档并摘要：${plan.archived.rounds} 轮 / ${plan.archived.chars} 字符 → 文件 ${plan.archived.file}，` +
        `本轮只发最近 ${plan.archived.kept} 条（${plan.foldedChars} 字符）`,
      );
    }
    if (plan.trimmed) {
      warn(`首轮折叠文本裁剪：省略 ${plan.trimmed} 条工具结果，剩余 ${plan.foldedChars} 字符`);
    }
    if (plan.inc && (plan.inc.dropped > 0 || plan.inc.shortened > 0)) {
      warn(`增量轮裁剪：省略 ${plan.inc.dropped} 条、截取 ${plan.inc.shortened} 条工具结果，本轮 ${plan.inc.batchChars} 字符`);
    }
    const users = messages.filter((m) => m.role === 'user');
    const toolMsgs = messages.filter((m) => m.role === 'tool');
    let sessionID = resuming ? rec.sessionID : rec?.sessionID;
    let flags = null;

    if (bridge && !resuming) {
      if (relay) {
        const changed = bridge.setTools(tools);
        try {
          const needMount = changed || !bridge.mountedFor(kernel);
          await bridge.mount({ force: needMount, kernel });
          await bridge.waitForRegistration({ expected: tools.length, timeoutMs: 4000, kernel });
          flags = await kernelToolFlags(kernel, bridge, { keepMcp: true });
        } catch (err) {
          // 内核进程都没了还「降级为纯对话」只会把 fetch failed 拖成一串误导性日志；
          // 直接抛出，让上层快速失败、内核池剔除重建。
          if (typeof kernel.isAlive === 'function' && !kernel.isAlive()) throw err;
          warn('工具桥挂载失败，本轮降级为纯对话：', err.message);
          flags = null;
        }
      } else if (typeof bridge.hasMount === 'function' && bridge.hasMount(kernel)) {
        // 本轮不带工具，但这个内核上挂过（可能是别的会话的）MCP 工具：
        // 本轮提示词里全部关掉，防止模型自作主张去调挂起的工具
        try {
          flags = await kernelToolFlags(kernel, bridge, { keepMcp: false });
        } catch {
          flags = null;
        }
      }
    }

    if (!resuming && !sessionID) sessionID = await newSession(kernel, key);
    else if (!resuming) {
      // 复用旧会话前先兜底 abort 一次（对空闲会话是无害空操作）：
      // 事件流断线等场景会让内核会话卡在 busy 而记录仍在（consumeEvents 按流关闭「正常」返回），
      // 直接 prompt_async 会永远撞 'session is busy'；先把它退回 idle 再复用
      try {
        await kernel.call('POST', `/session/${sessionID}/abort`, {}, { timeoutMs: 10000 });
      } catch {}
    }
    if (bridge && sessionID) bridge.registerSession(sessionID);

    // 工具中继轮/恢复轮才会被 callWatcher 打断（纯对话轮不监听，避免偷到别的会话的调用）
    const watch = () => (bridge && (relay || resuming) ? bridge.hasCalls(sessionID) : false);
    const runOnce = (opts) =>
      consumeEvents({ kernel, sessionID, signal, onDelta, onReasoningDelta, callWatcher: watch, ...(idleMs != null ? { idleMs } : {}), ...opts });

    let result;
    let calls = [];
    let sentUsers = !resuming; // 非恢复轮的 plan.text 已把新增 user 文本发给内核
    try {
      if (resuming) {
        // 放行挂起的 MCP 调用，接着读同一条事件流（内核会继续生成）
        bridge.resolve(sessionID, outputs);
        result = await runOnce({});
        calls = bridge.takeCalls(sessionID);
        if (!calls.length) {
          // 客户端把“工具结果 + 新的用户消息”合并进同一轮：补发用户新消息
          const freshUsers = users
            .slice(rec?.seenUserCount ?? 0)
            .map((m) => contentToText(m.content))
            .filter(Boolean);
          if (freshUsers.length) {
            const text = freshUsers.join('\n');
            result = await runOnce({ sentText: text, onReady: () => promptAsync(kernel, sessionID, modelID, text, flags) });
            calls = bridge.takeCalls(sessionID);
            sentUsers = true;
          }
        }
      } else {
        const sent = plan.text;
        result = await runOnce({ sentText: sent, onReady: () => promptAsync(kernel, sessionID, modelID, sent, flags) });
        calls = relay ? bridge.takeCalls(sessionID) : [];
      }
      // 事件流可能「正常返回」但客户端其实已断开（race 窗口 / 工具调用拦截后中断）：
      // 此时也必须走清理路径，否则内核会话停在 busy，下一条消息撞 'session is busy'
      if (signal?.aborted) {
        const aborted = new Error('client aborted mid-turn');
        aborted.code = 'CLIENT_ABORTED';
        throw aborted;
      }
    } catch (err) {
      // 客户端主动中断（stop / 重发）不是上游卡死，不进熔断；
      // undici 在中断时也可能抛 'terminated'/'fetch failed'，光看 message 会误判
      const clientAborted =
        signal?.aborted === true || err?.name === 'AbortError' || /abort/i.test(err?.message ?? '');
      // 只有上游静默/传输失败才计入熔断；业务错误（4xx）与客户端中断不计数
      const stallish =
        !clientAborted &&
        (err?.code === 'UPSTREAM_IDLE' || /fetch failed|terminated/i.test(err?.message ?? ''));
      if (stallish) {
        const prev = stallStreak.get(key);
        stallStreak.set(key, { count: (prev?.count ?? 0) + 1, at: Date.now(), code: err.code ?? 'UPSTREAM_ERROR' });
      }
      // 本轮失败：放掉挂起调用并 abort 内核会话，避免会话永远 busy
      try {
        bridge?.cancel(err.message, sessionID);
      } catch {}
      try {
        await kernel.call('POST', `/session/${sessionID}/abort`, {});
      } catch {}
      sessions.delete(key);
      throw err;
    }

    const cacheRead = Number(result?.tokens?.cache?.read ?? 0);
    const recycleAt = Number(process.env.TA_RECYCLE_CACHE_CHARS ?? 200000);
    // 会话膨胀兜底：cacheRead 超阈值时主动放弃这个已经很胖的会话。
    // 注意（2026-11-17 全量日志复核）：卡死是上游偶发静默断流，与 cacheRead 无确定阈值关系，
    //   观测到 2.9 万～37 万都卡过、30 万+ 也大量成功完成。故阈值只作"防止无限膨胀"兜底
    //   （且重建会让缓存归零、更慢），对抗卡死真正有效的是下面的 UPSTREAM_IDLE 自动续接。
    if (recycleAt > 0 && cacheRead > recycleAt) {
      warn(
        `会话历史达 ${cacheRead} 缓存 token（兜底阈值 ${recycleAt}），本轮结束后重建会话，` +
        `下一条请求将以存档摘要重新开始`,
      );
      try {
        bridge?.cancel('会话历史超限，主动回收', sessionID);
      } catch {}
      // 不 abort：本轮已成功，会话是 idle 的；直接删映射即可，旧会话让内核自己淘汰。
      sessions.delete(key);
    } else {
      sessions.set(key, {
        sessionID,
        origin: kernel.origin,
        // 恢复轮若又发起了下一批工具调用，还没发出去的用户文本要留到下一轮（seenUserCount 不动）
        seenUserCount: sentUsers ? users.length : (rec?.seenUserCount ?? 0),
        seenToolCount: toolMsgs.length,
        awaiting: calls.length > 0,
        usedAt: Date.now(),
      });
    }
    stallStreak.delete(key); // 本轮成功，清空该对话的卡死计数
    return { ...result, toolCalls: calls, recycled: cacheRead > recycleAt && recycleAt > 0 };
  }

  /**
   * 外层：UPSTREAM_IDLE 自动重建续接（等价 WorkBuddy 的"重试"按钮，DSH 里无需手打"继续"）。
   *
   * 只在「首轮就静默、且客户端还没收到任何正文」时重试——这样重试不会造成重复输出。
   * 重试前删除会话映射，下一次执行天然走首轮存档摘要（干净上下文）。
   * 自动重试用的空闲看门狗更短，避免 240s + 240s = 480s 超过客户端 300s 超时。
   */
  async function runTurn(args) {
    const retryEnabled = Number(process.env.TA_AUTO_RETRY ?? 1) !== 0;
    if (!retryEnabled) return runTurnOnce(args);
    let emitted = 0;
    const spyDelta = (d) => {
      if (typeof d === 'string' && d.length) emitted += d.length;
      args.onDelta?.(d);
    };
    const retryIdleMs = Number(process.env.TA_RETRY_IDLE_MS ?? 120000);
    try {
      return await runTurnOnce({ ...args, onDelta: args.onDelta ? spyDelta : args.onDelta });
    } catch (err) {
      const canRetry =
        err?.code === 'UPSTREAM_IDLE' &&
        !args.signal?.aborted &&
        emitted === 0 && // 一个字都没吐到客户端，重试不会重复
        !args.onReasoningDelta; // 纯文本/responses 路径；工具中继轮交给客户端处理，不在这里重试
      if (!canRetry) throw err;
      const key = conversationKey(args.body, args.messages);
      warn(`上游静默且未输出任何正文，自动重建会话后续接一次（空闲看门狗 ${retryIdleMs / 1000}s）`);
      // runTurnOnce 失败时已 abort 旧会话并删了映射；这里只需再清一次卡死计数，
      // 下一次执行天然走首轮存档摘要重建（干净上下文）。
      stallStreak.delete(key);
      sessions.delete(key);
      return runTurnOnce({ ...args, idleMs: retryIdleMs, onDelta: args.onDelta });
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

      if (req.method === 'GET' && (urlPath === '/v1/models' || urlPath === '/models')) {
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
          authRequired: authForced || (keystore ? keystore.required(apiKey) : Boolean(apiKey)),
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
        const hint = authForced && !apiKey && keystore && keystore.stats().activeKeys === 0
          ? '（TA_REQUIRE_AUTH=1 强制鉴权且密钥表为空：先在管理台 /admin 新建 API 密钥，或在 .env 设置 TA_API_KEY）'
          : '';
        return json(res, 401, { error: { message: hint ? `${message} ${hint}` : message, type: 'invalid_request_error', code } });
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

      // 可选尾注：请求结束后最多等 3s 查官方按次用量记录，把本次积分消耗附在回复末尾。
      // 仅最终答复注入（工具调用轮不加），开关来自运行时配置（默认关）。
      const footnoteFor = async ({ toolsUsed = false } = {}) => {
        if (toolsUsed || !points?.findUsageAfter || !runtimeConfig?.get('usageFootnote')) return '';
        const waitMs = Math.max(0, Math.min(15000, Number(runtimeConfig?.get('footnoteWaitMs') ?? 3000)));
        const deadline = Date.now() + waitMs;
        try {
          while (Date.now() < deadline) {
            const rec = await points.findUsageAfter(reqStartedAt);
            if (rec) {
              const n = Number(rec.totalUsage);
              return Number.isFinite(n) ? `\n\n（本次消耗 ${n} 积分）` : '';
            }
            if (Date.now() >= deadline) break;
            await new Promise((ok) => setTimeout(ok, 400));
          }
        } catch {}
        return '';
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
      // 连续卡死熔断（开流之前拦下）：返回可读的 400，而不是再等一轮 5 分钟超时
      const preStall = stallOf(conversationKey(body, messages));
      if (preStall) {
        return json(res, 400, {
          error: {
            message: stallMessage(preStall.code, preStall.count),
            type: 'invalid_request_error',
            code: 'CONVERSATION_STALLED',
          },
        });
      }
      const kernel = await resolveKernel({ key: ['chat', hashOf(systemPrompt)].join(':'), prompt: systemPrompt });
      const toolDefs = body.tool_choice === 'none' ? [] : collectChatTools(body.tools);
      const wantStream = body.stream === true;
      usageModel = body.model;
      res.__stream = wantStream;
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });

      const openaiToolCall = (c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.tool, arguments: JSON.stringify(c.args ?? {}) },
      });

      if (!wantStream) {
        try {
          const result = await runTurn({ kernel, body, messages, modelID: body.model, signal: controller.signal, tools: toolDefs });
          addTokens(result.tokens);
          if (result.error) {
            const failure = normalizeFailure(result.error);
            return json(res, failure.status ?? 502, { error: { message: failure.message, type: 'upstream_error', code: failure.code ?? 'upstream_error' } });
          }
          const calls = result.toolCalls ?? [];
          const note = await footnoteFor({ toolsUsed: calls.length > 0 });
          const message = {
            role: 'assistant',
            content: calls.length && !result.text ? null : ((result.text ?? '') + note),
            ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
          };
          if (calls.length) message.tool_calls = calls.map(openaiToolCall);
          return json(res, 200, {
            id: newCompletionId(),
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [
              {
                index: 0,
                message,
                finish_reason: calls.length ? 'tool_calls' : 'stop',
              },
            ],
            usage: usageOf(result.tokens),
          });
        } catch (err) {
          const status = err.status ?? 502;
          return json(res, status, {
            error: { message: err.message, type: 'upstream_error', code: err.code ?? 'upstream_error' },
          });
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
          tools: toolDefs,
          onDelta: (d) => send({ content: d }),
          onReasoningDelta: (d) => send({ reasoning_content: d }),
        });
        addTokens(result.tokens);
        if (result.error) {
          const failure = normalizeFailure(result.error);
          res.write(`data: ${JSON.stringify({ error: { message: failure.message, code: failure.code ?? 'upstream_error' } })}\n\n`);
        } else {
          const calls = result.toolCalls ?? [];
          // 工具调用按 index 分块下发（客户端按 index 累积 arguments）
          calls.forEach((c, i) => {
            send({ tool_calls: [{ index: i, ...openaiToolCall(c) }] });
          });
          // 可选尾注：仅在无工具调用时追加（工具轮加文本会污染 tool_calls 语义）
          const note = await footnoteFor({ toolsUsed: calls.length > 0 });
          if (note) send({ content: note });
          send({}, calls.length ? 'tool_calls' : 'stop', { usage: usageOf(result.tokens) });
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          res.write(`data: ${JSON.stringify({ error: { message: err.message, code: err.code ?? 'upstream_error' } })}\n\n`);
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



