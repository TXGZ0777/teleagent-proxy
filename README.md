# teleagent-proxy

把本机已登录的 **TeleAgent（天翼 AI 星辰超级智能体桌面端，Windows 版）** 反代成一个
**本地 OpenAI 兼容端点**：任何支持 `base_url` 的客户端（OpenAI SDK、Cherry Studio、
DSH、各类 IDE 插件）都能直接把它当 OpenAI 用。

> **免责声明**：本项目是对**本机已安装客户端行为**的互操作研究，用于把自己已有的账号接入
> 自己的工具链。仓库**不含**任何登录凭据、用户数据或上游密钥；使用前请确认你拥有该账号，
> 并自行遵守 TeleAgent 的服务条款与当地法律。仅供个人自用，**不要**对外提供代理服务、
> 转售额度或绕过计费。

```
客户端 (OpenAI 协议)
   │  POST /v1/chat/completions
   ▼
本地 shim  http://127.0.0.1:8787/v1
   │  会话映射 / 流式翻译 / 错误归一
   ▼
TeleAgent 自己的 Go kernel（独立进程，独立数据目录）
   │  解密登录态 + 原生签名
   ▼
TeleAgent 上游  https://agent.teleai.com.cn/superCowork/sapi/api/v1
```

请求由 TeleAgent **自己的 kernel** 加签发出，不是复刻签名直连；登录态只在本进程内存里解密。

---

## 快速开始

```powershell
cd teleagent-proxy
.\start.cmd
# 或者
node server.mjs
```

启动后：

```
[teleagent] 账号 <你的昵称> · kernel 3.0.0-dev-...
[teleagent] OpenAI 兼容端点: http://127.0.0.1:8787/v1
[teleagent] 模型: chat-pro, chat-flagship, chat-flash
[teleagent] API 密钥: 0 启用 / 0 总数 · ...\runtime\config\api-keys.json
[teleagent] 管理台: http://127.0.0.1:8787/admin
```

浏览器打开 **http://127.0.0.1:8787/admin** 就是管理台：建密钥、批量停用/删除、看调用量。

前置条件（缺一不可）：

1. 已安装 TeleAgent 桌面端（`~/.local/share/TeleAgent/runtimes/super-agent-code/bin/TeleAgent.exe`）
2. 桌面端**已登录**，且至少打开过一次对话（要生成 `model-catalog.json`）
3. 本机配置上游 gateway key（见下节；**仓库不附带**）

### 获取上游 gateway key

桌面端内部有一个网关 apiKey 常量（不是你的账号凭据，但属于上游共享凭证，所以本仓库不分发）。
从本机已安装的客户端里取：

```powershell
# 客户端是 Electron 应用，明文代码在 app.asar 的 dist-electron/main-runtime-*.js
# 搜索 useSuperAgentAuth，同一对象里的 apiKey 就是
rg -a -o "apiKey:\s*\"[^\"]+\"" "D:\天翼ai\TeleAgent\resources\app.asar"
```

拿到后二选一：

```powershell
$env:TA_GATEWAY_KEY = "sk-..."          # 方式一：环境变量
```

```json
// 方式二：项目根目录 local.secrets.json（已 gitignore）
{ "gatewayKey": "sk-..." }
```

## 接入

### OpenAI SDK / 任意兼容客户端

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="not-needed")
r = client.chat.completions.create(
    model="chat-flash",
    messages=[{"role": "user", "content": "你好"}],
)
print(r.choices[0].message.content)
```

`api_key` 随便填；如果启动时设了 `TA_API_KEY`，则必须与它一致。

### Cherry Studio / ChatBox 等图形客户端

- API 地址：`http://127.0.0.1:8787/v1`
- API Key：任意（或与 `TA_API_KEY` 一致）
- 模型：`chat-pro` / `chat-flagship` / `chat-flash`

### DSH（DeepSeek Harness）

DSH 内置 provider 只认自己的协议；要用这里的端点，按“OpenAI 兼容自定义 provider”配置，
`baseURL = http://127.0.0.1:8787/v1`。

### curl

```powershell
curl.exe -N -X POST http://127.0.0.1:8787/v1/chat/completions `
  -H "Content-Type: application/json" `
  -d '{\"model\":\"chat-flash\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}]}'
```

## 接 Codex CLI

