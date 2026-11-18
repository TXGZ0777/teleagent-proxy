// TeleAgent 登录态续期（token-refresh 协议复刻）
//
// 全部行为对照官方桌面端主进程 bundle 取证复刻（取证产物 .temp/main-runtime-a.js，
// 行号见各段注释）。桌面端策略：启动补偿 + 每 6h 定时器，按本地日去重（每天最多
// 续期一次）；每次成功续期会在服务端轮换该会话凭据，旧 token 只有 60s 吊销宽限。
//
// 会话模型（重要）：
//   - 会话是「按登录实例」发放的，同一账号可以并存多条会话（PC 桌面一条、NAS 一条）；
//   - refresh 轮换的是「当前请求携带 token 所属的那条会话」；
//   - 因此 NAS 拿导出的 token 完成首次续期后，PC 桌面手里的旧 token 会在宽限后失效、
//     桌面端要求重新登录一次；重新登录产生的是**另一条**会话，与 NAS 互不干扰。
//
// 首次交接（auto handover）：本实例从未成功续期过（没有 renewal-state.json 的成功痕迹）
//   时，shouldRenewNow 会自动按 force 处理一次——部署后第一次检查就接管会话链，避免
//   导出凭据在 >21 天余量的空窗期被 PC 桌面端抢先轮换作废。TA_RENEW_AUTO_HANDOVER=0
//   可关闭（例如把 NAS 当被动备份、不想踢 PC 下线时）。
//
// 平台约束：解密/加密走 lib/auth.mjs（Windows 用 DPAPI，其它平台用 TA_CRYPT_KEY），
// 本模块自身不依赖任何平台 API，Windows/Linux 均可运行。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CURRENT_OWNER_FILE, DEVICE_DATA_ROOT, LOCAL_STATE_FILE, DEVICE_META_FILE, VERSION_FILE, readJson, resolveOwner, tokenFile, accountDir } from './paths.mjs';
import { dpapiMasterKey, decryptV10, encryptV10, parseJwt } from './auth.mjs';

