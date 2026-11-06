# Changelog

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