Codex 0.12x 起**只支持 Responses 协议**（`wire_api = "chat"` 会在启动时直接报错），
网关的 `/v1/responses` 就是为它准备的。

最小配置（完整示例见 `examples/codex-config.toml`）：

```toml
model = "chat-flash"
model_provider = "custom"

[model_providers.custom]
name = "TeleAgent"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
requires_openai_auth = false
env_key = "TA_KEY"
```

```powershell
$env:TA_KEY = "dummy"     # 网关没开 TA_API_KEY 时值随意
codex exec --skip-git-repo-check "只回答两个字：收到"
```

实测（Codex CLI 0.125.0，Windows）：

```
codex
收到
tokens used
13,565
```

### 工具调用（MCP 中继）

Codex 的 `tools` 不会被丢掉：它们被挂成 kernel 侧的 MCP 工具（`ta_shell` 等），
模型调用时我们**挂起不返回**，把调用翻成 `function_call` 交回 Codex；
Codex 执行完，下一次请求带着 `function_call_output` 回来，我们再用它放行挂起的调用，
kernel 接着生成。整条链路是无状态的，状态只活在网关内存里（按会话指纹索引，6h TTL）。

实测（`chat-flash`）：

| 场景 | 结果 |
|---|---|
| 读：`用 shell 列出当前目录顶层文件名` | Codex 执行 `powershell.exe -Command 'Get-ChildItem -File \| Select-Object -First 5'`，返回真实文件名，模型复述正确 |
| 写：`创建 note.txt 内容 hello` | Codex 走 `apply_patch`，文件落在 Codex 的工作目录，内容 `hello` |
| 多轮：`把 note.txt 改成 hello world（先读再改）` | 先读后改，工具调用与续跑都正常 |

三个必须知道的细节：

1. **工作目录**：Codex 会在 `<environment_context>` 里发 `<cwd>`，网关把它提到 prompt 首行，
   否则模型会按 kernel 自己的 `runtime/` 目录拼绝对路径（实测踩过，文件写到了 runner 目录里）。
2. **写权限由 Codex 自己的沙箱决定**：`codex exec` 默认只读，写入会被 Codex 拦掉
   （`blocked by policy` / `writing is blocked by read-only sandbox`），和网关无关。
   要落盘用 `--full-auto` 或 `--dangerously-bypass-approvals-and-sandbox`。
3. **shell 输出会被本机 PowerShell profile 污染**（每次执行都打印一行 `[OK] Proxy enabled...`），
   模型据此做 patch 时上下文对不上。要么用干净的 profile，要么让它改用 `apply_patch` 直接写。

### 已验证到哪一步

- ✅ `response.created → in_progress → output_item.added → content_part.added → output_text.delta* → output_text.done → content_part.done → output_item.done → completed` 序列完整，`sequence_number` 单调
- ✅ 真 CLI 跑通：`codex exec` 返回模型输出，5s、13.5k tokens（含 Codex 自己的 instructions 与工具 schema）
- ✅ `input` 为字符串或 item 数组都能处理，`function_call_output` 会折叠成【工具结果】回灌
- ✅ 工具中继：`shell` / `apply_patch` 都能落到 Codex 自己的进程里执行（读、写、多轮都验过）
- ⚠️ 未做：并行工具调用（一次多个 call 时按顺序返回，客户端会逐个执行）、`web_search` 等内置工具类型（跳过）

## 与 CC Switch 联调

CC Switch 只负责把供应商配置写进客户端配置文件，不改变协议；所以网关得会说客户端实际发的协议：

| CC Switch 类型 | 客户端实际调用 | 网关现状 |
|---|---|---|
| `codex`（Codex CLI） | `POST /v1/responses` | ✅ 已实现，CLI 实测通过 |
| `claude`（Claude Code） | `POST /v1/messages` | ✅ 已实现 |
| `opencode` / `gemini` | 各自配置格式 | 未适配 |

### 一键注册供应商

```powershell
node tools/ccswitch-provider.mjs --app codex            # dry-run，只打印配置
node tools/ccswitch-provider.mjs --app codex --apply    # 写 cc-switch.db（自动备份）
node tools/ccswitch-provider.mjs --app codex --apply --switch   # 同时设为当前

node tools/ccswitch-provider.mjs --app claude --apply   # Claude 那条同理
```

