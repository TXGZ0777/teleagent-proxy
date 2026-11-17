#!/usr/bin/env node
// TeleAgent → 本地 OpenAI 兼容反代（kernel 模式）
//
// 用法：
//   node server.mjs                    # 监听 127.0.0.1:8787
//   TA_PORT=9000 node server.mjs       # 换端口
//   TA_API_KEY=sk-local node server.mjs # 要求客户端带 Bearer
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveOwner, accountDir, tokenFile, readJson, kernelVersion, ensureTeleAgentLayout } from './lib/paths.mjs';
import { loadAuthState, deviceMeta } from './lib/auth.mjs';
import { startKernel, NEUTRAL_AGENT_PROMPT } from './lib/kernel.mjs';
import { createToolBridge } from './lib/toolbridge.mjs';
import { resetSessions as resetResponsesSessions } from './lib/responses.mjs';
import { createShim } from './lib/shim.mjs';
import { createKeyStore } from './lib/keystore.mjs';
import { createRuntimeConfig } from './lib/runtime-config.mjs';
import { createPoints, startAutoSign } from './lib/points.mjs';
import { log, warn, error, setLogFile } from './lib/log.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// 日志落盘：静默启动没有终端，proxy.log 与管理台日志区是主要排障入口（runtime/ 已 gitignore）。
setLogFile(path.join(here, 'runtime', 'proxy.log'));

const missing = ensureTeleAgentLayout();
if (missing.length > 0) {
  console.error('找不到 TeleAgent 安装/登录信息：\n  ' + missing.join('\n  '));
  console.error('请先安装并登录 TeleAgent 桌面端。');
  process.exit(1);
}

const owner = resolveOwner();
const auth = await loadAuthState({ tokenFile: tokenFile(owner) });
if (!auth.token) {
  console.error('无法解密登录态：请确认 TeleAgent 已登录。');
  process.exit(1);
}

const meta = deviceMeta();
const catalog = readJson(path.join(accountDir(owner), 'model-catalog.json'), null);
const models = (catalog?.state?.catalog?.groups ?? [])
  .flatMap((g) => g.models ?? [])
  .map((m) => ({ id: m.modelID, name: m.displayName, context: m.limits?.context, output: m.limits?.output }));

if (models.length === 0) {
  console.error('模型目录为空：先在 TeleAgent 桌面端打开一次对话。');
  process.exit(1);
}

log(`账号 ${auth.claims?.accountName ?? '?'} · kernel ${kernelVersion()}`);

const runtimeRoot = path.join(here, 'runtime');

// PID 文件：供 start.vbs / stop.cmd 精确管理后台进程（避免误杀别的 node）。
import fs from 'node:fs';
const pidFile = path.join(runtimeRoot, 'proxy.pid');
try {
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(pidFile, String(process.pid));
} catch {}
const clearPidFile = () => {
  try {
    if (fs.readFileSync(pidFile, 'utf8').trim() === String(process.pid)) fs.unlinkSync(pidFile);
  } catch {}
};
process.on('exit', clearPidFile);
const authState = { token: auth.token, deviceId: meta.deviceId, installId: meta.installId };

/**
 * 当前内核实际采用的提示词来源（`/healthz` 与日志都读它）。
 *
 * 「模型又自报星辰」几乎只有两种原因：内核根本没吃进客户端提示词，或者客户端
 * 提示词压根没发过来。把「谁在生效」变成可读字段，就不用再靠猜。
 */
let kernelInfo = { client: 'default', promptChars: 0, promptSha: null, verified: null };

/**
 * 启动/切换内核后回读 `/config`，确认 `agent.build.prompt` 真的是我们下发的版本。
 * 读不到（接口变动）只记 `verified: null`，不阻断请求。
 */
async function verifyKernelPrompt(target, expected) {
  const want = (expected ?? '').trim();
  let got = null;
  try {
    const res = await target.call('GET', '/config', null, { timeoutMs: 8000 });
    got = res.json?.agent?.build?.prompt ?? null;
  } catch {
    // 读不到就保持未校验；不影响代理本身
  }
  const actual = (got ?? '').trim();
  const verified = got === null ? null : want ? actual === want : true;
  if (verified === false) {
    warn(
      `⚠ 内核没有采用我们下发的 prompt：期望 ${want.length} 字符，实际 ${actual.length} 字符`,
    );
  }
  if (actual.includes('星辰超级智能体')) {
    warn('⚠ 内核正在使用自带「星辰」人设：检查 TA_BUILTIN_PROMPT 是否被设成了 1');
  }
  return {
    promptChars: actual.length,
    promptSha: actual ? crypto.createHash('sha1').update(actual).digest('hex').slice(0, 12) : null,
    verified,
  };
}