// ── 协议常量（与桌面端一致）─────────────────────────────────────────────
// 桌面端 SERVER_URL（bundle 内联常量，登录/续期/logout 同源）：
//   const SERVER_URL = "https://agent-pre.teleai.com.cn/superCowork/sapi"（main-runtime-a.js:620）
// 注意：代理 kernel 的模型流量走 agent.teleai.com.cn（lib/kernel.mjs），是另一扇门；
// auth 门以桌面端实际值（agent-pre）为准，可用 TA_REFRESH_BASE_URL 覆盖。
export const DEFAULT_REFRESH_BASE_URL = 'https://agent-pre.teleai.com.cn/superCowork/sapi';
export const REFRESH_PATH = '/cowork/auth/token-refresh'; // main-runtime-a.js:621
export const REFRESH_TIMEOUT_MS = 10_000;                 // main-runtime-a.js:122739
export const AUTH_ERROR_CODES = {                         // main-runtime-a.js:122696
  /** 请求缺少 Access Token */
  MISSING_ACCESS_TOKEN: 40112,
  /** 验签失败 */
  SIGNATURE_INVALID: 40113,
  /** token 已过期且超出验签宽限 */
  TOKEN_EXPIRED: 40114,
  /** 会话不存在（已 logout，或已轮转并超出吊销宽限） */
  SESSION_NOT_FOUND: 40115,
  /** 90 天绝对期限已过 */
  SESSION_ABSOLUTE_EXPIRED: 40116,
  /** Redis / 内部依赖不可用（HTTP 503），后端明确禁止伪装成 40115 */
  TEMPORARILY_UNAVAILABLE: 50005,
};
// 重试策略（main-runtime-a.js:122027-122029）
export const GRACE_RETRY_DELAY_MS = 5_000;
export const CONNECT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
export const REVOCATION_GRACE_MS = 60_000;
// 桌面端调度（main-runtime-a.js:122971）每 6h 检查一次、按本地日去重
export const SCHEDULE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function formatLocalDay(ms = Date.now()) {
  // 桌面端 formatLocalDay 用本地日期；手工拼避免 Intl 依赖差异
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ── 凭据读取 ────────────────────────────────────────────────────────────

/**
 * 读取并解密当前账号凭据（只读，不落盘）。
 * 返回 { owner, ownerDir, tokenFile, tenant, token, claims, meta, masterKey, record }
 * - token：纯 JWT（去掉了 "<tenant>:" 前缀）
 * - meta：token.json 里 encryptedMeta 的明文（token/tokenIssuedAt/tokenExpiresAt/absoluteExpiresAt/generation）
 */
export async function readCredential({ ownerOverride = null } = {}) {
  const owner = ownerOverride ?? resolveOwner();
  const tf = tokenFile(owner);
  const record = readJson(tf);
  if (record?.version !== 1 || typeof record.encryptedToken !== 'string') {
    throw new Error(`token.json 格式不受支持（期望 version=1 + encryptedToken）：${tf}`);
  }
  if (record.scheme && record.scheme !== 'safe_storage') {
    throw new Error(`token.json scheme=${record.scheme} 不受支持（本工具只处理 safe_storage 密文）`);
  }
  const masterKey = await dpapiMasterKey();
  let plain;
  try {
    plain = decryptV10(masterKey, record.encryptedToken);
  } catch (error) {
    throw new Error(`token.json 解密失败（TA_CRYPT_KEY 与该文件的主密钥不匹配？文件属于别的设备/会话？）：${error.message}`);
  }
  const idx = plain.lastIndexOf(':');
  const token = idx >= 0 ? plain.slice(idx + 1) : plain;
  const tenant = idx >= 0 ? plain.slice(0, idx) : '';
  const claims = parseJwt(token);
  if (!claims) throw new Error('token 明文不是合法 JWT');
  let meta = null;
  if (record.encryptedMeta) {
    try {
      meta = JSON.parse(decryptV10(masterKey, record.encryptedMeta));
    } catch {
      meta = null; // 元数据解不开不致命（桌面端也按 null 处理）
    }
  }
  return { owner, ownerDir: owner.ownerDir, tokenFile: tf, tenant, token, claims, meta, masterKey, record };
}

/** device-meta.json 里的 deviceId（桌面端 X-SuperAgent-Device-Id 的第一优先来源） */
export function deviceIdentity() {
  let dev = { deviceId: '', installId: '' };
  try { dev = { ...dev, ...readJson(DEVICE_META_FILE, {}) }; } catch {}
  return dev;
}

/** 应用版本：桌面端发的是 Electron app.getVersion()；导出包里记录在 ta-export-meta.json */
export function appVersion() {
  if (process.env.TA_APP_VERSION?.trim()) return process.env.TA_APP_VERSION.trim();
  try {
    const m = readJson(path.join(DEVICE_DATA_ROOT, 'ta-export-meta.json'), null);
    if (m?.appVersion) return String(m.appVersion);
  } catch {}
  try {
    const ver = readJson(VERSION_FILE, {});
    if (ver.superAgentCode) return String(ver.superAgentCode);
  } catch {}
  return '';
}

// ── 请求构造（对照 buildAuthHeaders，main-runtime-a.js:122745）──────────

export function buildRefreshHeaders({ token, osType, appVer, deviceId, cookie, routingEnv } = {}) {
  const headers = {
    // 认证头已定（桌面端 2026-10-12 注释）：换新/logout 与现网一致使用 X-Token，不引入 Bearer。
    'Content-Type': 'application/json',
    'X-Token': token,
    'X-Timestamp': Math.floor(Date.now() / 1000).toString(),
    'X-Nonce': crypto.randomUUID(),
    'X-App-Version': appVer ?? '',
    'X-OS-Type': osType ?? '',
    'X-SuperAgent-Device-Id': deviceId ?? '',
  };
  // 业务路由头：BG_ENV 未设置时桌面端不附加任何头（main-runtime-a.js:119665）
  if (routingEnv) headers.teleagent = routingEnv;
  // operToken 是 Electron session 里的伴随 cookie（服务端登录时种下、refresh 可能轮换），
  // 请求构造本身不依赖它；有就带上，尽量贴近桌面端行为。
  if (cookie) headers.Cookie = cookie;
  return headers;
}

// ── 响应解析（对照 readRefreshBody / extractBackendCode，main-runtime-a.js:122796）──

/** 剥两层 { data: {...} } 包裹，取含 accessToken 的那层 */
export function readRefreshBody(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      const outer = parsed;
      const data = parsed.data;
      if (data && typeof data === 'object') {
        return { token: 'accessToken' in data ? data : outer, codeLayers: [outer, data] };
      }
      return { token: outer, codeLayers: [outer] };
    }
  } catch { /* 非 JSON：按空处理 */ }
  return { token: null, codeLayers: [] };
}

