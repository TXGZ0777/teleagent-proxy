// 管理台：/admin 静态页 + /admin/api/* 管理接口
//
// 安全约束：
//   1. 只接受回环地址（服务本身也只绑 127.0.0.1，这里是第二道闸）
//   2. 设了 TA_ADMIN_TOKEN 时，所有管理接口都要带 token（Authorization / x-admin-token / ?token=）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLogs, log, warn } from './log.mjs';
import { credentialStatus, renewCredential, DEFAULT_REFRESH_BASE_URL } from './renew.mjs';
import { importLoginToken } from './session-import.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_HTML = path.join(here, '..', 'web', 'admin.html');

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function isLoopback(req) {
  const addr = req.socket?.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function tokenOf(req) {
  const auth = req.headers.authorization ?? '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const header = req.headers['x-admin-token'];
  if (header) return String(header).trim();
  const url = new URL(req.url, 'http://127.0.0.1');
  return url.searchParams.get('token') ?? '';
}

/**
 * @param {object} args
 * @param {import('./keystore.mjs').KeyStore} args.keystore
 * @param {() => object} args.info 网关状态（地址、模型、kernel、鉴权模式）
 * @param {string|null} args.adminToken
 * @param {object|null} args.runtimeConfig 运行时配置（可即时改+持久化）
 */
export function createAdmin({ keystore, info, adminToken = null, runtimeConfig = null, points = null }) {
  let html = null;
  try {
    html = fs.readFileSync(ADMIN_HTML, 'utf8');
  } catch {
    html = '<!doctype html><meta charset="utf-8"><h1>管理页缺失</h1><p>找不到 web/admin.html</p>';
  }

  // 远程管理台：TA_ADMIN_ALLOW_REMOTE=1 且已设置管理令牌时才放行局域网访问。
  // 「放行远程 + 无令牌」是危险组合（管理台能改密钥、导入凭据）——自动退回仅回环并告警。
  const remoteOk = process.env.TA_ADMIN_ALLOW_REMOTE === '1' && Boolean(adminToken);
  if (process.env.TA_ADMIN_ALLOW_REMOTE === '1' && !adminToken) {
    warn('TA_ADMIN_ALLOW_REMOTE=1 但未设置 TA_ADMIN_TOKEN：管理台保持仅回环访问，局域网请求将 403。');
  }

  // 手动续期串行化：同时只允许一个 renewCredential 在跑。与 renew 容器的守护互不冲突——
  // 双方都走 renewal-state.json 的「每日一次」留痕，不会双重轮换。
  let renewing = null;
  function runRenew() {
    if (renewing) return Promise.resolve({ ok: false, kind: 'busy', message: '已有一个续期在进行中，请稍候' });
    renewing = renewCredential({ log: { info: (...a) => log(...a), warn: (...a) => warn(...a) } });
    return renewing.finally(() => { renewing = null; });
  }

  const snapshot = () => ({
    gateway: info(),
    settings: keystore.settings,
    stats: keystore.stats(),
    keys: keystore.list(),
    runtime: runtimeConfig ? runtimeConfig.all() : null,
  });

  return async function handleAdmin(req, res, pathname) {
    if (!isLoopback(req) && !remoteOk) {
      json(res, 403, { error: '管理台仅允许本机访问（远程访问需 TA_ADMIN_ALLOW_REMOTE=1 且已设置 TA_ADMIN_TOKEN）' });
      return true;
    }

    const isApi = pathname.startsWith('/admin/api/');
    if (adminToken && isApi && tokenOf(req) !== adminToken) {
      json(res, 401, { error: '需要管理令牌', needToken: true });
      return true;
    }

    // ---- 页面 ----
    if (!isApi) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
        'content-length': Buffer.byteLength(html),
      });
      res.end(html);
      return true;
    }

    if (req.method === 'GET' && pathname === '/admin/api/state') {
      json(res, 200, snapshot());
      return true;
    }

    // 运行日志（内存环形缓冲，最新在后）；?n= 控制条数，默认 200，上限 500
    if (req.method === 'GET' && pathname === '/admin/api/logs') {
      const n = Number(new URL(req.url, 'http://127.0.0.1').searchParams.get('n') ?? 200);
      json(res, 200, { lines: getLogs(Number.isFinite(n) ? n : 200) });
      return true;
    }

    // 积分福利社：查余额/签到状态（只读）
    if (req.method === 'GET' && pathname === '/admin/api/points') {
      if (!points) { json(res, 200, { enabled: false }); return true; }
      try {
        const data = await points.getSummary();
        const autoSign = runtimeConfig ? Number(runtimeConfig.get('autoSign')) : 2;
        const usageFootnote = runtimeConfig ? Boolean(runtimeConfig.get('usageFootnote')) : false;
        json(res, 200, { enabled: true, autoSign, usageFootnote, ...data });
      }
      catch (err) { json(res, 200, { enabled: true, ok: false, error: String(err?.message ?? err) }); }
      return true;
    }

    // 每日签到领取积分（唯一有副作用的接口；幂等）
    if (req.method === 'POST' && pathname === '/admin/api/points/sign') {
      if (!points) { json(res, 200, { enabled: false }); return true; }
      try { json(res, 200, { enabled: true, ...(await points.signIn()) }); }
      catch (err) { json(res, 200, { enabled: true, ok: false, error: String(err?.message ?? err) }); }
      return true;
    }

    // 积分用量：官方按次消耗记录 + 总览（只读）
    if (req.method === 'GET' && pathname === '/admin/api/points/usage') {
      if (!points?.getUsageRecords) { json(res, 200, { enabled: false }); return true; }
      try {
        const q = new URL(req.url, 'http://127.0.0.1').searchParams;
        const page = Number(q.get('page') ?? 1);
        const [records, overview] = await Promise.all([
          points.getUsageRecords({ page: Number.isFinite(page) ? page : 1 }),
          points.getUsageOverview().catch(() => null),
        ]);
        json(res, 200, { enabled: true, ok: records.ok, ...records, overview });
      }
      catch (err) { json(res, 200, { enabled: true, ok: false, error: String(err?.message ?? err) }); }
      return true;
    }

    if (req.method === 'POST' && pathname === '/admin/api/keys') {
      const body = await readJsonBody(req).catch(() => null);
      if (!body) {
        json(res, 400, { error: '请求体不是合法 JSON' });
        return true;
      }
      const name = String(body.name ?? '').trim();
      const created = keystore.create({
        name,
        note: String(body.note ?? ''),
        count: body.count,
        expiresInDays: body.expiresInDays,
      });
      json(res, 200, { created, state: snapshot() });
      return true;
    }

    const bulkMatch = pathname.match(/^\/admin\/api\/keys\/bulk$/);
    if (bulkMatch && req.method === 'POST') {
      const body = await readJsonBody(req).catch(() => null);
      if (!body) {
        json(res, 400, { error: '请求体不是合法 JSON' });
        return true;
      }
      const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string') : [];
      if (!ids.length) {
        json(res, 400, { error: '未选择任何密钥' });
        return true;
      }
      const result = keystore.bulk(String(body.action ?? ''), ids);
      if (result.error) {
        json(res, 400, result);
        return true;
      }
      json(res, 200, { ...result, state: snapshot() });
      return true;
    }

    const oneMatch = pathname.match(/^\/admin\/api\/keys\/([A-Za-z0-9_-]+)$/);
    if (oneMatch) {
      const id = oneMatch[1];
      if (req.method === 'PATCH' || req.method === 'PUT') {
        const body = await readJsonBody(req).catch(() => null);
        if (!body) {
          json(res, 400, { error: '请求体不是合法 JSON' });
          return true;
        }
        const updated = keystore.update(id, body);
        if (!updated) {
          json(res, 404, { error: '密钥不存在' });
          return true;
        }
        json(res, 200, { state: snapshot() });
        return true;
      }
      if (req.method === 'DELETE') {
        const removed = keystore.remove([id]);
        if (!removed) {
          json(res, 404, { error: '密钥不存在' });
          return true;
        }
        json(res, 200, { removed, state: snapshot() });
        return true;
      }
    }

    if (req.method === 'POST' && pathname === '/admin/api/settings') {
      const body = await readJsonBody(req).catch(() => null);
      if (!body) {
        json(res, 400, { error: '请求体不是合法 JSON' });
        return true;
      }
      keystore.setSettings(body);
      json(res, 200, { state: snapshot() });
      return true;
    }

    // ---- 会话 / 登录：凭据状态、浏览器登录导入、手动续期 ----
    // 状态只读不发网络请求；导入只写本地数据根；续期才调上游（可能耗时约 1 分钟）。

    if (req.method === 'GET' && pathname === '/admin/api/session') {
      const base = process.env.TA_REFRESH_BASE_URL?.trim() || DEFAULT_REFRESH_BASE_URL;
      let loginUrl = null;
      try { loginUrl = new URL('/meter/teleagent-login/login', base).href; } catch { /* base 非法时不给链接 */ }
      try {
        json(res, 200, { ok: true, session: await credentialStatus(), renewBase: base, loginUrl });
      } catch (err) {
        json(res, 200, { ok: false, error: String(err?.message ?? err), renewBase: base, loginUrl });
      }
      return true;
    }

    if (req.method === 'POST' && pathname === '/admin/api/session/import') {
      const body = await readJsonBody(req).catch(() => null);
      if (!body) {
        json(res, 400, { error: '请求体不是合法 JSON' });
        return true;
      }
      const result = await importLoginToken({ raw: String(body.raw ?? ''), dryRun: body.dryRun === true });
      const renewed = result.ok && !result.dryRun && body.thenRenew === true ? await runRenew() : null;
      json(res, 200, { result, renewed });
      return true;
    }

    if (req.method === 'POST' && pathname === '/admin/api/session/renew') {
      json(res, 200, { result: await runRenew() });
      return true;
    }

    // 运行时配置：改完即时生效（同步回 process.env）并持久化，重启保留
    if (req.method === 'POST' && pathname === '/admin/api/runtime') {
      if (!runtimeConfig) {
        json(res, 404, { error: '运行时配置未启用' });
        return true;
      }
      const body = await readJsonBody(req).catch(() => null);
      if (!body) {
        json(res, 400, { error: '请求体不是合法 JSON' });
        return true;
      }
      if (body.reset === true) runtimeConfig.reset(body.names ?? []);
      else runtimeConfig.update(body);
      json(res, 200, { state: snapshot() });
      return true;
    }

    json(res, 404, { error: `not found: ${req.method} ${pathname}` });
    return true;
  };
}
