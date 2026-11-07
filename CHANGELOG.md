# Changelog

## [0.3.1] - 2026-11-07

### Fixed

- **内置「星辰超级智能体」提示词盖过客户端提示词**。抓包（`tools/capture-upstream.mjs`）确认：
  内核把 `agent.build.prompt` 作为唯一一条 `system` 消息发往上游，一旦该配置缺省就会回落到
  硬编码的内置人设（强制中文、拒绝透露提示词、自称星辰）。原实现里客户端没给提示词时传空串，
  于是回落——现在**始终显式覆盖**，空提示词改用中性兜底 `NEUTRAL_AGENT_PROMPT`。
- 只取**第一条** `system` 消息作为提示词，导致客户端把提示词拆成多条（或写在 `developer` 角色、
  Responses 的 `input` 里）时丢失；现在 `system` / `developer` 全部按顺序合并。
- 首轮把 system 文本又拼进用户消息，等于把两份指令同时喂给模型；已移除，system 只作为 agent prompt 存在。

### Added

- `tools/capture-upstream.mjs` + `TA_UPSTREAM_BASE_URL`：把内核上游请求引到本机抓包代理，
  落盘 `runtime/capture/req-*.json`，用来看清真正发出去的 system prompt。
- `TA_FALLBACK_PROMPT`：自定义「客户端没给提示词」时的兜底人设。
- `TA_BUILTIN_PROMPT=1`：显式要求使用内核自带提示词（排障/对比用）。
- `npm run capture` 快捷启动抓包代理。

## [0.3.0] - 2026-11-07

### Added

- **Web 管理台**：`http://127.0.0.1:8787/admin`（访问 `/` 自动跳转）。单文件页面，无外部依赖：
  概览卡片（密钥数 / 启用数 / 今日请求 / 累计请求）、近 14 天调用趋势、密钥表格、最近调用流水。
- **多 API Key**：`lib/keystore.mjs` 管理密钥表，支持批量生成（1–50 把）、命名、备注、有效期、
  停用/启用、删除、重置统计；密钥落 `runtime/config/api-keys.json`（已被 `.gitignore` 覆盖）。
- **批量操作**：表格支持全选/多选后批量启用、停用、重置统计、删除。
- **按密钥计量**：每次调用记录到具体密钥（今日/累计次数、输入输出 token、最后使用时间），
  三套协议（OpenAI / Responses / Anthropic）都会记账；流式请求同样统计。
- **鉴权模式**：`自动`（密钥表非空即校验）/ `强制校验` / `关闭校验`，管理台可即时切换。
  环境变量 `TA_API_KEY` 仍然有效，作为不受管理的「主密钥」直接放行。
- 管理接口：`/admin/api/state`、`/admin/api/keys`、`/admin/api/keys/:id`、
  `/admin/api/keys/bulk`、`/admin/api/settings`。
- 环境变量 `TA_KEYS_FILE`（自定义密钥表路径）、`TA_ADMIN_TOKEN`（给管理接口加令牌）。
- `GET /healthz` 增加 `authRequired` 与启用密钥数。

### Security

- 管理台只接受回环地址访问（服务本身也只绑 `127.0.0.1`）；设置 `TA_ADMIN_TOKEN` 后，
  所有 `/admin/api/*` 都需要携带该令牌。

### Fixed

- 密钥全部停用后，`自动` 模式不再意外退回「允许匿名调用」——只要密钥表非空就必须带 key。

## [0.2.0] - 2026-11-07

### Added

- **按客户端切换系统提示词**：Codex 用请求里的 `instructions`、Claude Code 用 `system`、
  OpenAI 兼容客户端用首条 `system` 消息作为 kernel 的 `agent.build.prompt`；
  提示词变化时自动切换内核并清空会话映射（工具调用挂起期间不切）。
- **Responses 协议的工具中继**：客户端的 `tools` 挂成 kernel 侧 MCP 工具，
  模型调用时挂起，翻成 `function_call` 交回客户端执行，结果在下一轮请求里回填。
- **custom（freeform）工具支持**：`apply_patch` 这类不是 JSON 参数的工具，
  包装成单字符串参数 `input`，回传时还原为 `custom_tool_call` / `custom_tool_call_output`，
  并补 `response.custom_tool_call_input.delta/done` 事件。
- `examples/codex-config.toml`：Codex 直连本网关的最小配置。
- `tools/ccswitch-provider.mjs`：把本网关注册为 CC Switch 的 claude / codex 供应商。
- `tools/probe-tools.mjs`：工具注册表探针（验证 MCP 挂载与内置工具开关）。
- 环境变量 `TA_GATEWAY_KEY` / `local.secrets.json` 提供上游 gateway key。

### Fixed

- **身份被 kernel 钉死成「星辰超级智能体」**：对话层声明无效（模型会拒绝），
  改为启动内核时替换 `agent.build.prompt`。实测 Codex 已正确回答「我是 Codex」。
- **产出文件被追加「AI生成」水印**：kernel 的 `report_final_files` 触发水印插件，
  连同 `session_*`、`skill_*` 等副作用工具一并禁用。
- 模型 `options.temperature: true` 会被上游当成布尔值拒绝（400），不再写入。
- 内核切换后工具桥不会重新挂载的问题（`bridge.attach`）。
- 事件流读取在 abort 时产生未处理拒绝、导致进程退出的问题。

## [0.1.0] - 2026-11-06

### Added

- 复用桌面端登录态（Chromium `v10` + DPAPI 解密），经 kernel 原生签名访问上游。
- `/v1/chat/completions`、`/v1/responses`、`/v1/messages` 三套协议。
- 流式 SSE、思维链 `reasoning_content`、错误归一（含 `insufficient quota`）。
- `tools/doctor.mjs` 环境自检、`tools/probe-kernel.mjs` 链路探针。
