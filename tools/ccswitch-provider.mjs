// 把「TeleAgent 本地反代」注册成 CC Switch 供应商（claude 或 codex）
//
//   node tools/ccswitch-provider.mjs --app codex          # 只打印配置（dry-run）
//   node tools/ccswitch-provider.mjs --app codex --apply  # 写入 cc-switch.db（先备份）
//   node tools/ccswitch-provider.mjs --app codex --apply --switch  # 同时设为当前供应商
//
// --app 默认 claude。注意：沙箱内不能用管道捕获子进程输出，所以 Python 结果写临时文件再读。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DB = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
const BASE_URL = process.env.TA_BASE_URL || 'http://127.0.0.1:8787';
const TOKEN = process.env.TA_API_KEY || 'sk-teleagent-local';
const argv = process.argv.slice(2);
const args = new Set(argv);
const argValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const apply = args.has('--apply');
const alsoSwitch = args.has('--switch');
const appType = argValue('--app', 'claude');

if (!['claude', 'codex'].includes(appType)) {
  console.error('--app 只支持 claude / codex');
  process.exit(1);
}

const CODEX_MODEL = process.env.TA_CODEX_MODEL || 'chat-pro';
const PROVIDER_ID = appType === 'codex' ? 'teleagent-local-proxy-codex' : 'teleagent-local-proxy';
const NAME = appType === 'codex' ? 'TeleAgent 本地反代 (Codex)' : 'TeleAgent 本地反代';

const settingsConfig = appType === 'codex'
  ? {
      auth: { OPENAI_API_KEY: TOKEN },
      config: [
        'model_provider = "custom"',
        `model = "${CODEX_MODEL}"`,
        'model_reasoning_effort = "low"',
        'experimental_use_freeform_apply_patch = true',
        'disable_response_storage = true',
        '',
        '[model_providers.custom]',
        'name = "TeleAgent"',
        `base_url = "${BASE_URL}/v1"`,
        'wire_api = "responses"',
        'requires_openai_auth = false',
        '',
      ].join('\n'),
      modelCatalog: {
        models: [
          { model: 'chat-pro', displayName: 'TeleAgent 智能 x0.6', contextWindow: 400000, inputModalities: ['text'] },
          { model: 'chat-flash', displayName: 'TeleAgent 极速 x0.2', contextWindow: 400000, inputModalities: ['text'] },
          { model: 'chat-flagship', displayName: 'TeleAgent 旗舰 x1.0', contextWindow: 400000, inputModalities: ['text'] },
        ],
      },
    }
  : {
      env: {
        ANTHROPIC_BASE_URL: BASE_URL,
        ANTHROPIC_AUTH_TOKEN: TOKEN,
        ANTHROPIC_MODEL: process.env.TA_ANTHROPIC_MODEL || 'chat-pro',
        ANTHROPIC_SMALL_FAST_MODEL: process.env.TA_ANTHROPIC_SMALL_MODEL || 'chat-flash',
      },
    };

console.log(`CC Switch 供应商配置（app_type = ${appType}）\n`);
console.log(JSON.stringify({ id: PROVIDER_ID, name: NAME, app_type: appType, settings_config: settingsConfig }, null, 2));

if (!fs.existsSync(DB)) {
  console.log('\n找不到 cc-switch.db（%USERPROFILE%\\.cc-switch\\cc-switch.db），请先启动一次 CC Switch。');
  process.exit(1);
}

const PY = String.raw`
import json, os, sqlite3, shutil, sys, time

args = json.load(open(sys.argv[1], "r", encoding="utf-8"))
out_path = args["out"]
db, pid, name, app = args["db"], args["id"], args["name"], args["app"]
cfg = json.dumps(args["settings"], ensure_ascii=False)

con = sqlite3.connect(db)
cur = con.cursor()
cur.execute("select id, is_current from providers where id = ?", (pid,))
row = cur.fetchone()
result = {"exists": bool(row)}

if args["apply"]:
    backup = db + ".bak-" + str(int(time.time() * 1000))
    shutil.copy2(db, backup)
    result["backup"] = backup
    cur.execute("""insert into providers
        (id, app_type, name, settings_config, category, created_at, meta, is_current, in_failover_queue, cost_multiplier)
        values (?, ?, ?, ?, 'custom', ?, '{}', 0, 0, '1.0')
        on conflict(id, app_type) do update set name = excluded.name, settings_config = excluded.settings_config""",
        (pid, app, name, cfg, int(time.time() * 1000)))
    if args["switch"]:
        cur.execute("update providers set is_current = 0 where app_type = ?", (app,))
        cur.execute("update providers set is_current = 1 where id = ?", (pid,))
    con.commit()
    result["written"] = True

con.close()
open(out_path, "w", encoding="utf-8").write(json.dumps(result, ensure_ascii=False))
`;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-'));
const pyFile = path.join(work, 'ccswitch.py');
const inFile = path.join(work, 'in.json');
const outFile = path.join(work, 'out.json');
fs.writeFileSync(pyFile, PY, 'utf8');
fs.writeFileSync(
  inFile,
  JSON.stringify({ db: DB, id: PROVIDER_ID, name: NAME, app: appType, settings: settingsConfig, apply, switch: alsoSwitch, out: outFile }),
  'utf8',
);

function findPython() {
  const candidates = [
    process.env.PYTHON,
    path.join(os.homedir(), '.local', 'share', 'TeleAgent', 'runtimes', 'python', 'python.exe'),
    'python',
  ].filter(Boolean);
  return candidates[0];
}

const python = findPython();
const errFile = path.join(work, 'err.log');
const errFd = fs.openSync(errFile, 'w');
await new Promise((resolve, reject) => {
  const child = spawn(python, [pyFile, inFile], { stdio: ['ignore', 'ignore', errFd], windowsHide: true });
  child.on('error', reject);
  child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`python 退出码 ${code}`))));
})
  .catch((err) => {
    const stderr = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8').trim() : '';
    console.error(`\n执行失败：${err.message}${stderr ? '\n' + stderr : ''}`);
    console.error('可以在 CC Switch 界面里手动新建供应商，粘贴上面的 settings_config。');
    console.error('（若是 “readonly database”，说明该进程没有写 ~/.cc-switch 的权限）');
    process.exit(1);
  })
  .finally(() => fs.closeSync(errFd));

const result = JSON.parse(fs.readFileSync(outFile, 'utf8'));
fs.rmSync(work, { recursive: true, force: true });

console.log(`\n数据库：${DB}`);
console.log(`供应商 ${PROVIDER_ID}：${result.exists ? '已存在（会覆盖配置）' : '不存在（新建）'}`);

if (!apply) {
  console.log('\n这是 dry-run。加 --apply 写入数据库；再加 --switch 设为当前供应商。');
  process.exit(0);
}

console.log(`已备份 → ${result.backup}`);
const tab = appType === 'codex' ? 'Codex' : 'Claude';
console.log(`\n完成。打开 CC Switch → ${tab} 标签页即可看到「${NAME}」` +
  (alsoSwitch ? '（已设为当前）' : '，点一下切过去即可'));
console.log(appType === 'codex'
  ? `切过去后 Codex 会请求 ${BASE_URL}/v1/responses`
  : `切过去后 Claude Code 会收到 ANTHROPIC_BASE_URL=${BASE_URL}`);

