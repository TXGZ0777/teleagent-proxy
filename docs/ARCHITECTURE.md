# 架构与内部机制

> 面向维护者的文档：请求链路、三协议适配、内核生命周期、事件流与工具桥，
> 以及桌面端升级后维护需要的反向工程结论。
> 客户端接入见 [CLIENTS.md](CLIENTS.md)，稳定性机制见 [RELIABILITY.md](RELIABILITY.md)，
> 配置见 [CONFIG.md](CONFIG.md)，管理台见 [ADMIN.md](ADMIN.md)。

## 请求链路

```
客户端 (OpenAI / Responses / Anthropic 协议)
   │  POST /v1/chat/completions | /v1/responses | /v1/messages
   ▼
本地 shim  http://127.0.0.1:8787/v1
   │  会话映射 / 上下文裁剪 / 流式翻译 / 错误归一 / 工具桥
   ▼
TeleAgent 自己的 Go kernel（独立进程，独立数据目录）
   │  解密登录态 + 原生签名
   ▼
TeleAgent 官方上游网关（sapi API）
```

> 上游域名不在文档中列出（维护时从桌面端 `app.asar` 的 provider 常量或
> `npm run capture` 抓包记录中即可看到）；本地排障可用
> `TA_UPSTREAM_BASE_URL` 把上游指向抓包代理。

请求由 TeleAgent **自己的 kernel** 加签发出，不是复刻签名直连；登录态只在本进程内存里解密。

## 为什么需要这层代理（大白话版）

前面讲的是"怎么做"，这一节用大白话讲"**为什么**这么做"。理解了这个，下面那些看起来很绕的机制就都顺理成章了。

### 限制到底在哪

一句话：**限制不在你的电脑、不在这个代理、也不是星辰软件本身，而在上游那个真正提供模型答案的服务**——它有个毛病：一次塞给它太多文字，它不报错、也不回答，就那么静静地卡住。

所以这个代理存在的全部意义，就是在请求送到上游之前，把文字压到它能正常回答的量级。

### 为什么非得夹一个"翻译官"

星辰（TeleAgent，官方叫"星辰超级智能体"、定位是 AI 办公助手）说一种"方言"（它自己内核的那套接口），WorkBuddy / DSH 说"普通话"（OpenAI 那套标准格式）。两边互相听不懂，于是代理夹在中间：一边翻译过去，一边翻译回来。

这里有个容易误解的点：**星辰本身不是一个纯聊天软件，它自己就是个智能体、办公助手，自带一整套工具（bash/read/write 等）、自己的系统提示词和会话管理**。所以这不是"聊天软件 vs 编码工具"的差别，而是**两套各自完整的智能体系统被硬拼到了一起**。

拼接的方式是：把星辰自带的工具**默认全关掉**（`TA_ALLOW_KERNEL_TOOLS` 默认关），改成把 WorkBuddy / DSH 的工具通过桥接挂上去。最终跑的是"星辰的脑子 + WorkBuddy 的手"这么一个混血。

### 真正把上游撑爆的是什么

WorkBuddy 这类编码助手有个习惯：每问一句话，都要把"我手上有哪些工具可以调用"的完整清单连同问题一起递过去（就是 WorkBuddy 用量分解里"工具及子智能体"那一大块），再加上把之前的对话历史反复重放、越聊背包越重。背到上游扛不住的量级，它就静默卡住——你看到的"卡几分钟然后超时"就是这么来的。

（注意：这不是星辰自己聊天会有的开销——单独用星辰时，它那套工具和历史管理是设计好、自洽的。开销是"拼接"这个动作带来的。）

### 为什么不能简单修好，只能这么绕

因为真正能改的地方只有中间这一段：

- 上游服务是别人的，改不了它"怕大输入"的毛病；
- WorkBuddy / DSH 是别人的软件，它就是要每次递那份工具清单；
- 唯一能动的就是中间这个代理。

所以 [RELIABILITY.md](RELIABILITY.md) 里那些看起来很绕的机制——历史存档、只带最近几句、按需检索、会话胖了就换、静默了自动续接——本质都是**同一件事：替模型卸行李**。它们各自的取舍和可能产生的影响，在那份文档里逐条写了。

### 什么情况下其实不需要这些绕路

如果直接用星辰软件本身干活，通常不需要这层翻译和卸行李。之所以还要绕，是因为 WorkBuddy / DSH 的环境更熟悉、有腾讯生态（"发布网页"这类事能一条龙处理）、或者需要用它支持的协议做工具调用适配——为了这些好处，接受这层开销是划算的。这是一次有意识的取舍，不是缺陷。

