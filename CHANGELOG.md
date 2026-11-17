# Changelog

## [0.5.4] - 2026-11-18

### Added

- **管理台显示按次积分消耗**：积分面板新增「最近积分消耗」表格（时间/模型/实际积分/原价/折扣）
  与总览，数据来自官方 `/user/portal/usage/stats/record`，与官方 App 扣分一致、比每日汇总精确。
  新增 `GET /admin/api/points/usage?n=`。
- `lib/points.mjs` 新增 `getUsageRecords()` / `getUsageOverview()` / `findUsageAfter()`。
- **可选回复尾注**（默认关）：开启后在回复末尾追加"（本次消耗 X 积分）"，轮询官方记录最多
  等 `TA_FOOTNOTE_WAIT_MS`（默认 3000ms）。实测官方写入常延迟 3–5 秒，3 秒内可能取不到而不显示；
  尾注会延迟回复，工具调用轮不加。开关在积分面板，等待时长在稳定性设置。

## [0.5.3] - 2026-11-18

### Changed

- **自动签到档位1改为每天 00:00:30 定点执行**（原为每 1 小时轮询一次）。每日签到自然按天重置，
  定点执行比相对间隔更可预测、更少无效查询，并错开整点、跨天第一时间领。
  档位2（启动检查）与档位0（关闭）不变；调度器仍动态读档位、改档即时生效。

## [0.5.2] - 2026-11-18

### Added / Changed

- **积分面板加自动签到三档开关**（下拉框，即时生效、重启保留）：`2`=启动检查一次（默认）、
  `0`=关闭、`1`=启动检查+每小时（该档在 0.5.3 改为每天 00:00:30 定时）。
  纳入运行时配置系统（`TA_AUTO_SIGN`），调度器动态读档位，改档无需重启。积分/进度条区域行距加宽，每笔明细更宽松。
- `runtime-config` 新增 `enum` 类型与 `autoSign` 项；积分面板单独控制该项，稳定性设置区不再重复显示。

## [0.5.1] - 2026-11-18

### Changed

- **积分明细加进度条**：每笔积分下方显示「剩余积分/总积分」占比进度条（如邀请礼
  1382.73/3000 → 46%），7 天内将过期的进度条标红。`GET /admin/api/points` 的 `items[]`
  增加 `totalQuota`、`remainPct` 字段。

## [0.5.0] - 2026-11-18

### Added

- **积分有效期**：管理台积分卡片显示汇总到期日与剩余天数；新增可折叠的「积分明细」
  （每笔积分的名称/余额/到期日，按到期日升序，7 天内过期标红）。数据来自官方
  `points/detail` 的 `effectiveStart/effectiveEnd`（每笔自领取起约 30 天有效）。
  `GET /admin/api/points` 增加 `expiry` 与 `items[]` 字段。

## [0.4.9] - 2026-11-18

### Changed

- **签到改为默认自动**：每次启动延迟 20s 检查一次签到状态，今天没领就顺手领掉（幂等，已领跳过）。
  `TA_AUTO_SIGN=0` 完全关闭；`TA_AUTO_SIGN=1` 在启动检查之外额外每小时检查一次。
  之前的 0.4.8 是默认关闭、需手动设 `=1` 才启用。

## [0.4.8] - 2026-11-18

### Added

- **管理台「积分福利社」**：显示当前 TeleAgent 账号的积分余额、签到状态（累计天数/累计积分/
  今日是否可领），并提供「领取今日积分」按钮（确认后签到领 100 分，每天一次、幂等）。
  新增 `GET /admin/api/points`（只读查询）与 `POST /admin/api/points/sign`（领取）。
- `lib/points.mjs`：用本地已解密的登录态调用官方 `/user/portal/points/detail`、
  `companyStore/checkDayTask`、`v3/checkDayTask` 接口；静态分析官方 app.asar 确认这些是明文头
  鉴权（无需复刻内核签名），已实测取到真实余额与签到状态。登录态按 JWT exp 缓存。
- 可选 **代理侧自动签到** `TA_AUTO_SIGN=1`（默认关，官方 app 已内置每天 08:13 自动领取）：
  每小时检查、`claimedToday=false` 才领。附 `TA_POINTS_BASE_URL/CHANNEL_ID/RUNTIME_ENV` 覆盖项。

