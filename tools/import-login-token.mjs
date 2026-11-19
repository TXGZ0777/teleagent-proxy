// TeleAgent 浏览器登录 token 导入（Linux/Windows 通用；凭据格式与桌面端同构）
//
// 背景（取证 .temp/main-runtime-a.js，LOGIN_CONFIG :120176-120186）：
//   - 桌面端的「登录」是 iframe 独立登录 Web App：APP_PAGE = /meter/teleagent-login/login
//     （bundle 原注释「Desktop 和 Web 登录壳都只 iframe 此地址」），桌面客户端自己
//     **不生成**任何登录二维码；
//   - 登录完成后跳到的是**回执页** LOGIN_PAGE = ${SERVER_URL}/cowork/auth，SERVER_URL（:620）
//     = /superCowork/sapi，真实回执 URL 即 /superCowork/sapi/cowork/auth?code=…&token=<JWT>；
//     主进程从跳转 URL 的 query 里抓 token 直接采纳（armLoginFlow，:196785-196820）。
//
//   因此官方登录（含网页上提供的短信/扫码等方式）本来就能在**任何浏览器**里完成：
//   浏览器打开登录 Web App，登录成功、地址栏变成 /superCowork/sapi/cowork/auth?code=…&token=…
//   时，把整个 URL 复制下来喂给本工具，就等于把这条**全新独立会话**装进 NAS 数据根。
//
//   入口可用性：pre 域的登录 App 与 API 网关是独立部署的两套服务，登录页可能单独故障
//   （2026-11-19 实测：pre 登录页响应超时打不开，桌面端/续期走的 API 正常）。此时改用
//   生产域名同款登录 App（agent.teleai.com.cn 域，路径同 /meter/teleagent-login/login，
//   回执 URL 换成该域 /superCowork/sapi/cowork/auth?...）——本工具不挑域名照常导入。
//   prod 签发的会话用 pre 刷新基址是否可行未实测：导入后跑 once --force 验证；若失败，
//   把 TA_REFRESH_BASE_URL 切到 prod 基址（详见 docs/nas-docker.md 第 6 节注意③）。
//
// 与导出接管的区别（会话模型见 lib/renew.mjs 头注释）：
//   - 导出接管：NAS 与 PC 共用同一条会话的副本，NAS 首续后 PC 必须重新登录；
//   - 浏览器登录导入：登录页产生的是一条**新的独立会话**，导入后 refresh 只轮换
//     这条新会话——PC 桌面端自己的会话不受影响，**不需要重新登录**。
//
// 用法：
//   node tools/import-login-token.mjs "<完整跳转 URL>"    # 推荐：粘登录后地址栏的完整 URL
//   node tools/import-login-token.mjs --token <裸JWT>     # 只粘 token 参数值也行
//   node tools/import-login-token.mjs "<URL>" --dry-run   # 只校验与预览，不落盘
//
// 前提：数据根已有导出包骨架（current-owner.json / app-auth/token.json / device-meta.json，
// 即 tools/export-credentials.mjs 的产物）。本工具只替换 token 本体，
// owner / tenant / deviceId 沿用导出包；导入会把 renewal-state.json 清零
// （新会话从 generation=1 重新开始计数），旧 token.json 备份为 .bak-*（保留最近 3 份）。
//
// 注意（未实测项）：新会话是浏览器上下文签发的，refresh 携带的 X-SuperAgent-Device-Id
// 沿用导出包的桌面端 deviceId——服务端是否校验「会话与设备」绑定关系未知，
// 与 NAS 续期复刻本身同属一类未实测风险；若导入后续期报终态失败，回退用导出接管路径。
//
// 退出码：0 成功（或 dry-run 校验通过）；1 参数/凭据/格式问题；2 校验后判定该 token 不可用。
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { readCredential, writeJsonAtomic, credentialStatus } from '../lib/renew.mjs';
import { accountDir } from '../lib/paths.mjs';
import { encryptV10, parseJwt } from '../lib/auth.mjs';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('-')));
const dryRun = flags.has('--dry-run');
const tokenFlagIdx = argv.indexOf('--token');
// 输入源：--token <JWT> 或第一个非开关位置参数（完整跳转 URL，可能含 & 需要引号包好）
const raw = tokenFlagIdx >= 0 ? (argv[tokenFlagIdx + 1] ?? '') : argv.filter((a) => !a.startsWith('-')).join(' ');
const log = {
  info: (...a) => console.log(...a),
  warn: (...a) => console.warn(...a),
};

