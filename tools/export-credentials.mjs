// TeleAgent 凭据导出工具（PC 上跑一次，把登录态组装成 NAS/Docker 数据根）
//
// 用法：
//   node tools/export-credentials.mjs                    # 导出到 ./ta-export
//   node tools/export-credentials.mjs --out D:\ta-export # 指定输出目录
//
// 做什么：
//   1. DPAPI 解出 32B 主密钥（Local State -> os_crypt.encrypted_key），写成 crypt-key.b64
//      —— NAS 侧把它填进 TA_CRYPT_KEY 后，解密走纯 Node crypto（lib/auth.mjs），不再依赖 Windows；
//   2. 从本机数据根拷贝 NAS 需要的最小文件集（gateway + renew 两个角色的全部依赖）；
//   3. round-trip 校验：用导出的主密钥解 token.json，确认 JWT 可解析、未过期，才允许交付。
//
// 导出清单（相对数据根）：
//   current-owner.json                     当前账号（resolveOwner）
//   Local State                            Chromium v10 密钥容器（桌面端同构目录）
//   app-auth/device-meta.json              deviceId（X-SuperAgent-Device-Id）
//   runtimes/.version.json                 内核版本（appVersion / points 用）
//   users/<owner>/app-auth/token.json      加密登录态（renew 读+写回的同一文件）
//   users/<owner>/model-catalog.json       模型目录（gateway 的 /v1/models 来源）
//   ta-export-meta.json                    导出时间与版本记录（renew appVersion() 读取）
//   crypt-key.b64                          32B 主密钥（base64 单行）→ .env 的 TA_CRYPT_KEY
//
// 安全提醒：crypt-key.b64 等同账号凭据，不要进 git、不要发给别人；ta-export/ 已在 .gitignore。
import fs from 'node:fs';
import path from 'node:path';
import {
  DEVICE_DATA_ROOT,
  CURRENT_OWNER_FILE,
  LOCAL_STATE_FILE,
  DEVICE_META_FILE,
  VERSION_FILE,
  readJson,
  resolveOwner,
  accountDir,
} from '../lib/paths.mjs';
import { dpapiMasterKey, decryptV10, parseJwt } from '../lib/auth.mjs';

const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const outDir = path.resolve(outIdx >= 0 && argv[outIdx + 1] ? argv[outIdx + 1] : 'ta-export');

// 根级必带 / 尽量带（缺失只是功能降级，逐项给出后果提示）
const ROOT_FILES = [
  { rel: 'current-owner.json', required: true },
  { rel: 'Local State', required: true },
  { rel: 'app-auth/device-meta.json', required: false, note: '缺失 → deviceId 为空，续期请求将缺少设备头' },
  { rel: 'runtimes/.version.json', required: false, note: '缺失 → NAS 用镜像内置版本，一般无碍' },
];
// 用户级（users/<owner>/）必带
const USER_FILES = [
  { rel: 'app-auth/token.json', required: true },
  { rel: 'model-catalog.json', required: false, note: '缺失 → gateway 无可用模型列表' },
];

function copyOne(rel) {
  const src = path.join(DEVICE_DATA_ROOT, rel);
  const dst = path.join(outDir, rel);
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return true;
}

async function main() {
  const owner = resolveOwner(); // 未登录直接报错
  const ownerDir = owner.ownerDir;
  console.log(`数据根   : ${DEVICE_DATA_ROOT}`);
  console.log(`账号     : ${ownerDir}`);
  console.log(`导出到   : ${outDir}`);
  fs.mkdirSync(outDir, { recursive: true });

  // 1) 主密钥（Windows DPAPI；lib/auth.mjs 同源逻辑）
  const masterKey = await dpapiMasterKey({ force: true });
  const keyB64 = masterKey.toString('base64');
  fs.writeFileSync(path.join(outDir, 'crypt-key.b64'), keyB64 + '\n', 'utf8');
  console.log(`主密钥   : 32 字节已导出 → crypt-key.b64`);

  // 2) 拷贝最小文件集
  const missing = [];
  for (const f of ROOT_FILES) {
    if (copyOne(f.rel)) console.log(`已拷贝   : ${f.rel}`);
    else if (f.required) missing.push(f.rel);
    else console.warn(`缺文件   : ${f.rel}（${f.note}）`);
  }
  for (const f of USER_FILES) {
    const rel = path.posix.join('users', ownerDir, f.rel);
    if (copyOne(path.join('users', ownerDir, f.rel))) console.log(`已拷贝   : ${rel}`);
    else if (f.required) missing.push(rel);
    else console.warn(`缺文件   : ${rel}（${f.note}）`);
  }
  if (missing.length) throw new Error(`必需文件缺失，导出不完整：\n  - ${missing.join('\n  - ')}`);

  // 3) ta-export-meta.json（renew 的 appVersion() 优先读这里）
  const ver = readJson(VERSION_FILE, {});
  fs.writeFileSync(
    path.join(outDir, 'ta-export-meta.json'),
    `${JSON.stringify({ exportedAt: new Date().toISOString(), appVersion: ver.superAgentCode || '', sourceRoot: DEVICE_DATA_ROOT }, null, 2)}\n`,
    'utf8',
  );

  // 4) round-trip 校验：导出的密钥必须能解开导出的 token.json
  const record = readJson(path.join(outDir, 'users', ownerDir, 'app-auth', 'token.json'));
  const plain = decryptV10(masterKey, record.encryptedToken);
  const idx = plain.lastIndexOf(':');
  const token = idx >= 0 ? plain.slice(idx + 1) : plain;
  const claims = parseJwt(token);
  if (!claims?.exp) throw new Error('round-trip 校验失败：解出的明文不是合法 JWT（主密钥与密文不匹配？）');
  const daysLeft = (claims.exp * 1000 - Date.now()) / 86_400_000;
  console.log(`round-trip : OK — token 可解，${daysLeft.toFixed(1)} 天后过期${record.encryptedMeta ? '（encryptedMeta 同密钥可解）' : ''}`);

  console.log('');
  console.log('导出完成。下一步（详见 docs/nas-docker.md）：');
  console.log('  1. 把整个 ta-export 目录拷到 NAS（SMB/scp 均可）');
  console.log('  2. docker/.env 里 TA_DATA_ROOT=该目录，TA_CRYPT_KEY=crypt-key.b64 的内容');
  console.log('  3. 注意：NAS 完成首次续期后，PC 桌面端需重新登录一次（会话轮换语义，两端互不干扰）');
}

main().catch((error) => {
  console.error(`[export] 失败：${error?.message ?? error}`);
  process.exitCode = 1;
});