## 模块地图

| 文件 | 职责 |
|---|---|
| `server.mjs` | 入口：解析登录态 → 拉起 kernel → 起 shim |
| `lib/auth.mjs` | DPAPI + v10 解密、JWT 解析 |
| `lib/kernel.mjs` | kernel 启动（stdin payload）、env 组装、X-SA 签名、进程池与健康标记 |
| `lib/events.mjs` | `/event` SSE 消费、累积转增量、空闲看门狗、错误归一 |
| `lib/shim.mjs` | OpenAI 兼容路由（含 `/v1/chat/completions` 工具中继）、会话映射、流式输出 |
| `lib/responses.mjs` | Responses 协议适配 + 工具中继（Codex CLI） |
| `lib/anthropic.mjs` | Anthropic Messages 适配 + 工具中继（Claude Code / CC Switch） |
| `lib/toolbridge.mjs` | 工具桥：挂载、挂起、放行、内置工具开关 |
| `lib/mcp-server.mjs` | 最小 MCP 服务端（Streamable HTTP） |
| `lib/text.mjs` | 上下文体积控制原语（`fitEntries` 丢最旧工具条目、`trimMiddle` 截首尾） |
| `lib/log.mjs` | 时间戳日志助手（`[YYYY/MM/DD HH:MM:SS.mmm]`，与内核日志对表） |
| `lib/keystore.mjs` | API 密钥表：生成、校验、批量操作、按密钥计量 |
| `lib/admin.mjs` | 管理台页面与 `/admin/api/*` 接口 |
| `web/admin.html` | 管理台单页（原生 JS，无外部依赖） |
| `lib/paths.mjs` | TeleAgent 目录探测 |
| `tools/doctor.mjs` | 环境自检 |
| `tools/probe-prompt.mjs` | 提示词自检探针（`npm run probe:prompt`） |
| `tools/probe-kernel.mjs` | 最小链路探针（不经过 shim） |
| `tools/probe-tools.mjs` | 工具注册表探针（验证 MCP 挂载与内置工具开关） |
| `tools/capture-upstream.mjs` | 抓包代理：把上游请求原样转发并落盘，用于核对 system prompt |
| `tools/ccswitch-provider.mjs` | 把本网关注册成 CC Switch 供应商（`--app claude|codex`） |
| `tools/asar.mjs` / `slice.mjs` | 读客户端 `app.asar`（逆向用） |
| `examples/codex-config.toml` | Codex 直连本网关的配置样例 |
| `notes/` | 逆向时截下来的客户端源码片段 |

## 内核生命周期

- **启动**：kernel 无命令行参数；env 走 **stdin：4 字节大端长度 + JSON**；
  端口由 `SERVER_PORT` 决定。首次启动约 1–2 分钟，池内复用约 2 秒
- **数据目录**：default 内核用 `runtime/data`；池内非 default 实例用
  `runtime/data--k1/k2/...`（data/config/logs 隔离），内核日志在
  `runtime/data--kN/log/super-agent-server-*.log`（Go hertz server）
- **内核池**：按 `客户端类型 + 提示词指纹` 池化；LRU 上限 `TA_KERNEL_POOL_MAX`（默认 3），
  只淘汰闲置超过 10 分钟的实例，在途与挂起工具调用的内核不淘汰
- **健康回收**：内核带存活与健康状态；从池中取内核时校验 `isAlive()` 与健康标记，
  不健康则剔除重建（清空该内核上的会话映射）——详见 [RELIABILITY.md](RELIABILITY.md)
- **沙箱坑**：沙箱内 `spawn` 用管道 stdio 会 `EPERM` → payload 写临时文件、
  用 fd 作 stdin，内核就绪后立即删除

## 事件流与一轮对话

- `GET /event` 是全局 SSE；`message.part.updated` 的 `part.text` 是**累积全文**，
  网关负责转成增量 delta；`session.status{type:idle}` 收尾
- 内核会把自己收到的用户提示词也作为 part 发回来 → 必须按
  `sessionID + role=assistant` 过滤，否则回复开头是整段提示词
- 一轮结束后 `reader.read()` 的 Promise 会因 abort 拒绝 → 必须提前 `catch`，
  否则整个进程被未处理拒绝带走
- 失败/超时后要 `POST /session/:id/abort`，否则该会话永远 busy
- 空闲看门狗、单轮总时长等参数与"输出一顿一顿"的解释见 [RELIABILITY.md](RELIABILITY.md)

## 会话映射与提示词指纹

