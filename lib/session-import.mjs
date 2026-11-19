// 浏览器登录 token 导入核心（与 tools/import-login-token.mjs 同源逻辑，供管理台复用）
//
// 输入：完整回执 URL（只抠 query 里的 token=，域名/路径不限）或裸 JWT / token= 片段。
// 行为：校验 JWT（exp / 90 天绝对期限）→ 校验导出包骨架 → 用主密钥重新加密落盘
//       （旧 token.json 备份 .bak-*，保留最近 3 份）→ 清 renewal-state.json
//       （新会话从 generation=1 重新计数）→ 回读验证。
//       只替换 token 本体，owner / tenant / deviceId 沿用导出包。
// 纯本地操作，不发任何网络请求；网络验证由调用方做（renewCredential 的 force 语义）。
import fs from 'node:fs';
import path from 'node:path';
import { accountDir } from './paths.mjs';
import { readCredential, writeJsonAtomic, credentialStatus } from './renew.mjs';
import { encryptV10, parseJwt } from './auth.mjs';

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

/**
 * @param {object} args
 * @param {string} args.raw 完整回执 URL / 裸 JWT / token= 片段
 * @param {boolean} [args.dryRun] 只校验与预览，不落盘
 * @returns {Promise<{ok:true, dryRun:boolean, info:object}|{ok:false, code:string, message:string, hint?:string}>}
 *   失败 code：no-token | bad-jwt | expired | abs-expired | skeleton | readback
 */
export async function importLoginToken({ raw, dryRun = false } = {}) {
  const jwt = extractToken(raw);
  if (!jwt) {
    return {
      ok: false,
      code: 'no-token',
      message: '没有从输入里找到 token 参数',
      hint: '粘贴登录后地址栏的完整 URL（含 token= 参数）；只有 code= 没有 token= 说明跳转还没走完。',
    };
  }
  const claims = parseJwt(jwt);
  if (!claims?.exp) {
    return {
      ok: false,
      code: 'bad-jwt',
      message: 'token 不是合法 JWT（解不出 exp）',
      hint: '请确认复制的是 token= 参数的完整值（一长串 eyJ… 开头的令牌）。',
    };
  }
  const now = Date.now();
  if (claims.exp * 1000 <= now) {
    return {
      ok: false,
      code: 'expired',
      message: `token 已过期（exp=${new Date(claims.exp * 1000).toISOString()}）`,
      hint: '回浏览器重新登录拿新的（导入无法延展已过期的会话）。',
    };
  }
  if (claims.abs && claims.abs * 1000 <= now) {
    return {
      ok: false,
      code: 'abs-expired',
      message: `会话 90 天绝对期限已过（abs=${new Date(claims.abs * 1000).toISOString()}）：续期链已死`,
      hint: '正常新登录不会出现这种情况；重新登录拿新会话即可。',
    };
  }

  // 骨架校验：owner / tenant / 主密钥都从现有导出包来（只换 token，不动其它）
  let cred;
  try {
    cred = await readCredential();
  } catch (err) {
    return {
      ok: false,
      code: 'skeleton',
      message: `导出包骨架不可用：${err?.message ?? err}`,
      hint: '导入只替换 token，需要现有导出包提供 owner/tenant/deviceId/主密钥；全新部署先在 PC 跑 tools/export-credentials.mjs。',
    };
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

  const info = {
    ownerDir: cred.ownerDir,
    tenant: cred.tenant || '-',
    tokenExpiresAt: new Date(meta.tokenExpiresAt).toISOString(),
    daysLeft: (meta.tokenExpiresAt - now) / 86400000,
    absoluteExpiresAt: meta.absoluteExpiresAt ? new Date(meta.absoluteExpiresAt).toISOString() : null,
    generation: 1,
  };

  if (dryRun) return { ok: true, dryRun: true, info };

  // 备份旧 token.json（与 renewCredential 同款：保留最近 3 份）
  let backup = null;
  try {
    const bak = `${cred.tokenFile}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(cred.tokenFile, bak);
    const dir = path.dirname(cred.tokenFile);
    const baks = fs.readdirSync(dir).filter((f) => f.startsWith('token.json.bak-')).sort();
    for (const f of baks.slice(0, Math.max(0, baks.length - 3))) fs.rmSync(path.join(dir, f), { force: true });
    backup = path.basename(bak);
  } catch { /* 备份失败不阻断 */ }

  writeJsonAtomic(cred.tokenFile, {
    version: 1,
    encryptedToken: encryptV10(cred.masterKey, plain),
    encrypted: true,
    scheme: 'safe_storage',
    encryptedMeta: encryptV10(cred.masterKey, JSON.stringify(meta)),
  });
  // 新会话从零开始：清掉旧会话的续期痕迹（旧 lastSuccessAt/失败标记不属于这条会话）
  const stateFile = path.join(accountDir(cred.owner), 'app-auth', 'renewal-state.json');
  fs.rmSync(stateFile, { force: true });

  // 落盘后回读验证
  const s = await credentialStatus();
  if (s.daysLeft === null || s.daysLeft <= 0) {
    return { ok: false, code: 'readback', message: '落盘后回读异常（天数非法），请检查 token.json 内容' };
  }
  return { ok: true, dryRun: false, info: { ...info, generation: s.generation, daysLeft: s.daysLeft, backup } };
}
