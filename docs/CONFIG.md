# 配置参考

## 管理台可视化配置（推荐）

部分稳定性参数可以在管理台 `http://127.0.0.1:<端口>/admin` 的「稳定性设置」区直接改，
**改完即时生效、无需重启，并写入 `runtime/config/runtime.json` 持久保留**（重启后仍是管理台里设的值）。

| 管理台项 | 对应环境变量 | 说明 |
|---|---|---|
| 静默自动续接 | `TA_AUTO_RETRY` | 开/关 |
| 会话回收阈值 | `TA_RECYCLE_CACHE_CHARS` | 数字 |
| 续接看门狗(ms) | `TA_RETRY_IDLE_MS` | 数字 |
| 常规看门狗(ms) | `TA_STREAM_IDLE_MS` | 数字 |
| 存档触发字符 | `TA_ARCHIVE_MIN_CHARS` | 数字 |
| 近期消息字符 | `TA_RECENT_CHARS` | 数字 |
| 自动签到（在积分面板） | `TA_AUTO_SIGN` | 三档：`2`=启动检查(默认) / `0`=关闭 / `1`=启动+每天00:00:30定时 |
| 回复显示积分（在积分面板） | `TA_USAGE_FOOTNOTE` | 开/关（默认关，尾注会延迟回复） |
| 尾注等待(ms)（稳定性设置） | `TA_FOOTNOTE_WAIT_MS` | 默认 3000；官方记录常延迟 3–5 秒 |

优先级：**管理台配置文件 > 环境变量 > 代码默认**。即管理台改过的值会覆盖 `start.cmd` 里的 `set`；
点「恢复默认」会删除覆盖、回到环境变量/默认值。配置文件路径可用 `TA_RUNTIME_CONFIG_FILE` 改。
其余未列入管理台的环境变量仍需改 `start.cmd` 并重启。

