// Go kernel 启动与请求签名
import crypto from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  KERNEL_BINARY,
  DEVICE_DATA_ROOT,
  DEVICE_CONFIG_ROOT,
  DEVICE_CACHE_ROOT,
  accountDir,
  accountConfigDir,
  kernelVersion,
} from './paths.mjs';

// 上游网关地址（客户端常量）
// TA_UPSTREAM_BASE_URL 可覆盖：用于把请求引到本机抓包代理（tools/capture-upstream.mjs）排查
export const UPSTREAM_BASE_URL =
  (process.env.TA_UPSTREAM_BASE_URL && process.env.TA_UPSTREAM_BASE_URL.trim()) ||
  'https://agent.teleai.com.cn/superCowork/sapi/api/v1';

/**
 * 网关 apiKey：**不随仓库分发**。
 *
 * 它是 TeleAgent 桌面端内置的常量（不是用户凭据），但把它公开等于替上游泄露一个共享 key，
 * 所以这里只从本机读取，二选一：
 *   1. 环境变量 TA_GATEWAY_KEY
 *   2. 项目根目录 local.secrets.json：{ "gatewayKey": "..." }（已 gitignore）
 *
 * 取值方法见 README「获取上游 gateway key」。
 */
export function getGatewayKey() {
  const fromEnv = process.env.TA_GATEWAY_KEY;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();

  try {
    const file = path.join(rootDir(), 'local.secrets.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof parsed?.gatewayKey === 'string' && parsed.gatewayKey.trim()) return parsed.gatewayKey.trim();
  } catch {
    /* 没有 local.secrets.json 时继续报错 */
  }

  throw new Error(
    '缺少上游 gateway key：请设置环境变量 TA_GATEWAY_KEY，或在项目根目录创建 local.secrets.json（{"gatewayKey":"..."}）。获取方式见 README。',
  );
}

function rootDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

export function randomSessionKey() {
  return crypto.randomBytes(32).toString('base64url');
}

export function encryptAuthState({ token, deviceId, installId }, sessionKey) {
  const key = crypto.createHash('sha256').update(sessionKey).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ token, deviceId, installId }), 'utf8'),
    cipher.final(),
  ]);
  return {
    version: 'v1',
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  };
}