写入 Codex 的配置等价于：

```json
{
  "auth": { "OPENAI_API_KEY": "sk-teleagent-local" },
  "config": "model_provider = \"custom\"\nmodel = \"chat-pro\"\n[model_providers.custom]\nname = \"TeleAgent\"\nbase_url = \"http://127.0.0.1:8787/v1\"\nwire_api = \"responses\"\nrequires_openai_auth = false\n",
  "modelCatalog": { "models": [ { "model": "chat-pro", "displayName": "TeleAgent 智能 x0.6", "contextWindow": 400000 } ] }
}
```

打开 CC Switch → Codex → 选「TeleAgent 本地反代 (Codex)」切过去即可。

## 模型

| modelID | 名称 | 上下文 | 输出 | 积分倍率 | 建议 |
|---|---|---|---|---|---|
| `chat-flash` | 极速 | 400K | 65536 | x0.2 | 日常首选，最省 |
| `chat-pro` | 智能 | 400K | 65536 | x0.6 | 复杂任务 |
| `chat-flagship` | 旗舰 | 400K | 65536 | x1.0 | 短问答别用，烧积分 |

模型清单来自桌面端 `users/<scope>/model-catalog.json`，桌面端下发新模型后重启代理即可生效。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/models` | 模型清单 |
| POST | `/v1/chat/completions` | OpenAI 协议，支持 `stream`、多轮、`reasoning_content` |
| POST | `/v1/responses` | Responses 协议（Codex CLI），流式事件完整 |
| POST | `/v1/messages` | Anthropic Messages 协议（Claude Code / CC Switch） |
| POST | `/v1/messages/count_tokens` | 粗略 token 估算 |
| GET | `/healthz` | 代理与 kernel 状态（鉴权开关、启用密钥数、当前生效的提示词来源） |
| GET | `/admin` | Web 管理台（仅回环地址，见下节） |
| GET | `/admin/api/state` | 管理台数据快照：网关状态、密钥表、统计 |
| POST | `/admin/api/keys` | 新建密钥（支持 `count` 批量） |
| PATCH / DELETE | `/admin/api/keys/:id` | 改名/备注/有效期/启停、删除单把 |
| POST | `/admin/api/keys/bulk` | 批量 `enable` / `disable` / `reset` / `delete` |
| POST | `/admin/api/settings` | 切换鉴权模式 `auto` / `on` / `off` |

行为约定：

- 流式：标准 `chat.completion.chunk` + `data: [DONE]`，思维链走 `delta.reasoning_content`
- 非流式：聚合后一次返回，同样带 `reasoning_content` 与 `usage`
- 错误：HTTP 4xx/5xx + `{error:{message,type,code}}`；额度不足统一成 `insufficient quota`
- 会话：按 `user` 字段或「首条用户消息」指纹复用 kernel 会话，6 小时 TTL；kernel 侧保留历史

## 管理台（Web 图形界面）

浏览器打开 `http://127.0.0.1:8787/admin`（访问根路径 `/` 会自动跳转）。单文件页面，
不依赖 CDN，离线可用。

能做的事：

| 区域 | 功能 |
|---|---|
| 概览 | 密钥总数 / 启用中 / 今日请求 / 累计请求，今日新增与服务状态 |
| 趋势 | 近 14 天调用次数柱状图（悬停看当天 tokens） |
| 密钥表 | 生成、复制、改名、备注、设置有效期（天，0=永久）、单把停用/删除 |
| 批量 | 勾选多把 → 批量启用 / 批量停用 / 重置统计 / 批量删除 |
| 鉴权 | `自动`（密钥表非空即校验）/ `强制校验` / `关闭校验`，即时生效 |
| 流水 | 最近 200 条调用（密钥、协议、状态码、耗时） |

密钥保存在 `runtime/config/api-keys.json`（`runtime/` 已被 gitignore），可以直接备份/迁移。
生成时明文只在这一屏集中展示，之后在列表里也能复制。

> 安全：管理台只接受**回环地址**访问。想让管理接口也要令牌，启动前设
> `TA_ADMIN_TOKEN=xxx`，页面会提示输入（存在浏览器 localStorage，只影响管理接口，
> 不影响 `/v1` 调用）。环境变量 `TA_API_KEY` 依然可以作为一把「主密钥」长期使用。

