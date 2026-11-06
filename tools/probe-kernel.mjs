// 探针：启动独立 kernel → 健康检查 → 列 provider → 建会话 → 发一条消息
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveOwner, accountDir, tokenFile, readJson, kernelVersion } from '../lib/paths.mjs';
import { loadAuthState, deviceMeta } from '../lib/auth.mjs';
import { startKernel } from '../lib/kernel.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.join(here, '..', 'runtime');
const started = Date.now();

const owner = resolveOwner();
console.log('owner:', owner.ownerDir);
console.log('kernel version:', kernelVersion());

const auth = await loadAuthState({ tokenFile: tokenFile(owner) });
console.log('login claims:', {
  accountId: auth.claims?.accountId,
  userId: auth.claims?.userId,
  tenant: auth.claims?.tenant,
  accountName: auth.claims?.accountName,
  exp: auth.claims?.exp ? new Date(auth.claims.exp * 1000).toISOString() : undefined,
});

const meta = deviceMeta();
const catalog = readJson(path.join(accountDir(owner), 'model-catalog.json'), null);
console.log('catalog models:', Object.keys(
  Object.fromEntries(
    (catalog?.state?.catalog?.groups || []).flatMap((g) => (g.models || []).map((m) => [m.modelID, 1])),
  ),
).join(', '));

const sessionKey = process.env.TA_SESSION_KEY || undefined;
const kernel = await startKernel({
  runtimeRoot,
  auth: { token: auth.token, deviceId: meta.deviceId, installId: meta.installId },
  catalog,
  sessionKey,
  port: Number(process.env.TA_KERNEL_PORT || 0) || undefined,
  onLog: (m) => console.log('[kernel]', m),
});
console.log('kernel port:', kernel.port, 'pid:', kernel.proc.pid);

try {
  const health = await kernel.waitReady({ timeoutMs: 90000 });
  console.log('health:', JSON.stringify(health).slice(0, 300));

  const providers = await kernel.call('GET', '/config/providers');
  console.log('providers:', providers.status, providers.text.slice(0, 600));

  const created = await kernel.call('POST', '/session', { title: 'proxy probe' });
  console.log('session:', created.status, created.text.slice(0, 300));
  const sessionId = created.json?.id || created.json?.session?.id;
  if (!sessionId) throw new Error('没有拿到 session id');

  const body = {
    model: { providerID: 'NewApi', modelID: process.env.TA_MODEL || 'chat-flash' },
    parts: [{ type: 'text', text: process.env.TA_PROMPT || '只回复两个字：你好' }],
  };
  const t0 = Date.now();
  const msg = await kernel.call('POST', `/session/${sessionId}/message`, body, { timeoutMs: 180000 });
  console.log('message status:', msg.status, `(${Date.now() - t0}ms)`);
  console.log('message body:', msg.text.slice(0, 1500));
} catch (err) {
  console.error('probe failed:', err.message);
  const logDir = path.join(runtimeRoot, 'logs');
  const { readdirSync } = await import('node:fs');
  for (const f of readdirSync(logDir).slice(0, 3)) {
    console.log('--- log:', f);
    const { readFileSync } = await import('node:fs');
    console.log(readFileSync(path.join(logDir, f), 'utf8').slice(-3000));
  }
  process.exitCode = 1;
} finally {
  kernel.close();
  console.log('elapsed:', Date.now() - started, 'ms');
}
