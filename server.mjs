#!/usr/bin/env node
// TeleAgent → 本地 OpenAI 兼容反代（kernel 模式）
//
// 用法：
//   node server.mjs                    # 监听 127.0.0.1:8787
//   TA_PORT=9000 node server.mjs       # 换端口
//   TA_API_KEY=sk-local node server.mjs # 要求客户端带 Bearer
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveOwner, accountDir, tokenFile, readJson, kernelVersion, ensureTeleAgentLayout } from './lib/paths.mjs';
import { loadAuthState, deviceMeta } from './lib/auth.mjs';
import { startKernel } from './lib/kernel.mjs';
import { createToolBridge } from './lib/toolbridge.mjs';
import { resetSessions as resetResponsesSessions } from './lib/responses.mjs';
import { createShim } from './lib/shim.mjs';
import { createKeyStore } from './lib/keystore.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
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

console.log(`[teleagent] 账号 ${auth.claims?.accountName ?? '?'} · kernel ${kernelVersion()}`);

const runtimeRoot = path.join(here, 'runtime');
const authState = { token: auth.token, deviceId: meta.deviceId, installId: meta.installId };

// API Key 表：默认 runtime/config/api-keys.json（TA_KEYS_FILE 可改），管理台在这里增删
const keystore = createKeyStore({ file: process.env.TA_KEYS_FILE || path.join(runtimeRoot, 'config', 'api-keys.json') });
const adminToken = process.env.TA_ADMIN_TOKEN || null;

console.log('[teleagent] 正在启动 kernel（首次约需 1–2 分钟）…');
let kernel = await startKernel({ runtimeRoot, auth: authState, catalog });
await kernel.waitReady({ timeoutMs: 90000 });

const bridge = await createToolBridge({ kernel });

/**
 * 按客户端切换 kernel 的 agent prompt。
 *
 * kernel 内置的系统提示词把模型钉死成「星辰超级智能体」，对话里怎么声明自己是 Codex 都没用
 * （实测会被拒绝）。唯一生效的办法是启动时用 `agent.build.prompt` 替换它，
 * 所以这里按「客户端类型 + 提示词指纹」维护一个当前 kernel：变了就换内核。
 */
let kernelKey = 'default';
let resetSessions = () => {};
async function getKernel({ key, prompt }) {
  if (key === kernelKey) return kernel;
  if (bridge.hasCalls()) return kernel; // 工具循环进行中，先不换，避免打断挂起调用
  console.log(`[teleagent] 切换 kernel 提示词：${kernelKey} → ${key}`);
  try {
    kernel.close();
  } catch {}
  kernel = await startKernel({ runtimeRoot, auth: authState, catalog, agentPrompt: prompt });
  await kernel.waitReady({ timeoutMs: 90000 });
  kernelKey = key;
  bridge.attach(kernel);
  resetSessions();
  return kernel;
}

const shim = await createShim({
  getKernel,
  kernelStatus: () => ({ origin: kernel.origin }),
  bridge,
  models,
  apiKey: process.env.TA_API_KEY || null,
  keystore,
  adminToken,
  port: Number(process.env.TA_PORT || 8787),
});
resetSessions = () => {
  shim.resetSessions();
  resetResponsesSessions();
};

console.log(`[teleagent] OpenAI 兼容端点: ${shim.url}`);
console.log(`[teleagent] 模型: ${models.map((m) => m.id).join(', ')}`);
if (process.env.TA_API_KEY) console.log('[teleagent] 已启用 Bearer 校验（环境变量 TA_API_KEY）');
const keyStats = keystore.stats();
console.log(`[teleagent] API 密钥: ${keyStats.activeKeys} 启用 / ${keyStats.totalKeys} 总数 · ${keystore.file}`);
console.log(`[teleagent] 管理台: http://127.0.0.1:${shim.port}/admin${adminToken ? '（需要 TA_ADMIN_TOKEN）' : ''}`);
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
  console.log('[teleagent] 提示: 当前未开启鉴权，本机任意程序都可调用。可在管理台新建密钥或把鉴权设为「强制校验」。');
}

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  console.log('\n[teleagent] 正在关闭…');
  keystore.flush();
  await shim.close();
  await bridge.close().catch(() => {});
  kernel.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => {
  try {
    keystore.flush();
  } catch {}
  kernel.close();
});

