// TeleAgent 积分福利社：查余额 / 查签到状态 / 每日签到领取 100 积分。
//
// 来源：TeleAgent 官方桌面端（app.asar 主 bundle）前端走的同一套接口。
// 鉴权是明文头（不是 Go kernel 的 X-SA 签名），token / deviceId / 版本本地都有。
// 全部只读查询无副作用；signIn() 是唯一会改变服务端状态的动作（每天一次）。
//
// 合规提示：这是模拟官方客户端调用自己的账号领官方每日福利，供本机自用；
// 公开分发时请自行评估 ToS 风险（默认关闭自动签到，见 AUTO_SIGN 环境变量）。
import crypto from 'node:crypto';
import { loadAuthState, deviceMeta } from './auth.mjs';
import { readJson } from './paths.mjs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const BASE = (
  process.env.TA_POINTS_BASE_URL ||
  'https://agent.teleai.com.cn/superCowork/sapi'
).replace(/\/$/, '');

// 接口路径（去掉 /superCowork/sapi 前缀，因为 BASE 已带）
const EP = {
  detail: '/user/portal/points/detail',
  taskV3: '/user/portal/companyStore/v3/checkDayTask',
  taskSimple: '/user/portal/companyStore/checkDayTask',
  checkTask: '/user/portal/companyStore/checkTask',
};

let cachedAuth = null;
let authExpires = 0;

async function getAuth({ force = false } = {}) {
  const now = Date.now();
  if (!force && cachedAuth && now < authExpires) return cachedAuth;
  const owner = readJson(path.join(HOME, '.local', 'share', 'TeleAgent', 'current-owner.json'));
  if (!owner?.ownerDir) throw new Error('TeleAgent 尚未登录（缺少 current-owner.json）');
  const tokenFile = path.join(HOME, '.local', 'share', 'TeleAgent', 'users', owner.ownerDir, 'app-auth', 'token.json');
  const { token, claims } = await loadAuthState({ tokenFile });
  const dev = deviceMeta();
  const ver = readJson(path.join(HOME, '.local', 'share', 'TeleAgent', 'runtimes', '.version.json'), {});
  const expMs = typeof claims?.exp === 'number' ? claims.exp * 1000 - 60_000 : now + 10 * 60_000;
  cachedAuth = { token, deviceId: dev.deviceId || '', appVersion: ver.superAgentCode || '' };
  authExpires = expMs > now ? expMs : now + 10 * 60_000;
  return cachedAuth;
}

async function api(ep, { method = 'GET', timeoutMs = 15000 } = {}) {
  const a = await getAuth();
  const headers = {
    'Content-Type': 'application/json',
    'X-Timestamp': String(Math.floor(Date.now() / 1000)),
    'X-Nonce': crypto.randomUUID(),
    'X-App-Version': a.appVersion,
    'X-OS-Type': process.platform === 'win32' ? 'windows' : process.platform,
    'X-SuperAgent-Device-Id': a.deviceId,
    'X-Token': a.token,
    'X-Channel-Id': process.env.TA_POINTS_CHANNEL_ID || '',
    'X-Runtime-Env': process.env.TA_POINTS_RUNTIME_ENV || '',
  };
  const url = ep.startsWith('http') ? ep : BASE + ep;
  const res = await fetch(url, { method, headers, signal: AbortSignal.timeout(timeoutMs) });
  let body;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) throw new Error(`积分接口 HTTP ${res.status}: ${JSON.stringify(body)?.slice(0, 200)}`);
  return body;
}

/** 查余额 + 签到状态（只读，两个接口并行） */
export async function getSummary() {
  const [detail, task] = await Promise.all([
    api(EP.detail),
    api(EP.taskSimple).catch(() => null),
  ]);
  const d = detail?.data ?? {};
  const t = task?.data ?? {};
  const groups = (d.groups ?? []).map((g) => ({
    type: g.type, typeName: g.typeName, totalQuota: g.totalQuota,
    usedQuota: g.usedQuota, balance: g.balance, effectiveEnd: g.effectiveEnd,
  }));
  return {
    ok: detail?.code === 200,
    balance: d.pointsBalance,
    userRole: d.userRole,
    groups,
    sign: {
      dailyClaimable: t.daily_claimable_points,
      totalDays: t.total_claim_days,
      totalClaimed: t.total_claimed_points,
      claimedToday: t.claimed_today,
    },
  };
}

/**
 * 每日签到领取积分。流程与官方前端一致：先从 v3/checkDayTask 找
 * action_status=incomplete 且 action_type=api 的项，取其 jump_url，
 * 去掉 /superCowork/sapi 前缀后 GET。幂等：claimedToday 时不重复请求。
 */
export async function signIn() {
  const pre = await getSummary();
  if (!pre.ok) throw new Error('无法获取签到状态，请稍后重试');
  if (pre.sign.claimedToday) return { ok: true, alreadyClaimed: true, points: pre.sign.dailyClaimable, summary: pre };

  const v3 = await api(EP.taskV3);
  const items = v3?.data?.activity_data ?? [];
  const task = items.find((x) => x.action_type === 'api' && x.action_status === 'incomplete' && x.jump_url);
  if (!task) return { ok: true, alreadyClaimed: true, points: pre.sign.dailyClaimable, summary: await getSummary() };

  let jump = task.jump_url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/superCowork\/sapi/, '');
  if (!jump.startsWith('/')) throw new Error('签到链接格式异常，已拒绝请求');
  const before = pre.balance;
  await api(jump);
  const summary = await getSummary();
  const gained = typeof summary.balance === 'number' && typeof before === 'number'
    ? Math.round((summary.balance - before) * 100) / 100 : 0;
  return { ok: true, alreadyClaimed: false, gained, summary };
}

/**
 * 可选：后台自动签到。默认关闭（TA_AUTO_SIGN=1 开启）。
 * 官方 app 已内置每天 08:13 的自动领取技能，这里提供代理侧等价实现，供不用官方 UI 的场景。
 * 每小时检查一次，claimedToday=false 才领；领取记录写日志，失败不重试（避免刷接口）。
 */
export function startAutoSign({ log = () => {} } = {}) {
  if (process.env.TA_AUTO_SIGN !== '1') return null;
  const timer = setInterval(async () => {
    try {
      const s = await getSummary();
      if (s.ok && s.sign.claimedToday === false) {
        const r = await signIn();
        log(`[积分] 自动签到完成：${r.alreadyClaimed ? '今日已领' : '领取成功 +' + (r.gained ?? '')}`);
      }
    } catch (err) {
      log(`[积分] 自动签到失败：${err?.message ?? err}`);
    }
  }, 60 * 60 * 1000);
  timer.unref();
  // 启动后延迟 20s 先查一次，避免和启动争用
  const first = setTimeout(() => {
    (async () => {
      try {
        const s = await getSummary();
        if (s.ok && s.sign.claimedToday === false) {
          const r = await signIn();
          log(`[积分] 自动签到完成（启动检查）：${r.alreadyClaimed ? '今日已领' : '领取成功 +' + (r.gained ?? '')}`);
        }
      } catch (err) { log(`[积分] 自动签到失败：${err?.message ?? err}`); }
    })();
  }, 20_000);
  first.unref();
  return timer;
}

export function createPoints() {
  return { getSummary, signIn };
}
