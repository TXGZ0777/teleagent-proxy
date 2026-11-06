// 工具中继：客户端工具 ↔ kernel MCP
//
// 链路：
//   Codex 发 tools → 我们注册成 MCP 工具 → 挂到 kernel
//   模型决定调用 → kernel 发起 MCP tools/call → 我们**挂起不返回**
//   → 把调用翻成 Responses 的 function_call 交回 Codex
//   → Codex 执行后，下一次请求带 function_call_output
//   → 我们用它放行挂起的 MCP 调用，kernel 继续生成
import crypto from 'node:crypto';
import { startMcpServer } from './mcp-server.mjs';

export const SERVER_NAME = 'ta';

export async function createToolBridge({ kernel, serverName = SERVER_NAME, logger = console } = {}) {
  let activeKernel = kernel;
  let currentTools = [];
  let suspended = [];   // 正在等客户端结果的调用（Promise 只能被 resolve 一次）
  let pending = [];     // 本轮要交给客户端的调用（可被取走，不影响 suspended）
  let mounted = false;
  let mountedSignature = '';

  const server = await startMcpServer({
    getTools: () => currentTools,
    onCall: async (name, args) => {
      const tool = stripPrefix(name, serverName);
      const callId = `call_${crypto.randomBytes(8).toString('hex')}`;
      pending.push({ id: callId, tool, args, at: Date.now() });
      // 挂起：等客户端把执行结果送回来
      return new Promise((resolve) => {
        suspended.push({ id: callId, tool, args, resolve, at: Date.now() });
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

  /** 挂到当前 kernel（POST /mcp）；kernel 换实例后由 attach() 触发重挂 */
  async function mount({ force = false, kernel: k = activeKernel } = {}) {
    const sig = signatureOf(currentTools);
    if (mounted && !force && sig === mountedSignature) return { ok: true, alreadyMounted: true };
    const res = await k.call('POST', '/mcp', {
      name: serverName,
      config: { type: 'remote', url: server.url, enabled: true },
    });
    if (res.status >= 400) {
      logger.warn?.('MCP 挂载失败', res.status, String(res.text).slice(0, 200));
      return { ok: false, status: res.status, text: res.text };
    }
    mounted = true;
    mountedSignature = sig;
    activeKernel = k;
    return { ok: true };
  }

  async function listRegistered() {
    const res = await activeKernel.call('GET', '/experimental/tool/ids');
    if (res.status !== 200 || !Array.isArray(res.json)) return [];
    return res.json.filter((id) => typeof id === 'string');
  }

  async function waitForRegistration({ expected = 0, timeoutMs = 4000 } = {}) {
    const started = Date.now();
    let ids = [];
    while (Date.now() - started < timeoutMs) {
      ids = await listRegistered();
      const ours = ids.filter((id) => id.startsWith(`${serverName}_`));
      if (ours.length >= expected) return { ok: true, ids: ours };
      await new Promise((r) => setTimeout(r, 150));
    }
    return { ok: false, ids: ids.filter((id) => id.startsWith(`${serverName}_`)) };
  }

  /** 内核自带工具的开关表：全部关掉，只留 MCP 桥过去的 */
  async function builtinFlags() {
    const ids = await listRegistered();
    const flags = {};
    for (const id of ids) if (!id.startsWith(`${serverName}_`)) flags[id] = false;
    return flags;
  }

  return {
    /** kernel 换实例后重新挂载（旧连接失效） */
    attach(nextKernel) {
      activeKernel = nextKernel;
      mounted = false;
      mountedSignature = '';
    },
    serverName,
    url: server.url,
    get mountedOnce() {
      return mounted;
    },
    setTools,
    mount,
    waitForRegistration,
    builtinFlags,
    listRegistered,
    hasCalls: () => pending.length > 0,
    /** 取走本轮要交给客户端的调用（不影响挂起的 Promise） */
    takeCalls() {
      const list = pending;
      pending = [];
      return list.map(({ id, tool, args }) => ({ id, tool, args }));
    },
    /** 用客户端结果放行：outputs 形如 { callId: text } */
    resolve(outputs) {
      const list = suspended;
      suspended = [];
      let resolved = 0;
      for (const item of list) {
        const text = outputs[item.id] ?? outputs['*'] ?? '';
        try {
          item.resolve({ text: String(text ?? ''), isError: false });
          resolved++;
        } catch {}
      }
      return resolved;
    },
    /** 放弃挂起（客户端取消/换会话） */
    cancel(reason = 'aborted') {
      const list = suspended;
      suspended = [];
      pending = [];
      for (const item of list) {
        try {
          item.resolve({ text: `工具调用已取消：${reason}`, isError: true });
        } catch {}
      }
      return list.length;
    },
    close: () => server.close(),
  };
}

export function stripPrefix(name, serverName = SERVER_NAME) {
  const prefix = `${serverName}_`;
  return typeof name === 'string' && name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

