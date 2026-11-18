# teleagent-proxy

把本机已登录的 **TeleAgent（天翼 AI 星辰超级智能体桌面端，Windows 版）** 反代成一个
**本地 OpenAI 兼容端点**：任何支持 `base_url` 的客户端（OpenAI SDK、Cherry Studio、
DSH、各类 IDE 插件）都能直接把它当 OpenAI 用。

> **免责声明**：本项目是对**本机已安装客户端行为**的互操作研究，用于把自己已有的账号接入
> 自己的工具链。仓库**不含**任何登录凭据、用户数据或上游密钥；使用前请确认你拥有该账号，
> 并自行遵守 TeleAgent 的服务条款与当地法律。仅供个人自用，**不要**对外提供代理服务、
> 转售额度或绕过计费。

```
客户端 (OpenAI / Responses / Anthropic 协议)
   │
   ▼
本地 shim  http://127.0.0.1:8787/v1
   │  会话映射 / 上下文裁剪 / 流式翻译 / 错误归一 / 工具桥
   ▼
TeleAgent 自己的 Go kernel（独立进程，独立数据目录）
   │  解密登录态 + 原生签名
   ▼
TeleAgent 官方上游网关
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

**后台静默运行（无黑窗）**：双击 `start.vbs` 即可。它在后台启动 node（不弹控制台窗口），
把进程 PID 写入 `runtime/proxy.pid`，启动记录写到 `runtime/proxy-launch.log`。
重复双击会检测已在运行并跳过。要停止时运行 `stop.cmd`：它读 PID 文件、优雅关闭
（发终止信号让服务清理内核与端口，最多等 15 秒，超时才强杀），然后删掉 PID 文件。
对手动启动（`start.cmd` / `node server.mjs`）的实例，先手动把 PID 写进 `runtime/proxy.pid`
也能用 `stop.cmd` 停止；否则请用任务管理器结束对应 `node.exe`。

> 注：后台模式没有实时日志窗口，但有三处可看日志：
> ① 管理台网页 `/admin` 的「运行日志」区（每 10 秒自动刷新，可暂停/选条数）；
> ② `runtime/proxy.log`（UTF-8，所有代理日志落盘）；
> ③ 内核日志 `runtime/data*/log/super-agent-server-*.log`。
> 启动脚本会轮询 `/healthz`，弹出「STARTUP OK / FAILED」提示。
> 后台进程已脱离终端，关闭启动它的窗口不会结束代理；停止请用 `stop.cmd`。

启动后（日志带毫秒时间戳，可与内核日志对表排障）：

```
[2026/11/17 08:23:37.786] 账号 <你的昵称> · kernel 3.0.0-dev-...
[2026/11/17 08:23:37.xxx] OpenAI 兼容端点: http://127.0.0.1:8787/v1
[2026/11/17 08:23:37.xxx] 模型: chat-pro, chat-flagship, chat-flash
[2026/11/17 08:23:37.xxx] API 密钥: 0 启用 / 0 总数 · ...\runtime\config\api-keys.json
[2026/11/17 08:23:37.xxx] 管理台: http://127.0.0.1:8787/admin
```

前置条件（缺一不可）：

1. 已安装 TeleAgent 桌面端，且**已登录**、至少打开过一次对话（要生成 `model-catalog.json`）
2. 本机配置上游 gateway key——获取方式见 [docs/CONFIG.md](docs/CONFIG.md)（**仓库不附带**）

浏览器打开 **http://127.0.0.1:8787/admin** 即管理台（建密钥、批量启停、看调用量），
功能详见 [docs/ADMIN.md](docs/ADMIN.md)。

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
| POST | `/v1/chat/completions` | OpenAI 协议，支持 `stream`、多轮、`reasoning_content`、`tools` 工具中继 |
| POST | `/v1/responses` | Responses 协议（Codex CLI），流式事件完整，工具中继已实测 |
| POST | `/v1/messages` | Anthropic Messages 协议（Claude Code / CC Switch），`tool_use`/`tool_result` 工具中继 |
| POST | `/v1/messages/count_tokens` | 粗略 token 估算 |
| GET | `/healthz` | 代理与 kernel 状态（鉴权开关、启用密钥数、当前生效的提示词来源） |
| GET | `/admin` | Web 管理台（仅回环地址） |
| POST | `/admin/api/*` | 密钥与鉴权管理接口（详见 [docs/ADMIN.md](docs/ADMIN.md)） |

行为约定：

- 流式：标准 `chat.completion.chunk` + `data: [DONE]`，思维链走 `delta.reasoning_content`
- 非流式：聚合后一次返回，同样带 `reasoning_content` 与 `usage`
- 错误：HTTP 4xx/5xx + `{error:{message,type,code}}`；额度不足统一成 `insufficient quota`
- 会话：按 `user` 字段或「首条用户消息」指纹复用 kernel 会话，6 小时 TTL；kernel 侧保留历史
- 工具：三协议的 `tools` 都挂成 kernel 侧 MCP 工具（`ta_*`），模型调用时挂起、翻回客户端执行、
  下一轮回填放行；无工具的轮次会把 MCP 工具一并关掉，防止模型凭空调用

## 客户端接入

端点统一是 `http://127.0.0.1:8787/v1`。OpenAI SDK / WorkBuddy 等图形客户端 / DSH /
Codex CLI / Claude Code（CC Switch）/ curl 的具体配置见 **[docs/CLIENTS.md](docs/CLIENTS.md)**。

## NAS / Docker 部署（0.7.0 起，0.7.2 起支持 ARM64）

不想让 PC 常驻？Linux 镜像（内核/ais/node/python 均为官方 deb 原包，构建时 sha256 校验）
+ 凭据导出工具 + 续期守护已经就位：PC 跑一次
`node tools/export-credentials.mjs`，NAS 上 `docker compose up -d` 即可，
续期由容器自动完成（**首次续期后 PC 桌面端需重新登录一次**，详见文档第 6 节）。
GHCR 镜像为**多架构清单**（amd64 + arm64），ARM64 NAS（ARM 版 fnOS 等）同样一条
`docker compose up -d`。完整步骤见 **[docs/nas-docker.md](docs/nas-docker.md)**。

## 稳定性（0.4.1 起）

长对话在代理或桌面端重启后可以**直接继续**，不再"必超时、要反复发请继续"：

- **上下文裁剪**：单轮 prompt 超预算时丢最旧的工具结果、保留用户/助手主线
  （默认 40k 字符，`TA_MAX_FOLD_CHARS`）；超长单条工具结果截首尾（`TA_MAX_TOOL_CHARS`）
- **空闲看门狗 240 秒**：内容无增长才报 `UPSTREAM_IDLE`，给长思考留足耐心
- **连续卡死熔断**：同一会话反复卡死后直接返回 `400 CONVERSATION_STALLED`，不再空转重试
- **内核池 + 健康回收**：按 `客户端 + 提示词指纹` 池化 kernel（上限 3），
  死内核自动剔除重建；并发对话互不干扰

机制、实测数据与调参指南见 **[docs/RELIABILITY.md](docs/RELIABILITY.md)**。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/CLIENTS.md](docs/CLIENTS.md) | 各客户端接入：OpenAI SDK、DSH、Codex CLI、CC Switch、curl |
| [docs/nas-docker.md](docs/nas-docker.md) | NAS / Docker 部署：凭据导出、compose、续期守护与排错 |
| [docs/RELIABILITY.md](docs/RELIABILITY.md) | 稳定性与上下文管理：裁剪、看门狗、熔断、内核池、排障速查 |
| [docs/CONFIG.md](docs/CONFIG.md) | 全部环境变量、上游 gateway key 获取、提示词优先级与自检 |
| [docs/ADMIN.md](docs/ADMIN.md) | Web 管理台：密钥管理、鉴权模式、流水 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构与内部机制、反向工程结论、已知限制（维护用） |

## 版本

当前版本 **0.7.2**，变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## 安全与合规

- PC 版只监听 `127.0.0.1`；在管理台新建密钥（或设 `TA_API_KEY`）即可要求鉴权，
  避免同机其他程序白嫖你的额度。Docker/NAS 版监听 `0.0.0.0`（容器语义），
  **务必设置 `TA_API_KEY`** 再把端口暴露给局域网
- 管理台仅回环可访问，但仍不建议把 8787 端口通过内网穿透/反代暴露出去
- 登录态只在进程内存中出现；含 token 的临时 payload 在 kernel 就绪后立即删除
- 这是**自用**工具：不要对外暴露、不要分发账号额度、不要用于绕过计费。
  与官方客户端相比，请求节奏、system 提示词、工具集合都不同，请自行评估账号风险