// API Key 表：默认 runtime/config/api-keys.json（TA_KEYS_FILE 可改），管理台在这里增删
const keystore = createKeyStore({ file: process.env.TA_KEYS_FILE || path.join(runtimeRoot, 'config', 'api-keys.json') });
// 运行时配置：管理台可即时改、写 JSON 持久化，重启保留。构造时即把值同步回 process.env。
const runtimeConfig = createRuntimeConfig({ file: process.env.TA_RUNTIME_CONFIG_FILE || path.join(runtimeRoot, 'config', 'runtime.json') });
const adminToken = process.env.TA_ADMIN_TOKEN || null;

// 内核池：按「客户端 + 提示词指纹」缓存常驻内核。并发对话提示词不同时让各内核共存，
// 而不是 close/start 抢同一个内核 —— 后者正是「两个对话来回切内核 → terminated → 重发全量」的根源。
const kernelPool = new Map(); // key -> { kernel, info, lastUsed, dataTag }
// 池上限：对齐账号「并发任务上限」（默认 3 个任务位）；同时防止提示词微调导致无限建内核。
// 闲置超过 10 分钟且池超限时才淘汰，绝不打断进行中的对话。
const KERNEL_POOL_MAX = Number(process.env.TA_KERNEL_POOL_MAX || 3);
let kernelSeq = 0;
let currentKernel = null;     // 最近使用的内核，供 healthz / 关停用
let getKernelChain = Promise.resolve();
let resetSessions = () => {};

log('正在启动 kernel（首次约需 1–2 分钟）…');
const defaultKernel = await startKernel({ runtimeRoot, auth: authState, catalog });
await defaultKernel.waitReady({ timeoutMs: 90000 });
const defaultInfo = { client: 'neutral', ...(await verifyKernelPrompt(defaultKernel, NEUTRAL_AGENT_PROMPT)) };
kernelInfo = defaultInfo;
currentKernel = defaultKernel;
kernelPool.set('default', { kernel: defaultKernel, info: defaultInfo, lastUsed: Date.now() });
log(`内核提示词：中性兜底 · ${kernelInfo.promptChars} 字符 · 校验 ${kernelInfo.verified === true ? '通过' : kernelInfo.verified === null ? '不可读' : '未通过'}`);

const bridge = await createToolBridge({ kernel: defaultKernel });

/**
 * LRU 淘汰：池满时关掉「闲置超过 10 分钟」的非默认内核，避免提示词微调导致内核无限增长。
 * 只淘汰闲置的，绝不打断正在进行的对话；全都在用时宁可暂时超限。
 * 被淘汰内核的 sessionID 随之失效，所以一并清空会话映射（下次会重建会话）。
 */
function evictStaleKernels(keepKey) {
  if (kernelPool.size <= KERNEL_POOL_MAX) return;
  const idleMs = 10 * 60 * 1000;
  const now = Date.now();
  const victims = [...kernelPool.entries()]
    .filter(([k, v]) => k !== 'default' && k !== keepKey && now - v.lastUsed > idleMs)
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  let evicted = false;
  while (kernelPool.size > KERNEL_POOL_MAX && victims.length) {
    const [key, entry] = victims.shift();
    kernelPool.delete(key);
    try {
      entry.kernel.close();
    } catch {}
    evicted = true;
    log(`内核池淘汰 ${key}（闲置 ${Math.round((now - entry.lastUsed) / 60000)} 分钟，池内 ${kernelPool.size} 个）`);
  }
  if (evicted) resetSessions();
}

async function createKernelFor(key, prompt) {
  const client = key.split(':')[0];
  const chars = (prompt ?? '').trim().length;
  const dataTag = `k${++kernelSeq}`;
  log(`新建内核 ${key}（${client}，${chars} 字符，dataTag=${dataTag}）；池内共 ${kernelPool.size + 1} 个`);
  const k = await startKernel({ runtimeRoot, dataTag, auth: authState, catalog, agentPrompt: prompt });
  await k.waitReady({ timeoutMs: 90000 });
  const info = { client, ...(await verifyKernelPrompt(k, prompt)) };
  log(
    `内核提示词：${client} · ${info.promptChars} 字符 · 校验 ${info.verified === true ? '通过' : info.verified === null ? '不可读' : '未通过'}`,
  );
  kernelPool.set(key, { kernel: k, info, lastUsed: Date.now(), dataTag });
  currentKernel = k;
  kernelInfo = info;
  evictStaleKernels(key);
  return k;
}

