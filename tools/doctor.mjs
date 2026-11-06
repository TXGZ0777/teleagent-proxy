// 环境自检：安装 / 登录 / 凭据 / 模型目录 / kernel 启动
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveOwner, accountDir, tokenFile, readJson, kernelVersion, ensureTeleAgentLayout, DEVICE_DATA_ROOT } from '../lib/paths.mjs';
import { loadAuthState, deviceMeta, dpapiMasterKey } from '../lib/auth.mjs';
import { startKernel } from '../lib/kernel.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? '  — ' + detail : ''}`);
}

console.log('TeleAgent 本地反代自检\n');

const missing = ensureTeleAgentLayout();
check('桌面端已安装', missing.length === 0, missing.length ? `缺少 ${missing[0]}` : DEVICE_DATA_ROOT);

let owner = null;
try {
  owner = resolveOwner();
  check('已登录（current-owner）', true, `${owner.ownerDir} / tenant=${owner.tenantId}`);
} catch (err) {
  check('已登录（current-owner）', false, err.message);
}

let auth = null;
if (owner) {
  try {
    await dpapiMasterKey();
    check('DPAPI 主密钥可解', true);
  } catch (err) {
    check('DPAPI 主密钥可解', false, err.message);
  }
  try {
    auth = await loadAuthState({ tokenFile: tokenFile(owner) });
    const exp = auth.claims?.exp ? new Date(auth.claims.exp * 1000) : null;
    const alive = !exp || exp.getTime() > Date.now();
    check('登录态可解密', true, `${auth.claims?.accountName ?? '?'} ${alive ? '' : '(JWT 已过期，请重新登录)'}`);
    if (exp) check('JWT 未过期', alive, exp.toISOString());
  } catch (err) {
    check('登录态可解密', false, err.message);
  }
}

let catalog = null;
if (owner) {
  catalog = readJson(path.join(accountDir(owner), 'model-catalog.json'), null);
  const models = (catalog?.state?.catalog?.groups ?? []).flatMap((g) => g.models ?? []);
  check('模型目录可用', models.length > 0, models.map((m) => m.modelID).join(', '));
}

if (auth && catalog && owner) {
  const meta = deviceMeta();
  let kernel = null;
  try {
    kernel = await startKernel({
      runtimeRoot: path.join(here, '..', 'runtime'),
      auth: { token: auth.token, deviceId: meta.deviceId, installId: meta.installId },
      catalog,
    });
    const health = await kernel.waitReady({ timeoutMs: 60000 });
    check('kernel 可启动', true, `port=${kernel.port} version=${health?.data?.version ?? '?'}`);
    const providers = await kernel.call('GET', '/config/providers');
    check('provider 配置生效', providers.status === 200 && providers.text.includes('NewApi'), `HTTP ${providers.status}`);
  } catch (err) {
    check('kernel 可启动', false, err.message);
  } finally {
    kernel?.close();
  }
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n结论：${failed.length === 0 ? '全部通过，可以 node server.mjs 了' : `${failed.length} 项失败`}`);
process.exit(failed.length === 0 ? 0 : 1);