## 提示词优先级（重要）

### 三层提示词，只有一层能由客户端决定

| 层 | 来源 | 能否覆盖 |
|---|---|---|
| 内置人设 | 硬编码在 kernel 二进制里（`You are 星辰超级智能体（TeleAgent）…`，含 `# Security`、`# Language and style` 等分节） | 只能启动时替换，对话里说什么都没用 |
| agent 提示词 | `agent.build.prompt`（就是网关塞进去的那层） | **完全可替换** |
| 环境块 | kernel 自动追加在 system 末尾（模型名、工作目录、平台、日期） | 不可去掉，但只是环境信息 |

抓包实证（`npm run capture` 后看 `runtime/capture/req-*.json`）：内核**只用一条** `system` 消息，
内容是 `agent.build.prompt` + 环境块。所以只要这层被替换，模型就不会再自称星辰。

### 曾经的坑：空提示词会回落

旧实现把客户端的提示词直接当 `agent.build.prompt` 传，客户端没给时传的是**空串**，
配置里于是没有 `agent.build.prompt` 字段 —— 内核立刻回落到内置人设，于是出现：

```
用户 > 你是谁？
模型 > 我是星辰超级智能体（TeleAgent），一个协助完成日常办公与软件工程任务的子智能体。
```

修复后：**始终显式设置** `agent.build.prompt`。客户端给了就用客户端的，没给用中性兜底
`You are a helpful assistant serving an API client.`，绝不落到内置人设。

### 取哪段作为客户端提示词

| 客户端 | 取哪些字段 |
|---|---|
| Codex（`/v1/responses`） | `instructions` + `input` 里的 `developer` / `system` 消息（按顺序拼接） |
| Claude Code（`/v1/messages`） | `system`（字符串或 text block 数组，全部拼上） |
| OpenAI 兼容（`/v1/chat/completions`） | **所有** `system` 与 `developer` 消息（不再只取第一条） |

同时，system 文本**不会**再被拼进首轮用户消息 —— 它已经作为内核的 system 消息存在，
复述一遍等于给模型两份互相竞争的指令。

提示词指纹变了会**换一个 kernel**（约 2 秒，会话映射同时清空；客户端本身每轮都会重放历史，
Codex / Claude Code 不受影响）。工具调用挂起期间不会切换，避免打断工具循环。

### 想改行为时

| 环境变量 | 作用 |
|---|---|
| `TA_FALLBACK_PROMPT` | 客户端没给提示词时的兜底人设（默认中性助手） |
| `TA_BUILTIN_PROMPT=1` | 显式使用内核自带的星辰人设（排障 / 对比用） |
| `TA_UPSTREAM_BASE_URL` | 把上游指向本机抓包代理，验证实际发出的 system |

排查方法：`npm run capture` 起代理 → 另开一个终端
`TA_UPSTREAM_BASE_URL=http://127.0.0.1:9909/superCowork/sapi/api/v1 node server.mjs` → 发一次请求 →
看 `runtime/capture/req-*.json` 里的 `messages[0]`。

### 自检：内核到底吃进了哪段提示词

每次启动 / 切换内核后，网关会回读内核的 `GET /config`，确认 `agent.build.prompt` 确实是我们下发的版本，
结果同时写进三处：

| 位置 | 看什么 |
|---|---|
| `GET /healthz` | `agent: { client, promptChars, promptSha, verified }`，`verified: true` 表示已回读确认 |
| 管理台「接入信息 → 提示词」 | 例如 `Codex 原生 · 26,043 字符 · 已校验` |
| 启动日志 | `[teleagent] 内核提示词：codex · 26043 字符 · 校验 通过` |

`client` 取值：`codex` / `claude` / `chat` / `neutral`（客户端没给提示词时的中性兜底）。

如果 `verified` 为 `false`，或内核里出现「星辰超级智能体」，启动日志会直接告警 ——
多半是 `TA_BUILTIN_PROMPT=1` 被设上了，或者内核版本升级后改了配置键。

离线核对（不经过网关，直接起一个内核看它吃进什么）：

