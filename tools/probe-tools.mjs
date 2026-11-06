// 工具注册表探针：确认 kernel 暴露了哪些工具、MCP 挂载后变成什么、内置工具能否关掉
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveOwner, accountDir, tokenFile, readJson } from '../lib/paths.mjs';
import { loadAuthState, deviceMeta } from '../lib/auth.mjs';
import { startKernel } from '../lib/kernel.mjs';
import { createToolBridge } from '../lib/toolbridge.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const owner = resolveOwner();
const auth = await loadAuthState({ tokenFile: tokenFile(owner) });
const meta = deviceMeta();
const catalog = readJson(path.join(accountDir(owner), 'model-catalog.json'), null);

const kernel = await startKernel({
  runtimeRoot: path.join(here, '..', 'runtime-probe'),
  auth: { token: auth.token, deviceId: meta.deviceId, installId: meta.installId },
  catalog,
});
await kernel.waitReady({ timeoutMs: 90000 });

const ids1 = await kernel.call('GET', '/experimental/tool/ids');
console.log('内置 tools:', ids1.status, JSON.stringify(ids1.json).slice(0, 800));

const bridge = await createToolBridge({ kernel });
bridge.setTools([
  { name: 'shell', description: 'run shell', parameters: { type: 'object', properties: { command: { type: 'array', items: { type: 'string' } } } } },
]);
console.log('mount:', JSON.stringify(await bridge.mount({ force: true })));
console.log('registration:', JSON.stringify(await bridge.waitForRegistration({ expected: 1, timeoutMs: 6000 })));

const ids2 = await kernel.call('GET', '/experimental/tool/ids');
console.log('挂载后 tools:', JSON.stringify(ids2.json).slice(0, 1200));
console.log('flags:', JSON.stringify(await bridge.builtinFlags()).slice(0, 800));

await bridge.close();
kernel.close();