async function getKernel({ key, prompt }) {
  const run = async () => {
    const hit = kernelPool.get(key);
    if (hit) {
      const alive = typeof hit.kernel.isAlive === 'function' ? hit.kernel.isAlive() : true;
      const healthy = !hit.kernel.health || hit.kernel.health.ok !== false;
      if (alive && healthy) {
        hit.lastUsed = Date.now();
        currentKernel = hit.kernel;
        kernelInfo = hit.info;
        return hit.kernel;
      }
      // 内核进程已退出、或被连续网络失败判定为不可用：它上面的会话全部失效。
      // 必须剔除并重建，否则会一直复用死内核 —— 客户端看到的就是连环 "fetch failed"。
      kernelPool.delete(key);
      try {
        hit.kernel.close();
      } catch {}
      const why = alive ? '连续网络失败' : '进程已退出';
      warn(`内核 ${key} ${why}（${hit.kernel.health?.lastFailure ?? '未知'}），剔除后重建`);
      // 该内核的 sessionID 已全部失效；清空映射让客户端下一轮从自己的消息全量重放
      resetSessions();
    }
    return createKernelFor(key, prompt);
  };
  // 建内核串行化，避免并发同时拉起多个进程；命中已有内核则直接复用，不再 close
  const result = getKernelChain.then(run, run);
  getKernelChain = result.catch(() => {});
  return result;
}

const listenPort = Number(process.env.TA_PORT || 8787);
let shim;
try {
  shim = await createShim({
    getKernel,
    kernelStatus: () => ({ origin: currentKernel?.origin ?? null, ...kernelInfo, poolSize: kernelPool.size }),
    bridge,
    models,
    apiKey: process.env.TA_API_KEY || null,
    keystore,
    adminToken,
    runtimeConfig,
    points: createPoints(),
    port: listenPort,
    archiveDir: path.join(runtimeRoot, 'archive'),
  });
} catch (err) {
  // 端口被占用（例如上一个代理还没退干净）时给出可操作的提示，而不是抛出 UV_HANDLE_CLOSING 断言
  if (err?.code === 'EADDRINUSE') {
    console.log();
    error(`端口 ${listenPort} 已被占用，通常是上一个代理实例还没退出。`);
    error('请先关闭旧实例（关闭它的命令行窗口），或设置 TA_PORT 换一个端口后重试。');
  } else {
    error('启动失败：', err);
  }
  for (const { kernel: k } of kernelPool.values()) {
    try { k.close(); } catch {}
  }
  process.exit(1);
}
resetSessions = () => {
  shim.resetSessions();
  resetResponsesSessions();
};

log(`OpenAI 兼容端点: ${shim.url}`);
log(`模型: ${models.map((m) => m.id).join(', ')}`);
if (process.env.TA_API_KEY) log('已启用 Bearer 校验（环境变量 TA_API_KEY）');
const keyStats = keystore.stats();
log(`API 密钥: ${keyStats.activeKeys} 启用 / ${keyStats.totalKeys} 总数 · ${keystore.file}`);
log(`管理台: http://127.0.0.1:${shim.port}/admin${adminToken ? '（需要 TA_ADMIN_TOKEN）' : ''}`);
// 可选自动签到（默认关闭；官方 app 也内置了每日 08:13 自动领取）
if (process.env.TA_AUTO_SIGN === '1') {
  startAutoSign({ log });
  log('积分自动签到: 已开启（每小时检查，每日最多领一次）');
}
// start.cmd 会带上 TA_OPEN_ADMIN=1：服务就绪后自动打开管理台
if (process.env.TA_OPEN_ADMIN === '1') {
  const adminUrl = `http://127.0.0.1:${shim.port}/admin`;
  try {
    const child =
      process.platform === 'win32'
        ? spawn('cmd', ['/c', 'start', '', adminUrl], { windowsHide: true, stdio: 'ignore' })
        : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [adminUrl], { stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

if (!keystore.required(process.env.TA_API_KEY || null)) {
  log('提示: 当前未开启鉴权，本机任意程序都可调用。可在管理台新建密钥或把鉴权设为「强制校验」。');
}

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  console.log();
  log('正在关闭…');
  keystore.flush();
  await shim.close();
  await bridge.close().catch(() => {});
  for (const { kernel: k } of kernelPool.values()) {
    try { k.close(); } catch {}
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Windows: taskkill（不带 /F）发的是 SIGHUP 而非 SIGTERM —— 也走优雅关闭，
// 否则 stop.cmd 只能强杀，残留内核子进程与端口占用。
if (process.platform === 'win32') process.on('SIGHUP', shutdown);
process.on('exit', () => {
  try {
    keystore.flush();
  } catch {}
  for (const { kernel: k } of kernelPool.values()) {
    try { k.close(); } catch {}
  }
});