```powershell
node tools/probe-prompt.mjs            # 下发一段带金丝雀的 Codex 风格提示词，看能否原样读回
node tools/probe-prompt.mjs --builtin  # 对照：内核自带人设长什么样
```

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `TA_PORT` | `8787` | 本地监听端口（只绑 127.0.0.1） |
| `TA_API_KEY` | 空 | 设置后要求 `Authorization: Bearer` 或 `x-api-key`（作为主密钥，与管理台生成的密钥并存） |
| `TA_KEYS_FILE` | `runtime/config/api-keys.json` | 管理台维护的密钥表路径 |
| `TA_ADMIN_TOKEN` | 空 | 设置后 `/admin/api/*` 需要令牌（页面会提示输入） |
| `TA_FALLBACK_PROMPT` | 中性助手 | 客户端没给系统提示词时的兜底人设 |
| `TA_BUILTIN_PROMPT` | 关 | 设为 `1` 使用内核自带的星辰人设（排障用） |
| `TA_UPSTREAM_BASE_URL` | 官方上游 | 覆盖上游地址，指向本机抓包代理 |
| `TA_DEFAULT_MODEL` | 目录第一个 | 客户端模型名匹配不上时的兜底 |
| `TA_ALLOW_KERNEL_TOOLS` | 关 | 设为 `1` 才放行 kernel 自带的 bash/read/write 等工具（默认全禁） |
| `TA_GATEWAY_KEY` | — | 上游 gateway key（见「获取上游 gateway key」） |
| `TA_MODEL` | `chat-flash` | 仅探针用 |

## 反向工程结论（维护用）

Windows 版与 macOS 版差异不大，但登录态来源不同：

| 环节 | Windows 实现 |
|---|---|
| 登录态存储 | `~/.local/share/TeleAgent/users/<scope>/app-auth/token.json`，`scheme=safe_storage`，密文 `v10` |
| 解密 | Chromium OSCrypt：`Local State` → `os_crypt.encrypted_key`（`DPAPI` + base64）→ DPAPI 解保护得 32B 主密钥 → AES-256-GCM（`v10` + 12B nonce + 密文 + 16B tag） |
| 明文 | `<tenant>:<jwt>`，JWT 含 accountId / userId / accountName / exp（约 30 天） |
| kernel 启动 | 无参数；env 走 **stdin：4 字节大端长度 + JSON**；端口由 `SERVER_PORT` 决定 |
| 本地鉴权 | `X-SA-Signature = base64url(HMAC-SHA256(sessionKey, ["local-v1", METHOD, path, ts, nonce].join("\n")))` |
| 上游鉴权 | 由 kernel 完成：`SUPER_AGENT_AUTH_STATE`（AES-256-GCM 信封）解出 token，kernel 自己加 `X-SuperAgent-*` 头 |
| provider | 内核内置 `NewApi`，客户端常量 `apiKey` + `X-Route-Target: ops-gateway` + `useSuperAgentAuth` |
| 事件流 | `GET /event` 全局 SSE；`message.part.updated` 的 `part.text` 是**累积全文**；`session.status{type:idle}` 收尾 |

关键坑（都已绕过）：

1. 沙箱内 `spawn` 用管道 stdio 会 `EPERM` → payload 写临时文件，用 fd 作 stdin，就绪后立即删除
2. 模型 `options.temperature: true` 会被当成请求体里的布尔值，上游 400 → 不要写 `temperature`
3. kernel 会把自己收到的用户提示词也作为 part 发回来 → 必须按 `sessionID` + `role=assistant` 过滤，否则回复开头是整段提示词
4. 一轮结束后 `reader.read()` 的 Promise 会因 abort 拒绝 → 必须提前 `catch`，否则整个进程被未处理拒绝带走
5. 失败/超时后要 `POST /session/:id/abort`，否则该会话永远 busy
6. **kernel 会偷偷执行工具**：不关掉的话，它会用自己的 `powershell`/`apply_patch` 在 `runtime/` 目录里跑，
   然后把结果当成“你的工作目录”的内容回答。现在靠两件事压住：prompt 的 `tools` 开关把所有内置工具置 `false`，
   再叠一层 `permission: deny`；工具只能从 MCP 桥（`ta_*`）进出。
7. **工具调用要拆成两段**：MCP 的 `tools/call` 必须**挂起**（不能立即返回占位），否则 kernel 会把占位当结果继续编；
   同时 `takeCalls()` 不能清空挂起队列，否则续跑时无从放行（这两个 bug 都实际卡死过）。

