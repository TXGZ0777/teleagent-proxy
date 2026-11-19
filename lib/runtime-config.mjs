// 运行时配置：可在管理台即时修改并持久化到 JSON，重启后保留。
//
// 优先级：配置文件 > process.env > 代码默认值。
//   - 管理台改的值写进配置文件，立即对后续请求生效（读取方每次请求都读内存缓存）；
//   - 未改过的项回落到 start.cmd 里的环境变量（保持向后兼容）。
//
// 文件默认 runtime/config/runtime.json（TA_RUNTIME_CONFIG_FILE 可改）。
import fs from 'node:fs';
import path from 'node:path';

// 每项：默认值 + 环境变量名 + 类型。bool 接受 true/false/1/0/on/off。
export const SCHEMA = {
  autoRetry:      { key: 'TA_AUTO_RETRY',          type: 'bool', def: true,   label: '静默自动续接',  desc: '上游静默且未输出正文时，自动重建会话续接一次（免手动重试）' },
  recycleAt:      { key: 'TA_RECYCLE_CACHE_CHARS',  type: 'num',  def: 200000, label: '会话回收阈值',  desc: '会话缓存 token 超过此值即主动重建（仅作膨胀兜底；0 关闭）' },
  retryIdleMs:    { key: 'TA_RETRY_IDLE_MS',        type: 'num',  def: 120000, label: '续接看门狗(ms)', desc: '自动续接那一次的流空闲超时；比常规短，避免超过客户端超时' },
  streamIdleMs:   { key: 'TA_STREAM_IDLE_MS',      type: 'num',  def: 240000, label: '常规看门狗(ms)', desc: '常规轮的流空闲超时；0 关闭' },
  archiveMinChars:{ key: 'TA_ARCHIVE_MIN_CHARS',   type: 'num',  def: 12000,  label: '存档触发字符',  desc: '首轮历史超此字符数即落盘存档+摘要；设极大值关闭' },
  recentChars:    { key: 'TA_RECENT_CHARS',        type: 'num',  def: 10000,  label: '近期消息字符',  desc: '存档后每轮携带的最近消息字符数' },
  compactMaxChars:{ key: 'TA_COMPACT_MAX_CHARS',   type: 'num',  def: 120000, label: '总结轮折叠上限', desc: '无工具总结请求（compact）豁免存档模式后的折叠字符上限，把真实历史交给总结' },
  // 自动签到三档：2=启动检查一次(默认) / 0=关闭 / 1=启动检查+每天00:00:30定时
  autoSign:       { key: 'TA_AUTO_SIGN',           type: 'enum', def: 2,      label: '自动签到',      desc: '2=启动时检查一次、没领就领（默认）；0=关闭；1=启动检查+每天00:00:30定时领', options: [['2','启动检查一次'],['0','关闭'],['1','启动+每天0点']] },
  // 回复末尾追加"（本次消耗 X 积分）"：默认关闭，最多等 3 秒查官方用量记录，查不到就不加。
  usageFootnote:  { key: 'TA_USAGE_FOOTNOTE',      type: 'bool', def: false,  label: '回复显示积分',  desc: '在模型回复末尾追加本次积分消耗（默认关，会延迟回复；工具调用轮不加）' },
  footnoteWaitMs: { key: 'TA_FOOTNOTE_WAIT_MS',    type: 'num',  def: 3000,   label: '尾注等待(ms)',  desc: '开启尾注后最多等多少毫秒查官方记录；官方写入常延迟 3-5 秒，取不到就不加' },
};

function coerce(value, type, fallback, spec) {
  if (value === undefined || value === null || value === '') return fallback;
  if (type === 'enum') {
    const allowed = (spec?.options ?? []).map((o) => Number(o[0]));
    const n = Number(value);
    return allowed.includes(n) ? n : fallback;
  }
  if (type === 'bool') {
    if (typeof value === 'boolean') return value;
    const v = String(value).toLowerCase();
    if (['1', 'true', 'on', 'yes'].includes(v)) return true;
    if (['0', 'false', 'off', 'no'].includes(v)) return false;
    return fallback;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// 在模块首次加载时快照原始 env —— 之后 applyToEnv 写回 process.env 不会污染"环境默认"。
// 这样 reset 永远回到 start.cmd 里设的初值，而不是被本模块写回的值。
const RAW_ENV_DEFAULTS = {};
for (const [name, spec] of Object.entries(SCHEMA)) {
  RAW_ENV_DEFAULTS[name] = coerce(process.env[spec.key], spec.type, spec.def, spec);
}

export function createRuntimeConfig({ file }) {
  const envDefaults = { ...RAW_ENV_DEFAULTS };

  let saved = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.values && typeof parsed.values === 'object') {
      saved = parsed.values;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      try { fs.copyFileSync(file, `${file}.broken-${Date.now()}`); } catch {}
    }
  }

  // 合并：配置文件里合法的值覆盖环境默认
  let values = { ...envDefaults };
  for (const [name, spec] of Object.entries(SCHEMA)) {
    if (Object.prototype.hasOwnProperty.call(saved, name)) {
      values[name] = coerce(saved[name], spec.type, values[name], spec);
    }
  }

  function persist() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    // 只持久化被覆盖的项（saved），不要写全量 values —— 否则 reset 后重启
    // 仍会把"当前值"当作覆盖读回来，"恢复默认"形同虚设。
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, values: saved }, null, 2));
    fs.renameSync(tmp, file);
  }

  // 把当前值同步回 process.env：所有"用时读取 process.env.TA_xxx"的代码
  // （shim / events / responses 链路）无需改动即可即时读到新值，覆盖全部协议。
  function applyToEnv() {
    for (const [name, spec] of Object.entries(SCHEMA)) {
      const v = values[name];
      process.env[spec.key] = spec.type === 'bool' ? (v ? '1' : '0') : String(v);
    }
  }
  applyToEnv();

  return {
    /** 读单项（同步，内存） */
    get(name) {
      return values[name];
    },
    /** 读全部（含每项元信息，供管理台展示） */
    all() {
      const out = {};
      for (const [name, spec] of Object.entries(SCHEMA)) {
        out[name] = {
          value: values[name],
          default: spec.def,
          label: spec.label,
          desc: spec.desc,
          env: spec.key,
          type: spec.type,
          options: spec.options ?? null,
          overridden: Object.prototype.hasOwnProperty.call(saved, name),
        };
      }
      return out;
    },
    /** 更新若干项并持久化；返回实际生效值。未知项忽略。 */
    update(patch) {
      if (!patch || typeof patch !== 'object') return values;
      for (const [name, spec] of Object.entries(SCHEMA)) {
        if (Object.prototype.hasOwnProperty.call(patch, name)) {
          const v = coerce(patch[name], spec.type, values[name], spec);
          values[name] = v;
          saved[name] = v;
        }
      }
      persist();
      applyToEnv();
      return { ...values };
    },
    /** 恢复某项为环境默认（删掉配置文件里的覆盖） */
    reset(names) {
      const list = Array.isArray(names) ? names : [names];
      for (const name of list) {
        if (!SCHEMA[name]) continue;
        values[name] = envDefaults[name];
        delete saved[name];
      }
      persist();
      applyToEnv();
      return { ...values };
    },
  };
}
