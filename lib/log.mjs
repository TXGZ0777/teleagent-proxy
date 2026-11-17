// 控制台日志统一带本地时间戳。
// 格式与内核日志（super-agent-server-*.log 的 2026/11/17 01:38:42）保持一致，
// 便于把代理输出和内核日志按时间对表排障。
const pad = (n, w = 2) => String(n).padStart(w, '0');

export function stamp() {
  const d = new Date();
  return (
    `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

export function log(...args) {
  console.log(`[${stamp()}]`, ...args);
}

export function warn(...args) {
  console.warn(`[${stamp()}]`, ...args);
}

export function error(...args) {
  console.error(`[${stamp()}]`, ...args);
}
