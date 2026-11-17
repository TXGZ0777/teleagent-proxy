// 统一日志：控制台 + 内存环形缓冲 + 可选落盘。
// 时间戳格式与内核日志（super-agent-server-*.log）一致，便于对表排障。
// 静默启动（start.vbs）没有终端，落盘 + 管理台网页是主要排障入口。
import fs from 'node:fs';
import path from 'node:path';

const pad = (n, w = 2) => String(n).padStart(w, '0');

export function stamp() {
  const d = new Date();
  return (
    `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

const MAX_LINES = 500; // 内存环形缓冲上限
const ring = [];
let logFile = null; // 由 server 启动时通过 setLogFile 设置

export function setLogFile(file) {
  logFile = file;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 每次进程启动写一行分隔，避免多轮日志混在一起难分辨
    fs.appendFileSync(file, `\n===== proxy started ${stamp()} pid=${process.pid} =====\n`);
  } catch {}
}

export function getLogs(n = 200) {
  const count = Math.max(1, Math.min(Number(n) || 200, MAX_LINES));
  return ring.slice(-count);
}

function emit(level, args) {
  const line = `[${stamp()}] [${level}] ${args.map(stringify).join(' ')}`;
  ring.push(line);
  if (ring.length > MAX_LINES) ring.splice(0, ring.length - MAX_LINES);
  // 控制台保持原来的时间戳格式（不带 [level] 也行，但带上更清晰）
  const consoleFn = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
  consoleFn(`[${stamp()}]`, ...args);
  if (logFile) {
    try { fs.appendFileSync(logFile, line + '\n'); } catch {}
  }
}

function stringify(v) {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return `${v.message}${v.stack ? '\n' + v.stack : ''}`;
  try { return JSON.stringify(v); } catch { return String(v); }
}

export function log(...args) { emit('INFO', args); }
export function warn(...args) { emit('WARN', args); }
export function error(...args) { emit('ERROR', args); }