/** X-SA 本地鉴权签名（服务端按换行拼接校验） */
export function signLocal(sessionKey, method, pathWithQuery, { ts = Date.now(), nonce } = {}) {
  const n = nonce || crypto.randomBytes(12).toString('hex');
  const msg = ['local-v1', method.toUpperCase(), pathWithQuery, String(ts), n].join('\n');
  const sig = crypto.createHmac('sha256', sessionKey).update(msg).digest('base64url');
  const headers = {
    'X-SA-Sign-Version': 'local-v1',
    'X-SA-Timestamp': String(ts),
    'X-SA-Nonce': n,
    'X-SA-Signature': sig,
  };
  return { headers, nonce: n, ts };
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function modelEntries(catalog) {
  const models = {};
  const groups = catalog?.state?.catalog?.groups || [];
  for (const group of groups) {
    for (const m of group.models || []) {
      models[m.modelID] = {
        name: m.displayName || m.modelID,
        limit: {
          context: m.limits?.context ?? 128000,
          output: m.limits?.output ?? 32768,
        },
        options: {
          reasoning: true,
          interleaved: { field: 'reasoning_content' },
          // 只允许工具中继挂进来的 MCP 工具；内置工具由 prompt 的 tools 开关 + permission deny 关掉
          tool_call: true,
          tool_stream: true,
        },
      };
    }
  }
  return models;
}

// kernel 自带的工具默认全部禁用：它是 agent 运行时，会自己在自己的 cwd/沙箱里执行 bash、read、write，
// 再让调用方以为“目录已看过 / 文件已改好”。对 Codex、Claude Code 这类客户端来说这是错误的世界模型。
// 需要放行时设 TA_ALLOW_KERNEL_TOOLS=1。
const KERNEL_TOOL_DENY = Object.fromEntries(
  [
    'bash', 'bash.windows', 'powershell', 'read', 'write', 'edit', 'multiedit', 'patch', 'apply_patch', 'glob', 'grep', 'list',
    'webfetch', 'websearch', 'codesearch', 'baidu_search', 'arxiv_search', 'image_read', 'imagegen',
    'task', 'question', 'skill', 'todowrite', 'todoread', 'lsp',
    'memory_get', 'memory_search', 'memory_write', 'memory_delete',
    // 下面这些不关会偷偷产生副作用：report_final_files 会给产出文件盖「AI生成」水印，
    // session_* / skill_* 会改它自己的会话与技能状态。
    'report_final_files', 'teleai_claw_scan', 'session_status', 'session_continue',
    'skill_list', 'skill_view', 'skill_manage', 'skill_evolution_resolve',
    'image_understanding', 'ImageGen', 'ImageGenWithRef', 'online_search', 'invalid',
  ].map((name) => [name, 'deny']),
);

/**
 * 客户端没给系统提示词时用的中性兜底。
 *
 * 关键点：**绝不能留空**。空提示词会让 kernel 回落到内置「星辰超级智能体」人设
 * （`agent.build.prompt` 缺省时用它自己的 prompt），模型就会自报星辰、强制中文、
 * 并拒绝透露系统提示词 —— 盖过来调客户端的设定。抓包验证过：内置 prompt 会以
 * 唯一一条 system 消息发往上游。所以这里始终显式覆盖。
 */
export const NEUTRAL_AGENT_PROMPT =
  'You are a helpful assistant serving an API client. Follow the instructions and context provided in the conversation.';

/**
 * 组装 kernel 配置。
 *
 * `agentPrompt` 会**整体替换** kernel 内置的「星辰超级智能体」身份提示词（`agent.build.prompt`）。
 * 内置 prompt 是硬编码在 kernel 二进制里的（含 `# Security`、`# Language and style` 等分节），
 * 对话层声明无法覆盖它，只有替换 agent prompt 才生效。
 *
 * 因此：客户端给了提示词就原样替换；没给就用中性兜底，**不留空**
 * （除非显式设 `TA_BUILTIN_PROMPT=1` 要求使用内核自带提示词）。
 *
 * @param {object} catalog 桌面端模型目录
 * @param {{agentPrompt?: string}} [options]
 */
export function buildProviderConfig(catalog, { agentPrompt } = {}) {
  const allowKernelTools = process.env.TA_ALLOW_KERNEL_TOOLS === '1';
  const custom = typeof agentPrompt === 'string' ? agentPrompt.trim() : '';
  const prompt =
    process.env.TA_BUILTIN_PROMPT === '1'
      ? null
      : custom || (process.env.TA_FALLBACK_PROMPT || '').trim() || NEUTRAL_AGENT_PROMPT;
  return {
    provider: {
      NewApi: {
        id: 'new-api',
        name: '预置模型',
        options: {
          baseURL: UPSTREAM_BASE_URL,
          apiKey: getGatewayKey(),
          headers: { 'X-Route-Target': 'ops-gateway' },
          useSuperAgentAuth: true,
          timeout: 20 * 60 * 1000,
          chunkTimeout: 15 * 60 * 1000,
        },
        models: modelEntries(catalog),
      },
    },
    enabled_providers: ['NewApi'],
    ...(prompt
      ? { default_agent: 'build', agent: { build: { prompt } } }
      : {}),
    mcp: {},
    command: {},
    keybinds: {},
    autoupdate: false,
    formatter: false,
    lsp: false,
    small_model: 'NewApi/chat-lite',
    permission: allowKernelTools ? {} : KERNEL_TOOL_DENY,
    compaction: { reserved: 32000 },
    watcher: { ignore: ['node_modules/**', 'dist/**', '.git/**'] },
    instructions: [],
  };
}

/**
 * 启动一个独立 kernel 进程（与桌面端互不干扰：账号根/配置根用沙箱副本）。
 * 返回 { proc, port, origin, sessionKey, call, close }
 */
export async function startKernel({
  runtimeRoot,
  cwd = runtimeRoot,
  agentPrompt = null,
  auth, // { token, deviceId, installId }
  catalog,
  sessionKey = randomSessionKey(),
  port,
  version = kernelVersion(),
  env: extraEnv = {},
  onLog = () => {},
} = {}) {
  const dataDir = path.join(runtimeRoot, 'data');
  const configDir = path.join(runtimeRoot, 'config');
  const cacheDir = path.join(runtimeRoot, 'cache');
  const logDir = path.join(runtimeRoot, 'logs');
  for (const dir of [dataDir, configDir, cacheDir, logDir]) fs.mkdirSync(dir, { recursive: true });

  const chosenPort = port ?? (await freePort());
  const origin = `http://127.0.0.1:${chosenPort}`;
  const username = 'shim';
  const password = crypto.randomBytes(18).toString('base64url');
  const sessionAuth = signLocal;

  const authState = encryptAuthState(
    { token: auth.token, deviceId: auth.deviceId, installId: auth.installId },
    sessionKey,
  );

  const env = {
    ...process.env,
    XDG_DATA_HOME: dataDir,
    XDG_CONFIG_HOME: configDir,
    XDG_CACHE_HOME: DEVICE_CACHE_ROOT,
    SUPER_AGENT_APP_DATA_DIR: DEVICE_DATA_ROOT,
    SUPER_AGENT_APP_CONFIG_DIR: DEVICE_CONFIG_ROOT,
    TELEAGENT_DATA_DIR: dataDir,
    TELEAGENT_CONFIG_DIR: configDir,
    OPENCODE_CONFIG_DIR: configDir,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(buildProviderConfig(catalog, { agentPrompt })),
    OPENCODE_SERVER_USERNAME: username,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_CLIENT: 'desktop',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
    OPENCODE_SHELL_PATH_PERMISSION_MODE: 'all',
    SUPER_AGENT_IGNORE_DOT_GIT: '1',
    SUPER_AGENT_LOG_DIR: logDir,
    SUPER_AGENT_SERVER_URL: origin,
    SERVER_PORT: String(chosenPort),
    SUPER_AGENT_APP_VERSION: version,
    SUPER_AGENT_LOCAL_SESSION_KEY: sessionKey,
    SUPER_AGENT_AUTH_STATE: JSON.stringify(authState),
    ...extraEnv,
  };

  // Go 后端从 stdin 读取 env payload：4 字节大端长度 + JSON。
  // 沙箱禁止管道 stdio，所以把 payload 落到临时文件、以 fd 作为 stdin 传进去。
  const payload = Buffer.from(JSON.stringify(env), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  const tmpDir = path.join(runtimeRoot, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const envFile = path.join(tmpDir, `env-${process.pid}-${Date.now()}.bin`);
  fs.writeFileSync(envFile, Buffer.concat([header, payload]), { mode: 0o600 });
  const outFile = path.join(logDir, 'kernel-stdout.log');
  const errFile = path.join(logDir, 'kernel-stderr.log');

  const inFd = fs.openSync(envFile, 'r');
  const outFd = fs.openSync(outFile, 'a');
  const errFd = fs.openSync(errFile, 'a');

  const proc = spawn(KERNEL_BINARY, [], {
    cwd,
    env,
    stdio: [inFd, outFd, errFd],
    windowsHide: true,
  });
  fs.closeSync(inFd);
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  proc.on('error', (err) => onLog(`kernel spawn error: ${err.message}`));
  // 读完即可删除：Windows 上要等进程释放句柄，就放到退出/就绪时删
  const cleanup = () => {
    try {
      fs.rmSync(envFile, { force: true });
    } catch {}
  };
  proc.on('exit', cleanup);

  const basic = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');

  async function call(method, pathWithQuery, body, { timeoutMs = 30000 } = {}) {
    const { headers } = sessionAuth(sessionKey, method, pathWithQuery);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(origin + pathWithQuery, {
        method,
        headers: {
          ...headers,
          authorization: basic,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let json;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: res.status, json, text, headers: res.headers };
    } finally {
      clearTimeout(timer);
    }
  }

  async function waitReady({ timeoutMs = 60000, intervalMs = 300 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) throw new Error(`kernel 提前退出 (code ${proc.exitCode})`);
      try {
        const res = await call('GET', '/global/health', null, { timeoutMs: 3000 });
        if (res.status === 200) {
          cleanup(); // 启动后立即抹掉含登录态的临时 payload
          return res.json;
        }
        last = `HTTP ${res.status}: ${res.text.slice(0, 200)}`;
      } catch (err) {
        last = err.message;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`kernel 未就绪: ${last}`);
  }

  return {
    proc,
    port: chosenPort,
    origin,
    sessionKey,
    username,
    password,
    call,
    sign: (method, pathWithQuery) => signLocal(sessionKey, method, pathWithQuery),
    waitReady,
    close() {
      if (proc.exitCode === null) proc.kill();
    },
  };
}