function toBackendErrorCode(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

export function extractBackendCode(body) {
  for (const field of ['responseCode', 'code']) {
    for (const layer of body.codeLayers) {
      const code = toBackendErrorCode(layer?.[field]);
      if (code !== null) return code;
    }
  }
  return null;
}

// ── 错误分类（对照 classifyAuthFailure，main-runtime-a.js:122710）────────
// terminal = 会话已死，只能重新导出/重新登录；retryable = 稍后重试有望成功。

export function classifyAuthFailure(status, code) {
  switch (code) {
    case AUTH_ERROR_CODES.MISSING_ACCESS_TOKEN: return { category: 'missing_token', terminal: true, retryable: false };
    case AUTH_ERROR_CODES.SIGNATURE_INVALID: return { category: 'signature_invalid', terminal: true, retryable: false };
    case AUTH_ERROR_CODES.TOKEN_EXPIRED: return { category: 'token_expired', terminal: true, retryable: false };
    case AUTH_ERROR_CODES.SESSION_NOT_FOUND: return { category: 'session_not_found', terminal: true, retryable: false };
    case AUTH_ERROR_CODES.SESSION_ABSOLUTE_EXPIRED: return { category: 'session_absolute_expired', terminal: true, retryable: false };
    case AUTH_ERROR_CODES.TEMPORARILY_UNAVAILABLE: return { category: 'temporarily_unavailable', terminal: false, retryable: true };
  }
  if (status === 401) return { category: 'unauthorized', terminal: true, retryable: false };
  if (status === 403) return { category: 'forbidden', terminal: false, retryable: false };
  if (status !== null && status >= 500) return { category: 'server_error', terminal: false, retryable: true };
  return { category: 'unknown', terminal: false, retryable: false };
}

// ── 单次请求 ────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 发一次 token-refresh 并解析结果（不带重试）。
 * 成功：{ ok:true, token, expiresIn, tokenIssuedAt, tokenExpiresAt, absoluteExpiresAt, setCookies }
 * 失败：{ ok:false, kind:'http', category, terminal, retryable, status, code } | { ok:false, kind:'transport', category, retryable }
 */
export async function renewOnce({ token, baseUrl, headers, timeoutMs = REFRESH_TIMEOUT_MS, cookieJar = null } = {}) {
  const base = String(baseUrl ?? DEFAULT_REFRESH_BASE_URL).replace(/\/+$/, '');
  const url = `${base}${REFRESH_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let headersReceived = false;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      // Body 可空（后端契约，桌面端注释原话）：不发任何猜测字段。
      body: '',
      signal: controller.signal,
    });
    headersReceived = true;
    const text = await response.text();
    // 服务端可能在 refresh 时轮换 operToken cookie：记进 jar 供下次携带
    const setCookies = typeof response.getSetCookie === 'function' ? response.getSetCookie() : [];
    if (cookieJar) cookieJar.absorb(setCookies);
    const body = readRefreshBody(text);
    const code = extractBackendCode(body);
    const verdict = classifyAuthFailure(response.status, code);
    if (verdict.terminal || !response.ok) {
      if (response.status === 404 || response.status === 405) {
        return { ok: false, kind: 'http', category: 'unsupported', terminal: false, retryable: false, status: response.status, code, snippet: text.slice(0, 160) };
      }
      return { ok: false, kind: 'http', category: verdict.category, terminal: verdict.terminal, retryable: verdict.retryable, status: response.status, code, snippet: text.slice(0, 160) };
    }
    const newToken = typeof body.token?.accessToken === 'string' ? body.token.accessToken.trim() : '';
    const expiresIn = typeof body.token?.expiresIn === 'number' && Number.isFinite(body.token.expiresIn) && body.token.expiresIn > 0
      ? body.token.expiresIn
      : null;
    if (!newToken || !expiresIn) {
      return { ok: false, kind: 'http', category: 'invalid_response', terminal: false, retryable: false, status: response.status, code, snippet: text.slice(0, 160) };
    }
    // absoluteExpiresAt 兼容秒/毫秒（桌面端 optionalAbsoluteExpiry：<1e11 视为秒）
    let absoluteExpiresAt = null;
    const abs = body.token?.absoluteExpiresAt;
    if (typeof abs === 'number' && Number.isFinite(abs) && abs > 0) {
      const ms = abs < 1e11 ? abs * 1000 : abs;
      if (ms > Date.now()) absoluteExpiresAt = ms;
    }
    const now = Date.now();
    return { ok: true, kind: 'http', status: response.status, token: newToken, expiresIn, tokenIssuedAt: now, tokenExpiresAt: now + expiresIn * 1000, absoluteExpiresAt, setCookies };
  } catch (error) {
    // 对照 classifyTransportFailure（main-runtime-a.js:122760）
    if (error?.name === 'AbortError') return { ok: false, kind: 'transport', category: 'timed_out', retryable: true };
    if (headersReceived) return { ok: false, kind: 'transport', category: 'network_error', retryable: true };
    const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
    const connectFailed = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|certificate|SSL/i.test(message);
    return { ok: false, kind: 'transport', category: connectFailed ? 'connect_failed' : 'network_error', retryable: true, message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 带桌面端重试策略的完整续期（对照 coordinator execute 循环）：
 * - timed_out / network_error：60s 吊销宽限窗口内允许 1 次宽限重试（间隔 5s）；
 * - connect_failed：最多 3 次退避重试（1s/2s/4s）；
 * - 其余失败与成功直接返回。
 */
export async function renewWithRetries(options = {}) {
  const startedAt = Date.now();
  let graceRetryUsed = false;
  let connectRetries = 0;
  for (;;) {
    const result = await renewOnce(options);
    if (result.ok) return result;
    const retryInsideGrace =
      !graceRetryUsed &&
      (result.category === 'timed_out' || result.category === 'network_error') &&
      Date.now() - startedAt <= REVOCATION_GRACE_MS;
    if (retryInsideGrace) {
      graceRetryUsed = true;
      await sleep(GRACE_RETRY_DELAY_MS);
      continue;
    }
    if (result.category === 'connect_failed' && connectRetries < CONNECT_RETRY_DELAYS_MS.length) {
      await sleep(CONNECT_RETRY_DELAYS_MS[connectRetries]);
      connectRetries += 1;
      continue;
    }
    return result;
  }
}

// ── 落盘（对照 persistTokenForOwner / commitRenewedToken，main-runtime-a.js:48137/48251）──

export function writeJsonAtomic(file, obj, mode = 0o600) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, mode); } catch {}
}

/** 简易 cookie jar：只跟 teleai.com.cn 的 operToken（+ refresh 时服务端回种的少量字段） */
export function createCookieJar(file = null, initial = '') {
  const jar = { value: initial || '' };
  jar.absorb = (setCookies = []) => {
    for (const raw of setCookies) {
      const m = /operToken=([^;]*)/i.exec(raw);
      if (m) jar.value = m[1];
    }
    if (file) {
      try { writeJsonAtomic(file, { operToken: jar.value, updatedAt: new Date().toISOString() }); } catch {}
    }
  };
  return jar;
}

/**
 * 完整续期一轮：读凭据 → 请求 → 校验 → 原子落盘。
 * 落盘与桌面端同构：
 *   token.json      = { version:1, encryptedToken, encrypted:true, scheme:'safe_storage', encryptedMeta }（0600）
 *   encryptedToken  = v10("<tenant>:<新JWT>")
 *   encryptedMeta   = v10(JSON{ token:<完整明文>, tokenIssuedAt, tokenExpiresAt, absoluteExpiresAt, generation:旧+1 })
 * 覆盖前把旧文件备份为 token.json.bak-<UTC 时间戳>（NAS 上没有桌面端帮我们兜底，回滚靠它）。
 */
export async function renewCredential({
  log = console,
  baseUrl = process.env.TA_REFRESH_BASE_URL?.trim() || DEFAULT_REFRESH_BASE_URL,
  osType = process.env.TA_OS_TYPE?.trim() || 'Windows', // 桌面端 win32 → "Windows"（getOsTypeDisplay）
  ownerOverride = null,
  cookieFile = null,
  dryRun = false,
} = {}) {
  const cred = await readCredential({ ownerOverride });
  const dev = deviceIdentity();
  const ver = appVersion();
  const cookieJar = createCookieJar(cookieFile);
  if (cookieFile) {
    try { cookieJar.value = readJson(cookieFile, {}).operToken || ''; } catch {}
  }
  const headers = buildRefreshHeaders({
    token: cred.token,
    osType,
    appVer: ver,
    deviceId: dev.deviceId || '',
    cookie: cookieJar.value ? `operToken=${cookieJar.value}` : '',
    routingEnv: process.env.TA_BG_ENV?.trim() || '',
  });
  log?.info?.(`[renew] owner=${cred.ownerDir} exp=${new Date(cred.claims.exp * 1000).toISOString()} base=${baseUrl} dryRun=${dryRun}`);

  if (dryRun) {
    return { ok: false, kind: 'dry_run', category: 'dry_run', headers, cred, message: 'dry-run：未发送请求（真实请求会轮换服务端凭据）' };
  }

  const result = await renewWithRetries({ token: cred.token, baseUrl, headers, cookieJar });

  if (result.kind === 'dry_run') return result; // 不可达，防御
  if (!result.ok) {
    log?.warn?.(`[renew] 失败 kind=${result.kind} category=${result.category}${result.status ? ` http=${result.status}` : ''}${result.code ? ` code=${result.code}` : ''}${result.snippet ? ` body=${result.snippet}` : ''}`);
    // 失败也留痕（桌面端 renewal-schedule 的「按本地日去重」对失败同样生效）：
    //   - lastAttemptDay 让失败当天不再重复打（防止 daemon 对死会话每 6h 重试）；
    //   - 首次交接撞上终态失败（会话已被 PC 抢走/已死）后记 handoverBlocked，
    //     不再自动重试——重试没有意义，只能重新导出或走浏览器登录导入。
    try {
      const prevStateFile = path.join(accountDir(cred.owner), 'app-auth', 'renewal-state.json');
      const prev = readJson(prevStateFile, {});
      const nextState = {
        ...prev,
        lastAttemptDay: formatLocalDay(),
        lastFailureAt: new Date().toISOString(),
        lastFailureCategory: result.category,
        lastFailureTerminal: Boolean(result.terminal),
      };
      if (result.terminal && !prev.lastSuccessAt) {
        nextState.handoverBlocked = true;
        nextState.handoverBlockedAt = nextState.lastFailureAt;
        nextState.handoverBlockedCategory = result.category;
      }
      writeJsonAtomic(prevStateFile, nextState);
    } catch { /* 留痕失败不影响主流程 */ }
    return { ...result, cred };
  }

  // 校验新 token 可解析且更新
  const newClaims = parseJwt(result.token);
  if (!newClaims?.exp) {
    return { ok: false, kind: 'http', category: 'invalid_response', terminal: false, retryable: false, message: '新 token 不是可解析的 JWT，拒绝落盘', cred };
  }
  if (newClaims.exp * 1000 <= Date.now()) {
    return { ok: false, kind: 'http', category: 'invalid_response', terminal: false, retryable: false, message: '新 token 已过期，拒绝落盘', cred };
  }
  if (cred.claims.jti && newClaims.jti === cred.claims.jti) {
    // 服务端没轮换（罕见）：直接按成功处理但明确记录
    log?.info?.('[renew] 服务端返回了同一 jti（未轮换），仍然落盘');
  }

  // 备份旧文件（只保留最近 3 份）
  try {
    const bak = `${cred.tokenFile}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(cred.tokenFile, bak);
    const dir = path.dirname(cred.tokenFile);
    const baks = fs.readdirSync(dir).filter((f) => f.startsWith('token.json.bak-')).sort();
    for (const f of baks.slice(0, Math.max(0, baks.length - 3))) fs.rmSync(path.join(dir, f), { force: true });
  } catch {}

  const plain = `${cred.tenant}:${result.token}`;
  const prevGeneration = Number(cred.meta?.generation) || 0;
  const metaRecord = {
    token: plain,
    tokenIssuedAt: result.tokenIssuedAt,
    tokenExpiresAt: result.tokenExpiresAt,
    absoluteExpiresAt: result.absoluteExpiresAt,
    generation: prevGeneration + 1,
  };
  writeJsonAtomic(cred.tokenFile, {
    version: 1,
    encryptedToken: encryptV10(cred.masterKey, plain),
    encrypted: true,
    scheme: 'safe_storage',
    encryptedMeta: encryptV10(cred.masterKey, JSON.stringify(metaRecord)),
  });

  // 续期痕迹（桌面端放在 renewal-schedule 文件里，这里用自有文件名，语义一致）
  const stateFile = path.join(accountDir(cred.owner), 'app-auth', 'renewal-state.json');
  writeJsonAtomic(stateFile, {
    lastAttemptDay: formatLocalDay(),
    lastSuccessAt: new Date().toISOString(),
    generation: metaRecord.generation,
    tokenExpiresAt: result.tokenExpiresAt,
    absoluteExpiresAt: result.absoluteExpiresAt,
    httpStatus: result.status,
  });

  log?.info?.(`[renew] 成功 ttl=${result.expiresIn}s generation=${metaRecord.generation} 新过期=${new Date(result.tokenExpiresAt).toISOString()}${result.absoluteExpiresAt ? ` 绝对期限=${new Date(result.absoluteExpiresAt).toISOString()}` : ''}`);
  return { ok: true, kind: 'http', status: result.status, cred, meta: metaRecord, stateFile };
}