- 会话指纹 = 客户端类型 + 提示词指纹（chat 协议额外计入 `user` 字段，
  Anthropic 协议计入 `metadata.user_id`）；命中池复用同一内核会话，6 小时 TTL
- 提示词三层结构（内置人设 / `agent.build.prompt` / 环境块）与"空提示词回落星辰"的
  旧坑详见 [CONFIG.md](CONFIG.md)
- 指纹变化 → 换一个内核（会话映射同时清空）；工具调用挂起期间不切换，避免打断工具循环

## 工具桥（MCP 中继）

- 三协议的 `tools` 都挂成 kernel 侧 MCP 工具（`ta_*`）：模型调用时**挂起不返回**，
  翻译成协议各自的调用形状（`function_call` / `tool_calls` / `tool_use`）交回客户端；
  客户端执行完下一轮回填，网关放行挂起的调用，kernel 接着生成
- 两个实际卡死过的坑：MCP `tools/call` 必须**挂起**（立即返回占位会被 kernel 当结果继续编）；
  `takeCalls()` 不能清空挂起队列（否则续跑时无从放行）
- 内核自带工具默认全禁（prompt 的 `tools` 开关置 `false` + 叠一层 `permission: deny`）；
  `TA_ALLOW_KERNEL_TOOLS=1` 才放行。无工具轮次会把 MCP 工具开关一并关掉，防模型凭空调用

## 上游与鉴权（维护用）

| 环节 | Windows 实现 |
|---|---|
| 上游鉴权 | 由 kernel 完成：`SUPER_AGENT_AUTH_STATE`（AES-256-GCM 信封）解出 token，kernel 自己加 `X-SuperAgent-*` 头 |
| provider | 内核内置 `NewApi`；客户端常量 `apiKey` + `X-Route-Target: ops-gateway` + `useSuperAgentAuth` |
| 本地鉴权 | `X-SA-Signature = base64url(HMAC-SHA256(sessionKey, ["local-v1", METHOD, path, ts, nonce].join("\n")))` |

## 登录态解密（Windows）

| 环节 | 实现 |
|---|---|
| 登录态存储 | `~/.local/share/TeleAgent/users/<scope>/app-auth/token.json`，`scheme=safe_storage`，密文 `v10` |
| 解密 | Chromium OSCrypt：`Local State` → `os_crypt.encrypted_key`（`DPAPI` + base64）→ DPAPI 解保护得 32B 主密钥 → AES-256-GCM（`v10` + 12B nonce + 密文 + 16B tag） |
| 明文 | `<tenant>:<jwt>`，JWT 含 accountId / userId / accountName / exp（约 30 天） |

## 已知限制

- **角色被折叠成文本**：kernel 的 session API 只接受 parts，system/assistant/tool 会拼进一段文本；
  多轮语义没问题，但严格的 role 结构无法保留
- **工具中继三条协议都通了**：`/v1/responses`（Codex CLI 实测）、`/v1/chat/completions`
  （`tools`/`tool_calls`/role:tool）、`/v1/messages`（`tool_use`/`tool_result`，含流式
  `input_json_delta`）共用同一套 MCP 桥；chat/messages 两路已通过假内核冒烟测试，
  真客户端（Claude Code 改文件）待实测
- **并行工具调用未验证**：一次返回多个 `function_call`/`tool_use` 时按顺序下发，客户端会逐个执行
- **文件水印**：kernel 的 `report_final_files` 会给产出文件追加「AI生成」，已加入禁用表
  （默认不会出现）；如自行放行 kernel 工具需注意
- **每轮固定开销**：kernel 会带自己的系统提示词与工具 schema（实测单轮 ~1.0–1.2 万 input tokens），
  按 `chat-flash` x0.2 计也不便宜；工具多轮时每轮都要重发
- **依赖桌面端登录**：JWT 过期（约 30 天）后需在桌面端重新登录；换账号后重启代理即可
- **依赖逆向**：桌面端升级可能改 kernel 协议，升级后先跑 `node tools/doctor.mjs`
- **仅 Windows 验证**：macOS 路径在 `lib/paths.mjs` 里预留了 `TeleAgent` 二进制名，但未实测

## 桌面端升级排查清单

1. `node tools/doctor.mjs`——环境自检
2. 发一条消息后看 `GET /healthz` 的 `agent.verified` 是否仍为 `true`
3. `npm run capture` 核对实际发出的 system（详见 [CONFIG.md](CONFIG.md) 抓包排查）
4. 若协议变了，优先核对：stdin payload 形状、`/event` 事件名、`session.status` 收尾语义