/** 从用户输入里抠出 JWT：优先完整 URL 的 token= 参数，其次裸 JWT / token= 片段 */
function extractToken(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/^eyJ/i.test(s)) return s;
  try {
    const u = new URL(s);
    const t = u.searchParams.get('token') || /^[#&]token=([^&]+)/.exec(u.hash)?.[1];
    if (t) return decodeURIComponent(t).trim();
  } catch { /* 不是完整 URL，继续用正则抠 */ }
  const m = /[?&#&]token=([^&\s"']+)/.exec(s);
  if (m) return decodeURIComponent(m[1]).trim();
  return '';
}

async function main() {
  if (dryRun) log.info('[import] dry-run：只校验与预览，不落盘');
  const jwt = extractToken(raw);
  if (!jwt) {
    log.warn(`!! 没有从输入里找到 token 参数。`);
    log.warn('   正确姿势：浏览器打开登录 Web App https://agent-pre.teleai.com.cn/meter/teleagent-login/login，');
    log.warn('   登录成功后等地址栏出现 code=…&token=…，把**整个 URL** 用引号包好粘进来：');
    log.warn('     node tools/import-login-token.mjs "https://agent-pre.teleai.com.cn/superCowork/sapi/cowork/auth?code=…&token=…"');
    log.warn('   （域名不限，只要 query 里有 token=；只有 code= 没有 token= 说明跳转还没走完，等最终跳转后再复制。）');
    process.exitCode = 1;
    return;
  }
  const claims = parseJwt(jwt);
  if (!claims?.exp) {
    log.warn('!! token 参数不是合法 JWT（解不出 exp），拒绝导入。请确认复制的是 token= 的完整值。');
    process.exitCode = 1;
    return;
  }
  const now = Date.now();
  if (claims.exp * 1000 <= now) {
    log.warn(`!! token 已过期（exp=${new Date(claims.exp * 1000).toISOString()}），不可导入。回浏览器重新登录拿新的。`);
    process.exitCode = 2;
    return;
  }
  if (claims.abs && claims.abs * 1000 <= now) {
    log.warn(`!! 会话 90 天绝对期限已过（abs=${new Date(claims.abs * 1000).toISOString()}）：续期链已死，不可导入。`);
    log.warn('   正常新登录不会出现这种情况；如果出现了，说明这条会话来自很旧的记录，重新登录即可。');
    process.exitCode = 2;
    return;
  }

  // 骨架校验：owner / tenant / 主密钥都从现有导出包来（只换 token，不动其它）
  let cred;
  try {
    cred = await readCredential();
  } catch (error) {
    log.warn(`!! 导出包骨架不可用：${error.message}`);
    log.warn('   本工具只替换 token，需要现有导出包提供 owner/tenant/deviceId/主密钥；');
    log.warn('   如果是全新机器部署，先在 PC 跑 tools/export-credentials.mjs 生成骨架。');
    process.exitCode = 1;
    return;
  }

  const plain = `${cred.tenant}:${jwt}`;
  const meta = {
    token: plain,
    tokenIssuedAt: now,
    tokenExpiresAt: claims.exp * 1000,
    // abs 兼容秒/毫秒（桌面端 optionalAbsoluteExpiry：<1e11 视为秒）
    absoluteExpiresAt: claims.abs ? (claims.abs < 1e11 ? claims.abs * 1000 : claims.abs) : null,
    generation: 1, // 新会话重新计数
  };
  const record = {
    version: 1,
    encryptedToken: encryptV10(cred.masterKey, plain),
    encrypted: true,
    scheme: 'safe_storage',
    encryptedMeta: encryptV10(cred.masterKey, JSON.stringify(meta)),
  };

  log.info(`[import] owner=${cred.ownerDir} tenant=${cred.tenant || '-'}`);
  log.info(`[import] 新 token 过期=${new Date(meta.tokenExpiresAt).toISOString()}（剩余 ${((meta.tokenExpiresAt - now) / 86400000).toFixed(1)} 天）${meta.absoluteExpiresAt ? ` 绝对期限=${new Date(meta.absoluteExpiresAt).toISOString()}` : ''}`);
  if (dryRun) {
    log.info('[import] dry-run 通过：格式/骨架/有效期均正常，去掉 --dry-run 即落盘');
    return;
  }

  // 备份旧 token.json（与 renewCredential 同款：保留最近 3 份）
  try {
    const bak = `${cred.tokenFile}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(cred.tokenFile, bak);
    const dir = path.dirname(cred.tokenFile);
    const baks = fs.readdirSync(dir).filter((f) => f.startsWith('token.json.bak-')).sort();
    for (const f of baks.slice(0, Math.max(0, baks.length - 3))) fs.rmSync(path.join(dir, f), { force: true });
    log.info(`[import] 旧 token 已备份：${path.basename(bak)}`);
  } catch { /* 备份失败不阻断 */ }

  writeJsonAtomic(cred.tokenFile, record);
  // 新会话从零开始：清掉旧会话的续期痕迹（旧 lastSuccessAt/失败标记不属于这条会话）
  const stateFile = path.join(accountDir(cred.owner), 'app-auth', 'renewal-state.json');
  fs.rmSync(stateFile, { force: true });

  // 落盘后回读验证
  const s = await credentialStatus();
  if (s.daysLeft === null || s.daysLeft <= 0) {
    log.warn('!! 落盘后回读异常（天数非法），请检查 token.json 内容');
    process.exitCode = 1;
    return;
  }
  log.info(`[import] 完成：generation=${s.generation} 回读剩余 ${s.daysLeft.toFixed(1)} 天`);
  log.info('[import] 提醒：这是一条全新独立会话，PC 桌面端不受影响、无需重新登录。');
  log.info('[import] 下一步：renew daemon 下次检查会自动 force 首续一次（验证新会话可用）；');
  log.info('         也可以立即手动验证：docker exec ta2api-renew node tools/renew-credentials.mjs once --force');
}

main().catch((error) => {
  console.error(`[import] 致命错误：${error?.message ?? error}`);
  process.exitCode = 1;
});
