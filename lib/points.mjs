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
  // 有效期限：汇总层 active[0] 的 effectiveStart/End，以及每笔 subItems 各自的到期日。
  // 每笔积分（每日签到/邀请礼等）独立计算约 30 天有效期，按到期日升序展示（快过期的在前）。
  const allActive = (d.groups ?? []).flatMap((g) => g.active ?? []);
  const summaryActive = allActive.find((a) => a.isAggregated) ?? allActive[0] ?? null;
  const daysLeft = (end) => {
    if (!end) return null;
    const ms = new Date(String(end).replace(' ', 'T')).getTime() - Date.now();
    return Number.isFinite(ms) ? Math.ceil(ms / 86400000) : null;
  };
  const items = allActive
    .flatMap((a) => (a.subItems ?? []).map((s) => {
      const total = Number(s.totalQuota);
      const remain = Number(s.balance);
      return {
        name: s.name,
        balance: s.balance,
        totalQuota: s.totalQuota,
        effectiveStart: s.effectiveStart,
        effectiveEnd: s.effectiveEnd,
        daysLeft: daysLeft(s.effectiveEnd),
        // 剩余积分占总积分比例（0~100），进度条按此填充
        remainPct: total > 0
          ? Math.max(0, Math.min(100, Math.round(remain / total * 100)))
          : null,
        isExpired: Boolean(s.isExpired),
        planCode: s.planCode,
      };
    }))
    .filter((x) => Number(x.balance) > 0 && !x.isExpired)
    .sort((a, b) => String(a.effectiveEnd).localeCompare(String(b.effectiveEnd)));
  return {
    ok: detail?.code === 200,
    balance: d.pointsBalance,
    userRole: d.userRole,
    expiry: summaryActive ? {
      start: summaryActive.effectiveStart,
      end: summaryActive.effectiveEnd,
      daysLeft: daysLeft(summaryActive.effectiveEnd),
    } : null,
    items,
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

async function checkAndSign({ log, tag }) {
  try {
    const s = await getSummary();
    if (!s.ok) return log(`[积分] ${tag}：状态查询失败，跳过`);
    if (s.sign.claimedToday === true) return log(`[积分] ${tag}：今日已领取，跳过`);
    const r = await signIn();
    log(`[积分] ${tag}：${r.alreadyClaimed ? '今日已领取' : '领取成功 +' + (r.gained ?? '') + ' 积分'}`);
  } catch (err) {
    log(`[积分] ${tag}：失败（${err?.message ?? err}）`);
  }
}

/**
 * 自动签到调度器。档位由 getMode() 动态提供（来自管理台运行时配置），改档位即时生效、无需重启：
 *  - 2（默认）：每次启动检查一次，今天没领就顺手领掉。随用随关的场景靠它补领。
 *  - 0：完全关闭（含启动检查与每日定时检查）。
 *  - 1：启动检查 + 每天 00:00:30 定点执行一次（适合长期后台常开，跨天自动领）。
 * 官方 app 也内置了每天 08:13 自动领取；这里是我方等价实现，幂等（claimedToday=true 不重复领）。
 */
export function startAutoSign({ log = () => {}, getMode = () => 2 } = {}) {
  // 启动检查：延迟 20s 避开启动争用；执行时按"当时"档位决定（默认 2 会执行）。
  const bootTimer = setTimeout(() => {
    const m = Number(getMode());
    if (m !== 0) checkAndSign({ log, tag: '启动检查' });
  }, 20_000);
  bootTimer.unref();

  // 常驻 ticker：每 20 秒检查一次，档位 1 且处于 00:00:30~00:00:49 窗口时，
  // 每天定点执行一次（用 lastDaily 记当天日期防止窗口内重复触发）。
  // 用本地时间（toLocaleString 的时区）对齐"每天 0 点"的自然语义。
  let lastDaily = '';
  const ticker = setInterval(() => {
    if (Number(getMode()) !== 1) return;
    const now = new Date();
    if (now.getHours() !== 0 || now.getMinutes() !== 0) return;
    if (now.getSeconds() < 30 || now.getSeconds() > 49) return;
    const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    if (lastDaily === day) return;
    lastDaily = day;
    checkAndSign({ log, tag: '每日定时' });
  }, 20_000);
  ticker.unref();

  return { bootTimer, ticker };
}

export function createPoints() {
  return { getSummary, signIn };
}