## 环境变量总表

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `TA_PORT` | `8787` | 本地监听端口（只绑 127.0.0.1） |
| `TA_API_KEY` | 空 | 设置后要求 `Authorization: Bearer` 或 `x-api-key`（作为主密钥，与管理台生成的密钥并存） |
| `TA_KEYS_FILE` | `runtime/config/api-keys.json` | 管理台维护的密钥表路径 |
| `TA_ADMIN_TOKEN` | 空 | 设置后 `/admin/api/*` 需要令牌（页面会提示输入） |
| `TA_ADMIN_ALLOW_REMOTE` | 关 | 设为 `1` 允许非回环地址访问管理台；必须配合 `TA_ADMIN_TOKEN`，否则自动退回仅回环（Docker compose 默认 `1`） |
| `TA_REQUIRE_AUTH` | 关 | 设为 `1` 强制鉴权：未带有效 API 密钥的调用一律 401（0.7.5 起含 `GET /v1/models` 模型列表），优先于密钥表 requireAuth 设置（Docker compose 固定 `1`） |
| `TA_FALLBACK_PROMPT` | 中性助手 | 客户端没给系统提示词时的兜底人设 |
| `TA_BUILTIN_PROMPT` | 关 | 设为 `1` 使用内核自带的星辰人设（排障用） |
| `TA_UPSTREAM_BASE_URL` | 官方上游 | 覆盖上游地址，指向本机抓包代理 |
| `TA_DEFAULT_MODEL` | 目录第一个 | 客户端模型名匹配不上时的兜底 |
| `TA_ALLOW_KERNEL_TOOLS` | 关 | 设为 `1` 才放行 kernel 自带的 bash/read/write 等工具（默认全禁） |
| `TA_KERNEL_POOL_MAX` | `3` | kernel 池上限（按提示词指纹池化，LRU 只淘汰闲置 10 分钟以上的实例） |
| `TA_AUTO_RETRY` | `1` | `UPSTREAM_IDLE` 且未输出任何正文时，自动重建会话续接一次（等价 WorkBuddy 重试按钮）。`0`=关闭。详见 [RELIABILITY.md](RELIABILITY.md) |
| `TA_RETRY_IDLE_MS` | `120000` | 自动续接那一次的流空闲看门狗（比常规 240s 短，避免超过客户端 300s 超时） |
| `TA_RECYCLE_CACHE_CHARS` | `200000` | 会话 cacheRead 超此值即主动重建（仅作膨胀兜底，非卡死预防；卡死靠自动续接）。`0`=关闭。0.4.5 从 60000 上调 |
| `TA_ARCHIVE_MIN_CHARS` | `12000` | 长对话历史存档触发阈值：首轮历史超此值时完整落盘、只发最近摘要+检索指针。设极大值可关闭。详见 [RELIABILITY.md](RELIABILITY.md) |
| `TA_RECENT_CHARS` | `10000` | 存档模式下发给模型的最近消息预算（字符） |
| `TA_MAX_FOLD_CHARS` | `40000` | 单轮 prompt 体积预算（首轮折叠与增量轮共用）；超限丢最旧工具结果。`0`=关闭。详见 [RELIABILITY.md](RELIABILITY.md) |
| `TA_MAX_TOOL_CHARS` | `12000` | 单条工具结果截取上限（保头 60% + 尾 40%）。`0`=关闭 |
| `TA_STREAM_IDLE_MS` | `240000` | 流空闲看门狗：内容无增长超过该时长报 `UPSTREAM_IDLE`。`0`=关闭 |
| `TA_TURN_TIMEOUT_MS` | `1200000` | 单轮总时长上限（20 分钟） |
| `TA_GATEWAY_KEY` | — | 上游 gateway key（见下节；也可写 `local.secrets.json`） |
| `TA_AUTO_SIGN` | `2` | 积分签到：`2`=启动检查一次(默认) / `0`=关闭 / `1`=启动检查+每天00:00:30定时。可在管理台积分面板三档切换（即时生效、重启保留，优先于环境变量）。每日最多领一次、幂等。详见 [ADMIN.md](ADMIN.md) |
| `TA_POINTS_BASE_URL` | 官方 | 积分接口 base URL 覆盖（一般不用改） |
| `TA_POINTS_CHANNEL_ID` / `TA_POINTS_RUNTIME_ENV` | 空 | 积分接口的可选鉴权头（默认空即可用） |
| `TA_USAGE_FOOTNOTE` | 关 | 设为 `1` 在回复末尾追加本次积分消耗（轮询官方按次记录；默认关、会延迟回复，工具调用轮不加）。可在管理台积分面板切换 |
| `TA_FOOTNOTE_WAIT_MS` | `3000` | 尾注最多等待官方记录写入的毫秒数。官方常延迟 3–5 秒，取不到就不加尾注 |
| `TA_OPEN_ADMIN` | 关 | `start.cmd` 附带 `=1`：服务就绪后自动打开管理台 |
| `TA_TIMING` | 开 | 设 `0` 关闭 `/timing` 分段计时日志 |
| `TA_DEBUG_DIR` | 关 | 设置为目录后，按请求落一份原始 body（排查协议形状用，用完记得关） |
| `TA_MODEL` | `chat-flash` | 仅探针工具（`tools/probe-*.mjs`）使用 |
| `TA_SESSION_KEY` / `TA_KERNEL_PORT` | — | 仅 `tools/probe-kernel.mjs` 直连已运行内核时使用 |

## 获取上游 gateway key

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

## 提示词优先级

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

提示词指纹变了会**换一个 kernel**（会话映射同时清空；客户端本身每轮都会重放历史，
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
| 启动日志 | `[2026/11/17 08:23:37.786] 内核提示词：codex · 26043 字符 · 校验 通过` |

`client` 取值：`codex` / `claude` / `chat` / `neutral`（客户端没给提示词时的中性兜底）。

如果 `verified` 为 `false`，或内核里出现「星辰超级智能体」，启动日志会直接告警 ——
多半是 `TA_BUILTIN_PROMPT=1` 被设上了，或者内核版本升级后改了配置键。

离线核对（不经过网关，直接起一个内核看它吃进什么）：

```powershell
node tools/probe-prompt.mjs            # 下发一段带金丝雀的 Codex 风格提示词，看能否原样读回
node tools/probe-prompt.mjs --builtin  # 对照：内核自带人设长什么样
```