## [0.4.7] - 2026-11-18

### Added

- **管理台「运行日志」区**：显示最近代理日志（内存环形缓冲，最多 500 条），每 10 秒自动刷新，
  可选 100/200/500 条、滚动跟随、手动刷新。新增 `GET /admin/api/logs?n=`。
  `lib/log.mjs` 改造为 控制台 + 内存环形缓冲 + 落盘 `runtime/proxy.log`（UTF-8）——
  静默启动没有终端时，网页与 proxy.log 成为主要排障入口。
- **start.vbs 启动结果弹窗**：启动后轮询 `/healthz`（最多约 180 秒，兼容 `TA_PORT`），
  成功弹 `STARTUP OK`、超时/失败弹 `STARTUP FAILED`（附排查提示）。
  已在运行则提示 `ALREADY RUNNING`。后台进程脱离终端，关掉启动窗口不影响运行。

## [0.4.6] - 2026-11-17

### Changed

- **`TA_RECYCLE_CACHE_CHARS` 默认 60000 → 200000**（管理台默认值同步）。全量日志复核推翻了
  0.4.3 提出的"cacheRead 7.5 万卡死临界点"：1762 条 cost 记录 × 50 次卡死事件关联分析显示，
  卡死时 cacheRead 从 2.9 万到 37 万都有、无临界点，`in>30000` 的 110 个大输入轮全部成功。
  卡死是上游偶发静默断流，与上下文大小无确定阈值关系；原 6 万阈值会打断约 69% 正常工作中的
  请求且重建使缓存归零更慢。上调后该参数仅作"防止无限膨胀"兜底，**对抗卡死真正有效的是自动续接**。

### Docs

- `docs/RELIABILITY.md`、`docs/ARCHITECTURE.md`、`docs/CONFIG.md` 更正"7.5 万临界点"的错误论述，
  写明数据证据、弱相关性与各防线实际作用。

## [0.4.5] - 2026-11-17

### Added

- **后台静默运行脚本**：`start.vbs` 双击后在后台启动（无控制台窗口），PID 由 server.mjs
  写入 `runtime/proxy.pid`，启动记录写 `runtime/proxy-launch.log`；重复双击会检测并跳过。
  `stop.cmd` 读 PID 文件、**优雅停止**（先发终止信号，等最多 15 秒才强杀），清理 PID 文件。
  已实测完整启停链路：后台启动 → healthz 通过 → 停止 → 端口释放、无残留进程。
- server.mjs 增加 PID 文件管理与 **SIGHUP 监听**：Windows `taskkill`（不带 /F）发的是 SIGHUP
  而非 SIGTERM，不监听会绕过 shutdown 导致内核子进程/端口残留。

## [0.4.4] - 2026-11-17

### Added

- **管理台「稳定性设置」区**：6 个抗卡死参数（静默自动续接开关、会话回收阈值、续接/常规看门狗、
  存档触发字符、近期消息字符）可可视化修改，**即时生效、无需重启，并写入
  `runtime/config/runtime.json` 持久保留**。新增 `POST /admin/api/runtime`（保存/恢复默认），
  `/admin/api/state` 增加 `runtime` 字段。新增 `lib/runtime-config.mjs`，优先级
  配置文件 > 环境变量 > 代码默认；更新时同步回 `process.env`，覆盖全部三协议链路。
  `TA_RUNTIME_CONFIG_FILE` 可改配置文件路径。详见 `docs/ADMIN.md`、`docs/CONFIG.md`。

### Fixed

- 运行时配置 `reset` 后仍把当前值写进配置文件、导致"恢复默认"重启后失效的问题；
  现在只持久化被覆盖的项。（测试发现并修复）

## [0.4.3] - 2026-11-17

### Added

- **会话回收与自动续接**：解决"任务跑久了会话变胖仍会卡死"——0.4.2 的存档只作用于首轮，
  实测一个 8 分 38 秒的长任务里 cacheRead 从 4.1 万涨到 7.5 万后被 240s 看门狗掐断。
  现在每轮成功后检查 `result.tokens.cache.read`，超过 `TA_RECYCLE_CACHE_CHARS`（默认 60000，
  低于实测 7.5 万卡死点）即主动重建会话，下一条请求走存档摘要回到干净上下文。
