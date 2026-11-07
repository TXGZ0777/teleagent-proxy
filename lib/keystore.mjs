// API Key 存储：生成、校验、批量管理、用量统计
//
// 只落本地 JSON（默认 runtime/config/api-keys.json，可用 TA_KEYS_FILE 改），
// 服务端不引入数据库，便于随时查看/备份/迁移。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const KEY_PREFIX = 'ta-sk-';
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const MAX_LOG = 200;
const KEEP_DAILY_DAYS = 30;

function randomKeyBody(len = 32) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

function newId() {
  return crypto.randomBytes(5).toString('hex');
}

function todayKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 展示用掩码：保留前缀与尾 4 位 */
export function maskKey(key) {
  if (typeof key !== 'string' || key.length < 14) return '***';
  return `${key.slice(0, 9)}…${key.slice(-4)}`;
}

function emptyState() {
  return { version: 1, settings: { requireAuth: 'auto' }, keys: [], daily: {}, log: [] };
}

export class KeyStore {
  constructor({ file }) {
    this.file = file;
    this.saveTimer = null;
    this.state = this.#load();
    this.startedAt = Date.now();
  }

  #load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      const state = { ...emptyState(), ...parsed };
      state.settings = { requireAuth: 'auto', ...(parsed.settings ?? {}) };
      state.keys = Array.isArray(parsed.keys) ? parsed.keys : [];
      state.daily = parsed.daily && typeof parsed.daily === 'object' ? parsed.daily : {};
      state.log = Array.isArray(parsed.log) ? parsed.log : [];
      return state;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // 文件损坏：留一份备份再从空状态起步，避免用户数据被静默覆盖
        try {
          fs.copyFileSync(this.file, `${this.file}.broken-${Date.now()}`);
        } catch {}
      }
      return emptyState();
    }
  }

  #save() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  /** 高频写入（每次调用都要记一笔）做 500ms 合并，避免磁盘抖动 */
  #saveSoon() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        this.#save();
      } catch {}
    }, 500);
    this.saveTimer.unref?.();
  }

  /** 进程退出前把未落盘的用量刷掉 */
  flush() {
    if (this.saveTimer) this.#save();
  }

  get settings() {
    return this.state.settings;
  }

  activeCount() {
    const now = Date.now();
    return this.state.keys.filter((k) => k.enabled && !isExpired(k, now)).length;
  }

  /** 服务端是否必须校验 key（供 shim/管理台展示） */
  required(staticKey) {
    if (staticKey) return true;
    const mode = this.state.settings.requireAuth;
    if (mode === 'on') return true;
    if (mode === 'off') return false;
    // auto：只要密钥表非空就必须带 key —— 否则把密钥全部停用会意外重新打开匿名访问
    return this.state.keys.length > 0;
  }

  list() {
    const now = Date.now();
    const day = todayKey(now);
    return [...this.state.keys]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((k) => ({
        id: k.id,
        name: k.name,
        note: k.note ?? '',
        key: k.key,
        masked: maskKey(k.key),
        enabled: k.enabled !== false,
        status: statusOf(k, now),
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt ?? null,
        requestCount: k.requestCount ?? 0,
        todayRequests: k.daily?.[day] ?? 0,
        tokenIn: k.tokenIn ?? 0,
        tokenOut: k.tokenOut ?? 0,
        expiresAt: k.expiresAt ?? null,
      }));
  }

  create({ name, note = '', count = 1, expiresInDays = 0 } = {}) {
    const n = Math.min(Math.max(Number(count) || 1, 1), 50);
    const now = Date.now();
    const baseName = String(name ?? '').trim() || '未命名密钥';
    const made = [];
    for (let i = 0; i < n; i += 1) {
      const record = {
        id: newId(),
        name: n > 1 ? `${baseName} #${i + 1}` : baseName,
        note: String(note ?? ''),
        key: KEY_PREFIX + randomKeyBody(),
        enabled: true,
        createdAt: now,
        lastUsedAt: null,
        requestCount: 0,
        tokenIn: 0,
        tokenOut: 0,
        expiresAt: Number(expiresInDays) > 0 ? now + Number(expiresInDays) * 86400000 : null,
        daily: {},
      };
      this.state.keys.push(record);
      made.push(record);
    }
    this.#save();
    return made.map((k) => ({ ...k, masked: maskKey(k.key), status: 'active' }));
  }

  update(id, patch = {}) {
    const key = this.state.keys.find((k) => k.id === id);
    if (!key) return null;
    if (typeof patch.name === 'string' && patch.name.trim()) key.name = patch.name.trim().slice(0, 80);
    if (typeof patch.note === 'string') key.note = patch.note.slice(0, 500);
    if (typeof patch.enabled === 'boolean') key.enabled = patch.enabled;
    if (patch.expiresInDays !== undefined) {
      const days = Number(patch.expiresInDays) || 0;
      key.expiresAt = days > 0 ? Date.now() + days * 86400000 : null;
    }
    this.#save();
    return key;
  }

  remove(ids = []) {
    const set = new Set(ids);
    const before = this.state.keys.length;
    this.state.keys = this.state.keys.filter((k) => !set.has(k.id));
    const removed = before - this.state.keys.length;
    if (removed) this.#save();
    return removed;
  }

  /** 批量操作：enable / disable / delete / reset */
  bulk(action, ids = []) {
    const set = new Set(ids);
    const targets = this.state.keys.filter((k) => set.has(k.id));
    let affected = 0;
    if (action === 'enable' || action === 'disable') {
      for (const k of targets) {
        k.enabled = action === 'enable';
        affected += 1;
      }
    } else if (action === 'delete') {
      return { affected: this.remove(ids) };
    } else if (action === 'reset') {
      for (const k of targets) {
        k.requestCount = 0;
        k.tokenIn = 0;
        k.tokenOut = 0;
        k.daily = {};
        k.lastUsedAt = null;
        affected += 1;
      }
    } else {
      return { affected: 0, error: 'unknown action' };
    }
    if (affected) this.#save();
    return { affected };
  }

  setSettings(patch = {}) {
    if (['auto', 'on', 'off'].includes(patch.requireAuth)) {
      this.state.settings.requireAuth = patch.requireAuth;
      this.#save();
    }
    return this.state.settings;
  }

  /** 校验客户端带来的明文 key：返回 { ok, record?, reason? } */
  verify(raw) {
    const given = String(raw ?? '').trim();
    if (!given) return { ok: false, reason: 'missing' };
    const buf = Buffer.from(given);
    let hit = null;
    for (const k of this.state.keys) {
      const cand = Buffer.from(k.key);
      if (cand.length !== buf.length) continue;
      if (crypto.timingSafeEqual(cand, buf)) {
        hit = k;
        break;
      }
    }
    if (!hit) return { ok: false, reason: 'unknown' };
    if (hit.enabled === false) return { ok: false, reason: 'disabled', record: hit };
    if (isExpired(hit)) return { ok: false, reason: 'expired', record: hit };
    return { ok: true, record: hit };
  }

  /** 记一次调用（由 shim 在响应收尾时调用） */
  record({ keyId = null, model = '', protocol = '', stream = false, status = 0, ms = 0, tokens = null } = {}) {
    const now = Date.now();
    const day = todayKey(now);
    const tokenTotal = (tokens?.input ?? 0) + (tokens?.output ?? 0);

    const daily = this.state.daily[day] ?? { requests: 0, tokens: 0 };
    daily.requests += 1;
    daily.tokens += tokenTotal;
    this.state.daily[day] = daily;

    const key = keyId ? this.state.keys.find((k) => k.id === keyId) : null;
    if (key) {
      key.requestCount = (key.requestCount ?? 0) + 1;
      key.lastUsedAt = now;
      key.daily = key.daily ?? {};
      key.daily[day] = (key.daily[day] ?? 0) + 1;
      key.tokenIn = (key.tokenIn ?? 0) + (tokens?.input ?? 0);
      key.tokenOut = (key.tokenOut ?? 0) + (tokens?.output ?? 0);
      // 只保留最近 30 天
      const keep = new Set(Object.keys(key.daily).sort().slice(-KEEP_DAILY_DAYS));
      for (const d of Object.keys(key.daily)) if (!keep.has(d)) delete key.daily[d];
    }

    this.state.log.unshift({
      ts: now,
      keyId,
      keyName: key?.name ?? (keyId ? '已删除的密钥' : '匿名调用'),
      model,
      protocol,
      stream: Boolean(stream),
      status,
      ms,
      tokens: tokenTotal,
    });
    if (this.state.log.length > MAX_LOG) this.state.log.length = MAX_LOG;

    const days = new Set(Object.keys(this.state.daily).sort().slice(-KEEP_DAILY_DAYS));
    for (const d of Object.keys(this.state.daily)) if (!days.has(d)) delete this.state.daily[d];

    this.#saveSoon();
  }

  stats() {
    const keys = this.state.keys;
    const day = todayKey();
    const now = Date.now();
    const totalRequests = keys.reduce((s, k) => s + (k.requestCount ?? 0), 0);
    const daily = [];
    for (let i = 13; i >= 0; i -= 1) {
      const d = new Date(now - i * 86400000);
      const label = todayKey(d.getTime());
      const rec = this.state.daily[label] ?? { requests: 0, tokens: 0 };
      daily.push({ date: label, requests: rec.requests ?? 0, tokens: rec.tokens ?? 0 });
    }
    return {
      totalKeys: keys.length,
      activeKeys: keys.filter((k) => k.enabled !== false && !isExpired(k, now)).length,
      disabledKeys: keys.filter((k) => k.enabled === false).length,
      expiredKeys: keys.filter((k) => isExpired(k, now)).length,
      totalRequests,
      todayRequests: this.state.daily[day]?.requests ?? 0,
      todayTokens: this.state.daily[day]?.tokens ?? 0,
      daily,
      recent: this.state.log.slice(0, 30),
    };
  }
}

function isExpired(k, now = Date.now()) {
  return Boolean(k.expiresAt && k.expiresAt < now);
}

function statusOf(k, now) {
  if (k.enabled === false) return 'disabled';
  if (isExpired(k, now)) return 'expired';
  return 'active';
}

export function createKeyStore({ file }) {
  const resolved = file || path.join(process.cwd(), 'runtime', 'config', 'api-keys.json');
  return new KeyStore({ file: resolved });
}