// ── 状态与调度判定 ──────────────────────────────────────────────────────

/** 只读状态：到期时间、绝对期限、代数、今日是否已尝试。不发任何网络请求。 */
export async function credentialStatus({ ownerOverride = null } = {}) {
  const cred = await readCredential({ ownerOverride });
  const now = Date.now();
  let state = null;
  try { state = readJson(path.join(accountDir(cred.owner), 'app-auth', 'renewal-state.json'), null); } catch {}
  return {
    ownerDir: cred.ownerDir,
    tenant: cred.tenant,
    issuedAt: cred.claims.iat ? new Date(cred.claims.iat * 1000).toISOString() : null,
    expiresAt: cred.claims.exp ? new Date(cred.claims.exp * 1000).toISOString() : null,
    daysLeft: cred.claims.exp ? (cred.claims.exp * 1000 - now) / 86400000 : null,
    absoluteExpiresAt: cred.claims.abs ? new Date(cred.claims.abs * 1000).toISOString() : null,
    absoluteDaysLeft: cred.claims.abs ? (cred.claims.abs * 1000 - now) / 86400000 : null,
    generation: cred.meta?.generation ?? null,
    lastAttemptDay: state?.lastAttemptDay ?? null,
    lastSuccessAt: state?.lastSuccessAt ?? null,
    attemptedToday: state?.lastAttemptDay === formatLocalDay(now),
    handoverBlocked: Boolean(state?.handoverBlocked),
    handoverBlockedAt: state?.handoverBlockedAt ?? null,
    handoverBlockedCategory: state?.handoverBlockedCategory ?? null,
    lastFailureAt: state?.lastFailureAt ?? null,
    lastFailureCategory: state?.lastFailureCategory ?? null,
    lastFailureTerminal: state?.lastFailureTerminal ?? null,
    expired: cred.claims.exp * 1000 <= now,
    absoluteExpired: cred.claims.abs ? cred.claims.abs * 1000 <= now : false,
    tokenFile: cred.tokenFile,
  };
}