- **上游静默自动续接**：`UPSTREAM_IDLE` 且未吐出任何正文、客户端未中止、非工具中继轮时，
  代理自动重建会话并重试一次（重试看门狗 `TA_RETRY_IDLE_MS` 默认 120s，避免超客户端 300s）。
  这是 WorkBuddy"重试"按钮的代理内等价物——DSH 等无配套插件的客户端不再需要手打"请继续"。
  `TA_AUTO_RETRY=0` 可关闭。设计决策与影响详见 `docs/RELIABILITY.md` 专节。

### Docs

- `docs/ARCHITECTURE.md` 新增"为什么需要这层代理（大白话版）"：用非术语语言解释限制在上游、
  为何必须夹翻译层、两套智能体系统拼接的开销来源，以及存档/回收机制的本质是"替模型卸行李"。

## [0.4.2] - 2026-11-17

### Added

- **长对话历史存档与按需检索**：解决 `chat-pro` 处理超大对话消息时静默卡死 240 秒的问题
  （逐项排除确认：与 system prompt / MCP / 模型本身无关，唯一变量是对话消息体量）。
  首轮历史超过 `TA_ARCHIVE_MIN_CHARS`（默认 12000）时，完整历史原样落盘到
  `runtime/archive/<会话指纹>.md`，只把最近约 `TA_RECENT_CHARS`（默认 **10000**）字符
  + 一段强制"动手前先 grep/read 存档确认进度"的指针发给模型。
  实测 12 万字符历史 → 首轮仅 10,266 字符（约 8%），`chat-pro` 从必卡变为正常推进，
  并观测到模型主动调用 `ta_Read`/`ta_Bash` 读存档。设计决策、妥协与影响详见
  `docs/RELIABILITY.md` 专节。
- `lib/archive.mjs`：存档写入（`writeArchive`）、近期摘要（`recentExcerpt`）、
  检索指针（`archivePointer`）、安全文件名（`makeArchivePath`）原语。

### Changed

- `TA_RECENT_CHARS` 初版默认 6000 → **10000**（改善近期细节记忆，仍远低于卡死输入区间）。
- 存档模式只作用于首轮；增量轮仍由内核保存历史并走 0.4.1 的裁剪机制。

## [0.4.1] - 2026-11-17

### Fixed

- **重启/中断后继续长对话必超时（根因修复）**：首轮折叠全部历史时，33 万字符级的上下文会让模型长时间静默思考
  （实测 >120 秒无事件），客户端超时后重试又重放同样的内容，确定性失败，只能反复手动发「请继续」。
  现在首轮折叠默认限 40k 字符（`TA_MAX_FOLD_CHARS`，`0`=关闭）：超限**优先丢弃最旧的工具结果**、
  保留用户/助手主线，折叠文本头注明省略。
- **增量轮无体积控制导致的"运行一段时间后超时"**：单条大工具结果（读大文件、长命令输出）或失败重试
  积压的一批消息同样触发长静默。增量轮现与首轮共用同一预算；超长单条工具结果截首尾保中间省略
  （`TA_MAX_TOOL_CHARS`，默认 12000）。三条协议（chat / responses / messages）行为一致。
- **空闲看门狗误杀长思考**：实测 50k 字符输入静默 75–90 秒、35k 会话重放静默 163.9 秒后一次性返回
  66,500 字思维链，均属"活着"。默认 120s→**240s**（仍短于 DSH 客户端自身的 300s 流空闲超时）；
  且活跃判定改为**内容真正增长才重置计时**——旧逻辑"任意会话事件都重置"会让真静默无限续期。
- 内核死亡或连续网络失败后，命中池时**剔除重建**（`isAlive` + 健康标记），旧内核上的会话映射一并清空，
  下一轮从折叠首轮开始（裁剪保证能继续），不再对着死内核重试到天荒地老。

### Added

- **连续卡死熔断**：同一会话 10 分钟内累计 2 次卡死（空闲超时 / 上游传输错误）后，下一次请求直接
  `400 CONVERSATION_STALLED` 并附处理建议，不再让客户端带着同样的大 prompt 一轮轮空转烧积分。
- `lib/text.mjs`：体积控制原语（`fitEntries` 丢最旧工具条目、`trimMiddle` 截首尾），
  供三协议的折叠与增量路径共用。
