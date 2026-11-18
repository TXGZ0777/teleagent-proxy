// TeleAgent 登录态续期 CLI（Linux/Windows 通用；协议实现在 lib/renew.mjs）
//
// 用法：
//   node tools/renew-credentials.mjs status              # 只读：看凭据到期/代数/今日是否已试
//   node tools/renew-credentials.mjs once [--force]      # 到期判定 + 续期一次（cron/systemd timer 用这个）
//   node tools/renew-credentials.mjs once --dry-run      # 只打印将发出的请求头，不发请求
//   node tools/renew-credentials.mjs daemon              # 常驻：启动补偿 + 每 6h 检查（桌面端同款节奏）
//
// 环境：
//   TA_CRYPT_KEY         必填（非 Windows）：PC 导出的 32B 主密钥 base64（tools/export-credentials.mjs）
//   TA_DEVICE_DATA_ROOT  数据根目录（默认 ~/.local/share/TeleAgent，NAS 上指向导出包挂载点）
//   TA_REFRESH_BASE_URL  默认 https://agent-pre.teleai.com.cn/superCowork/sapi（桌面端 bundle 原值）
//   TA_OS_TYPE           默认 Windows（对齐签发设备；留空发桌面端原值）
//   TA_APP_VERSION       默认从导出包 ta-export-meta.json / runtimes/.version.json 取
//   TA_BG_ENV            有值才附加 teleagent 路由头（桌面端 BG_ENV 语义）
//
// 退出码（once）：0 成功或未到期跳过；1 瞬时失败（可重试）；2 终态失败（需重新导出凭据）。
import process from 'node:process';
import { renewCredential, credentialStatus, shouldRenewNow } from '../lib/renew.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'status';
const flags = new Set(argv.filter((a) => a.startsWith('-')));
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const log = {
  info: (...a) => console.log(...a),
  warn: (...a) => console.warn(...a),
};

async function main() {
  if (cmd === 'status') {
    const s = await credentialStatus();
    log.info(`owner          : ${s.ownerDir}`);
    log.info(`tenant         : ${s.tenant || '-'}`);
    log.info(`token 签发     : ${s.issuedAt ?? '-'}`);
    log.info(`token 过期     : ${s.expiresAt ?? '-'}（剩余 ${s.daysLeft?.toFixed(1) ?? '?'} 天）`);
    log.info(`绝对期限 (abs) : ${s.absoluteExpiresAt ?? '-'}（剩余 ${s.absoluteDaysLeft?.toFixed(1) ?? '?'} 天）`);
    log.info(`generation     : ${s.generation ?? '-'}`);
    log.info(`今日已尝试     : ${s.attemptedToday ? '是' : '否'}${s.lastSuccessAt ? `（上次成功 ${s.lastSuccessAt}）` : ''}`);
    log.info(`token 文件     : ${s.tokenFile}`);
    const v = shouldRenewNow(s, { force: flags.has('--force') });
    log.info(`续期判定       : ${v.due ? '到期' : '跳过'} — ${v.reason}`);
    if (s.absoluteExpired) {
      log.warn('!! 会话 90 天绝对期限已过：续期链已死，需在 PC 重新登录后重新导出凭据');
      process.exitCode = 2;
    }
    return;
  }

  if (cmd === 'once') {
    const dryRun = flags.has('--dry-run');
    const s = await credentialStatus();
    // dry-run 不发请求、不落盘，跳过到期护栏直接预览（否则 >21 天余量时永远看不到请求长什么样）
    const verdict = dryRun
      ? { due: true, reason: 'dry-run 预览（不发请求、不落盘）' }
      : shouldRenewNow(s, { force: flags.has('--force') });
    log.info(`[schedule] ${verdict.due ? '到期' : '跳过'} — ${verdict.reason}`);
    if (!verdict.due) return;
    const result = await renewCredential({ log, dryRun });
    if (result.ok) return;
    if (dryRun) {
      log.info('[dry-run] 将发送：');
      for (const [k, v] of Object.entries(result.headers)) log.info(`  ${k}: ${k === 'X-Token' ? `${String(v).slice(0, 24)}…(已截断)` : v}`);
      return;
    }
    if (result.terminal) {
      log.warn(`[renew] 终态失败（${result.category}）：会话已死。到 PC 重新登录 TeleAgent 后重新跑 tools/export-credentials.mjs。`);
      process.exitCode = 2;
    } else {
      process.exitCode = 1;
    }
    return;
  }

  if (cmd === 'daemon') {
    const { SCHEDULE_CHECK_INTERVAL_MS } = await import('../lib/renew.mjs');
    const tick = async (reason) => {
      try {
        const s = await credentialStatus();
        const v = shouldRenewNow(s);
        log.info(`[daemon:${reason}] ${v.due ? '到期' : '跳过'} — ${v.reason}`);
        if (!v.due) return;
        const r = await renewCredential({ log });
        if (r.terminal) log.warn('[daemon] 终态失败：会话已死，daemon 继续空转（每 6h 重试一次终态判断），请重新导出凭据');
      } catch (error) {
        log.warn(`[daemon:${reason}] 异常：${error?.message ?? error}`);
      }
    };
    await tick('startup'); // 桌面端启动补偿语义
    const timer = setInterval(() => void tick('timer'), SCHEDULE_CHECK_INTERVAL_MS); // 6h 定时器
    for (const sig of ['SIGINT', 'SIGTERM']) {
      process.once(sig, () => { clearInterval(timer); log.info('[daemon] 退出'); process.exit(0); });
    }
    return;
  }

  console.error(`未知子命令：${cmd}（可用：status | once | daemon）`);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[renew] 致命错误：${error?.message ?? error}`);
  process.exitCode = 1;
});
