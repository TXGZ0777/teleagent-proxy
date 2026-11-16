// 工具中继：客户端工具 ↔ kernel MCP
//
// 链路：
//   Codex 发 tools → 我们注册成 MCP 工具 → 挂到 kernel
//   模型决定调用 → kernel 发起 MCP tools/call → 我们**挂起不返回**
//   → 把调用翻成 Responses 的 function_call 交回 Codex
//   → Codex 执行后，下一次请求带 function_call_output
//   → 我们用它放行挂起的 MCP 调用，kernel 继续生成
//
// 会话隔离：kernel 是单进程、多会话，MCP 服务端是全局挂载的。若把 pending/suspended
// 做成全局数组，两个会话同时处在工具循环时就会互相**偷取**对方的调用（A 的工具在 B 里执行）。
// 因此这里按会话分桶；会话标识从 MCP 请求头 / params 里取，取不到则退化为全局 'default'。
import crypto from 'node:crypto';
import { startMcpServer } from './mcp-server.mjs';

export const SERVER_NAME = 'ta';

export async function createToolBridge({ kernel, serverName = SERVER_NAME, logger = console } = {}) {
  let activeKernel = kernel;
  let currentTools = [];
  const buckets = new Map(); // sid -> { suspended: [], pending: [] }
  const warned = new Set();
  const knownSessions = new Set();

  const bucket = (sid) => {
    const k = sid || 'default';
    let b = buckets.get(k);
    if (!b) {
      b = { suspended: [], pending: [] };
      buckets.set(k, b);
    }
    return b;
  };

  /** 从 MCP 请求上下文里提取会话标识（不同内核可能用不同头/字段） */
  const sessionOf = (ctx) => {
    const h = ctx?.headers || {};
    const p = ctx?.params || {};
    const meta = p._meta || {};
    const sid =
      h['x-opencode-session'] ||
      h['x-session-id'] ||
      h['x-session'] ||
      h['mcp-session-id'] ||
      meta.sessionID ||
      meta.sessionId ||
      (typeof p.sessionID === 'string' ? p.sessionID : '') ||
      '';
    const s = typeof sid === 'string' ? sid.trim() : '';
    if (!s && !warned.has('noheader')) {
      warned.add('noheader');
      try {
        logger.warn?.(
          '[toolbridge] tools/call 未携带会话标识，工具调用将按全局处理（无法隔离会话）。可用请求头：' +
            Object.keys(h).join(', '),
        );
      } catch {}
    }
    return s;
  };

  // 每个内核独立记录挂载状态：多内核共存时不能共享一个 mounted/activeKernel，
  // 否则后挂载的内核会把 activeKernel 指过去，导致前一个内核的工具查询打到错误实例。
  const mountState = new Map(); // kernel.origin -> signature

  const server = await startMcpServer({
    getTools: () => currentTools,
    onCall: async (name, args, ctx) => {
      const tool = stripPrefix(name, serverName);
      const callId = `call_${crypto.randomBytes(8).toString('hex')}`;
      const raw = sessionOf(ctx);
      if (raw && !knownSessions.has(raw) && !warned.has('unknown:' + raw)) {
        warned.add('unknown:' + raw);
        try {
          logger.warn?.('[toolbridge] tools/call 会话标识不在已知会话内，退化为全局处理：' + raw);
        } catch {}
      }
      const b = bucket(knownSessions.has(raw) ? raw : 'default');
      b.pending.push({ id: callId, tool, args, at: Date.now() });
      // 挂起：等客户端把执行结果送回来
      return new Promise((resolve) => {
        b.suspended.push({ id: callId, tool, args, resolve, at: Date.now() });
      });
    },
  });

  function signatureOf(tools) {
    return tools.map((t) => (t?.function ?? t)?.name).filter(Boolean).join(',');
  }

  /** 更新对外暴露的工具集；变化时通知 kernel 重新拉清单 */
  function setTools(tools) {
    const next = Array.isArray(tools) ? tools : [];
    const changed = signatureOf(next) !== signatureOf(currentTools);
    currentTools = next;
    if (changed) server.notifyToolsChanged?.();
    return changed;
  }

  /** 挂到指定 kernel（POST /mcp）；每个内核独立记录挂载签名 */
  async function mount({ force = false, kernel: k = activeKernel } = {}) {
    if (!k) return { ok: false, status: 0, text: 'no kernel' };
    const sig = signatureOf(currentTools);
    const prior = mountState.get(k.origin);
    if (!force && prior === sig) return { ok: true, alreadyMounted: true };
    const res = await k.call('POST', '/mcp', {
      name: serverName,
      config: { type: 'remote', url: server.url, enabled: true },
    });
    if (res.status >= 400) {
      logger.warn?.('MCP 挂载失败', res.status, String(res.text).slice(0, 200));
      return { ok: false, status: res.status, text: res.text };
    }
    mountState.set(k.origin, sig);
    activeKernel = k;
    return { ok: true };
  }

  async function listRegistered(kernel = activeKernel) {
    if (!kernel) return [];
    const res = await kernel.call('GET', '/experimental/tool/ids');
    if (res.status !== 200 || !Array.isArray(res.json)) return [];
    return res.json.filter((id) => typeof id === 'string');
  }

  async function waitForRegistration({ expected = 0, timeoutMs = 4000, kernel = activeKernel } = {}) {
    const started = Date.now();
    let ids = [];
    while (Date.now() - started < timeoutMs) {
      ids = await listRegistered(kernel);
      const ours = ids.filter((id) => id.startsWith(`${serverName}_`));
      if (ours.length >= expected) return { ok: true, ids: ours };
      await new Promise((r) => setTimeout(r, 150));
    }
    return { ok: false, ids: ids.filter((id) => id.startsWith(`${serverName}_`)) };
  }

  /** 内核自带工具的开关表：全部关掉，只留 MCP 桥过去的 */
  async function builtinFlags(kernel = activeKernel) {
    const ids = await listRegistered(kernel);
    const flags = {};
    for (const id of ids) if (!id.startsWith(`${serverName}_`)) flags[id] = false;
    return flags;
  }

  return {
    serverName,
    url: server.url,
    /** 指定内核是否已挂过当前工具集（用于 force 判断） */
    mountedFor(kernel) {
      return Boolean(kernel && mountState.get(kernel.origin) === signatureOf(currentTools));
    },
    /** 指定内核是否挂载过任何工具（无工具轮据此在本轮提示词里关掉 MCP 工具，防误调） */
    hasMount(kernel) {
      return Boolean(kernel && mountState.has(kernel.origin));
    },
    setTools,
    registerSession(sid) {
      if (typeof sid === 'string' && sid) knownSessions.add(sid);
    },
    mount,
    waitForRegistration,
    builtinFlags,
    listRegistered,
    /** 是否有待交给客户端的调用；不给 sid 时判断任意会话 */
    hasCalls(sid) {
      if (!sid) {
        for (const b of buckets.values()) if (b.pending.length > 0) return true;
        return false;
      }
      if (bucket(sid).pending.length > 0) return true;
      // 兼容：内核未给会话标识时，调用会落在 'default'
      return sid !== 'default' && bucket('default').pending.length > 0;
    },
    /** 取走本轮要交给客户端的调用（不影响挂起的 Promise） */
    takeCalls(sid) {
      const sids = sid && sid !== 'default' ? [sid, 'default'] : ['default'];
      const list = [];
      for (const s of sids) {
        const b = bucket(s);
        if (b.pending.length) {
          list.push(...b.pending);
          b.pending = [];
        }
      }
      return list.map(({ id, tool, args }) => ({ id, tool, args }));
    },
    /** 用客户端结果放行：outputs 形如 { callId: text } */
    resolve(sid, outputs) {
      const sids = sid && sid !== 'default' ? [sid, 'default'] : ['default'];
      let resolved = 0;
      for (const s of sids) {
        const b = bucket(s);
        const list = b.suspended;
        b.suspended = [];
        for (const item of list) {
          const text = outputs?.[item.id] ?? outputs?.['*'] ?? '';
          try {
            item.resolve({ text: String(text ?? ''), isError: false });
            resolved++;
          } catch {}
        }
      }
      return resolved;
    },
    /** 放弃挂起（客户端取消/换会话） */
    cancel(reason = 'aborted', sid) {
      const sids = sid ? [sid, 'default'] : [...buckets.keys()];
      let n = 0;
      for (const s of sids) {
        const b = bucket(s);
        const list = b.suspended;
        b.suspended = [];
        const pend = b.pending;
        b.pending = [];
        n += list.length + pend.length;
        for (const item of list) {
          try {
            item.resolve({ text: `工具调用已取消：${reason}`, isError: true });
          } catch {}
        }
      }
      return n;
    },
    close: () => server.close(),
  };
}

export function stripPrefix(name, serverName = SERVER_NAME) {
  const prefix = `${serverName}_`;
  return typeof name === 'string' && name.startsWith(prefix) ? name.slice(prefix.length) : name;
}