- **时间戳日志**（`lib/log.mjs`）：所有控制台输出的前缀从静态 `[teleagent]` 改为
  `[YYYY/MM/DD HH:MM:SS.mmm]` 本地时间，格式与内核日志一致，可与
  `runtime/data--kN/log/super-agent-server-*.log` 毫秒级对表排障。

### Changed

- 内核池默认上限 6→**3**（`TA_KERNEL_POOL_MAX`）。

### Docs

- README 重构为入口文档（456 行 → 77 行），细节拆分为 5 个分册：
  `docs/CLIENTS.md`（客户端接入）、`docs/RELIABILITY.md`（稳定性与上下文管理）、
  `docs/CONFIG.md`（环境变量与提示词优先级）、`docs/ADMIN.md`（Web 管理台）、
  `docs/ARCHITECTURE.md`（架构、内核生命周期、反向工程结论与已知限制；
  上游域名在文档中改用间接描述，代码内默认值不受影响）。

## [0.4.0] - 2026-11-16

### Added

- **内核池（并发对话互踢修复）**：提示词指纹相同的并发请求此前共用同一个 kernel，
  后到的会踢掉在途对话（上游 `terminated`）。现在按 `client + 提示词哈希` 池化 kernel：
  命中即复用、不 close；LRU 上限 `TA_KERNEL_POOL_MAX`（默认 6），只淘汰闲置超过 10 分钟的实例；
  非 default 实例用独立 `data--k1/k2/...` 目录隔离 data/config/logs，default 实例保持原 `runtime/data`。
  实测 Pro 与 Flash 两个内核同时在途、同对话跨轮复用同一内核同一 sessionID、单内核多会话并发零串台。
- **三协议工具中继打通**：此前只有 `/v1/responses`（Codex CLI）能把 `tools` 挂成 kernel 侧 MCP 工具，
  现在三条协议共用同一套桥（挂起 → 取走 → 客户端执行 → 下一轮放行 → 续跑）：
  - `/v1/chat/completions`：`tools`（type:function）挂桥，模型调用翻成 `tool_calls`
    （非流式 `finish_reason:"tool_calls"`；流式 `delta.tool_calls` 分块），
    客户端回填 `role:"tool"` 消息后放行续跑。
  - `/v1/messages`（Anthropic）：`tools`（input_schema）挂桥，模型调用翻成 `tool_use` 块
    （非流式 `stop_reason:"tool_use"`；流式 `content_block_start` → `input_json_delta` → `content_block_stop`），
    客户端回填 `tool_result` 块后放行续跑；调用 id 双向前缀互转（`call_*` ↔ `toolu_*`）。
  - `metadata.user_id` 计入 Anthropic 会话指纹，避免同客户端不同账号串会话。
  - 无工具轮次且 kernel 挂过工具时，下发的工具开关表全置 `false`（含 MCP 工具），防止模型凭空调用；
    首轮导入历史时折叠 `tool` / `tool_result` 消息，工具结果不再丢失。
- chat / messages 两路通过假内核冒烟测试（20/20：发起、取走、放行、续跑、流式/非流式全链路）；
  真客户端（Claude Code 改文件）待实测。

### Fixed

- 并发对话互踢导致的 `upstream_error: terminated`（见内核池）。
- `GET /v1/models` 忽略查询串：DSH 的 anthropic 协议模型列举带 `?limit=1000`，
  此前严格等值匹配 `req.url` 会 404；现改用剥查询串后的 `urlPath` 比较。

## [0.3.2] - 2026-11-07

### Added

- **提示词自检**：每次启动 / 切换内核后回读内核 `GET /config`，核对 `agent.build.prompt`
  是否真的是下发的版本；结果暴露为 `/healthz` 的 `agent` 字段
  （`client` / `promptChars` / `promptSha` / `verified`），并同步显示在管理台「接入信息 → 提示词」。
  这样「模型又自称星辰」时，不必再靠猜是客户端没发提示词、还是内核没用上。
- `tools/probe-prompt.mjs`（`npm run probe:prompt`）：离线起一个内核，下发带金丝雀的提示词再读回，
  `--builtin` 可对照内核自带人设。
- 启动日志会明确打印当前提示词来源与字符数；`verified` 为 `false` 或内核里出现「星辰超级智能体」时告警。

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