## 已知限制

- **角色被折叠成文本**：kernel 的 session API 只接受 parts，system/assistant/tool 会拼进一段文本；
  多轮语义没问题，但严格的 role 结构无法保留。
- **工具中继只做了 Responses（Codex）这一路**：`/v1/chat/completions` 与 `/v1/messages` 仍然忽略 `tools`。
  Claude Code 要能改文件，需要把 Anthropic 的 `tool_use`/`tool_result` 接到同一套桥（工作量不大，但没做）。
- **并行工具调用未验证**：一次返回多个 `function_call` 时按顺序下发，客户端会逐个执行。
- **文件水印**：kernel 的 
eport_final_files 会给产出文件追加「AI生成」，已加入禁用表（默认不会出现）；如自行放行 kernel 工具需注意。
- **每轮固定开销**：kernel 会带自己的系统提示词与工具 schema（实测单轮 ~1.0–1.2 万 input tokens），
  按 `chat-flash` x0.2 计也不便宜；工具多轮时每轮都要重发。
- **依赖桌面端登录**：JWT 过期（约 30 天）后需在桌面端重新登录；换账号后重启代理即可。
- **依赖逆向**：桌面端升级可能改 kernel 协议，升级后先跑 `node tools/doctor.mjs`。
- **仅 Windows 验证**：macOS 路径在 `lib/paths.mjs` 里预留了 `TeleAgent` 二进制名，但未实测。

## 版本

当前版本 **0.3.2**，变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## 安全与合规

- 只监听 `127.0.0.1`；在管理台新建密钥（或设 `TA_API_KEY`）即可要求鉴权，避免同机其他程序白嫖你的额度
- 密钥表是明文 JSON（`runtime/config/api-keys.json`），只在本机、已在 gitignore 内；需要更强隔离可设 `TA_ADMIN_TOKEN`
- 管理台仅回环可访问，但仍不建议把 8787 端口通过内网穿透/反代暴露出去
- 登录态只在进程内存中出现；含 token 的临时 payload 在 kernel 就绪后立即删除
- 这是**自用**工具：不要对外暴露、不要分发账号额度、不要用于绕过计费。
  与官方客户端相比，请求节奏、system 提示词、工具集合都不同，请自行评估账号风险。

## 目录

| 文件 | 职责 |
|---|---|
| `server.mjs` | 入口：解析登录态 → 拉起 kernel → 起 shim |
| `lib/auth.mjs` | DPAPI + v10 解密、JWT 解析 |
| `lib/kernel.mjs` | kernel 启动（stdin payload）、env 组装、X-SA 签名 |
| `lib/events.mjs` | `/event` SSE 消费、累积转增量、错误归一 |
| `lib/shim.mjs` | OpenAI 兼容路由、会话映射、流式输出 |
| `lib/responses.mjs` | Responses 协议适配 + 工具中继（Codex CLI） |
| `lib/toolbridge.mjs` | 工具桥：挂载、挂起、放行、内置工具开关 |
| `lib/mcp-server.mjs` | 最小 MCP 服务端（Streamable HTTP） |
| `lib/anthropic.mjs` | Anthropic Messages 适配（Claude Code / CC Switch） |
| `lib/keystore.mjs` | API 密钥表：生成、校验、批量操作、按密钥计量 |
| `lib/admin.mjs` | 管理台页面与 `/admin/api/*` 接口 |
| `web/admin.html` | 管理台单页（原生 JS，无外部依赖） |
| `lib/paths.mjs` | TeleAgent 目录探测 |
| `tools/doctor.mjs` | 环境自检 |
| `tools/ccswitch-provider.mjs` | 把本网关注册成 CC Switch 供应商（`--app claude|codex`） |
| `examples/codex-config.toml` | Codex 直连本网关的配置样例 |
| `tools/probe-kernel.mjs` | 最小链路探针（不经过 shim） |
| `tools/probe-tools.mjs` | 工具注册表探针（验证 MCP 挂载与内置工具开关） |
| `tools/capture-upstream.mjs` | 抓包代理：把上游请求原样转发并落盘，用于核对 system prompt |
| `tools/asar.mjs` / `slice.mjs` | 读客户端 `app.asar`（逆向用） |
| `notes/` | 逆向时截下来的客户端源码片段 |