/** 默认是否启用自动首续：TA_RENEW_AUTO_HANDOVER=0/false/off/no 关闭，其余（含未设置）开启 */
export function autoHandoverDefault() {
  const v = String(process.env.TA_RENEW_AUTO_HANDOVER ?? '1').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

/**
 * 是否轮到续期：沿用桌面端「按本地日去重」语义（每天最多一次），外加三条防线：
 *   - 首次交接：本实例从未成功续期过（无 lastSuccessAt 痕迹，说明凭据是刚导出/导入的）
 *     且未关闭开关时，自动按 force 处理一次——部署当天就接管会话链，不给 PC 桌面端
 *     在 >21 天空窗期里抢先轮换的机会。撞上终态失败会记 handoverBlocked，不再重试。
 *   - 距上次成功 < 6h 跳过（防 cron/daemon 叠加导致双重轮换）；
 *   - token 剩余 > 21 天且非 --force 且非首次交接时跳过（桌面端无此判断，但桌面端天天
 *     开机轮换，NAS 侧如果不加会跟桌面端抢轮换链；21 天余量足以兜住长期离线的极端情况）。
 * TODO(待实测)：后端是否接受更保守的节奏未知，先用桌面端同款日频 + 21 天余量。
 */
export function shouldRenewNow(status, { force = false, autoHandover = autoHandoverDefault() } = {}) {
  if (force) return { due: true, reason: 'forced' };
  if (status.expired) return { due: true, reason: 'token_expired' };
  if (autoHandover && !status.lastSuccessAt && !status.handoverBlocked && !status.attemptedToday) {
    return { due: true, reason: '首次交接：本实例尚未成功续期过，自动强制续期一次接管会话链（防 PC 抢先轮换作废本凭据；TA_RENEW_AUTO_HANDOVER=0 可关闭）' };
  }
  if (status.daysLeft !== null && status.daysLeft > 21) return { due: false, reason: `token 还剩 ${status.daysLeft.toFixed(1)} 天（>21 天余量），轮换会作废其它持有方，加 --force 才继续` };
  if (status.attemptedToday) return { due: false, reason: `今日（${status.lastAttemptDay}）已尝试过，按桌面端每日一次语义跳过` };
  if (status.lastSuccessAt && Date.now() - Date.parse(status.lastSuccessAt) < SCHEDULE_CHECK_INTERVAL_MS) {
    return { due: false, reason: '距上次成功续期不足 6 小时' };
  }
  return { due: true, reason: '到期窗口内且今日未尝试' };
}
