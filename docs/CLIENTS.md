# 客户端接入

三条协议（OpenAI Chat Completions / OpenAI Responses / Anthropic Messages）共用同一套
会话映射、上下文裁剪与工具中继，但**客户端填的 baseURL 不一样**：

| 协议 | 网关实际路径 | 客户端 baseURL | 路径规则 |
|---|---|---|---|
| OpenAI Chat Completions | `POST /v1/chat/completions` | `http://127.0.0.1:8787/v1`（带 `/v1`） | 客户端在 baseURL 后拼 `/chat/completions`；裸 `/chat/completions`（不带 `/v1`）也兼容 |
| OpenAI Responses | `POST /v1/responses` | `http://127.0.0.1:8787/v1`（带 `/v1`） | 必须带 `/v1`，客户端在 baseURL 后拼 `/responses` |
| Anthropic Messages | `POST /v1/messages` | `http://127.0.0.1:8787`（**不带** `/v1`） | 网关只认带 `/v1` 的完整路径；`/v1` 由客户端 SDK 自己拼 |

> 记法：跟各家官方 SDK 的习惯走——OpenAI 系官方 `base_url` 都带 `/v1`
> （`https://api.openai.com/v1`），SDK 在后面拼 `/chat/completions`、`/responses`；
> Anthropic 官方 `base_url` 不带（`https://api.anthropic.com`），SDK 自己拼 `/v1/messages`。

## OpenAI SDK / 任意兼容客户端

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="not-needed")
r = client.chat.completions.create(
    model="chat-flash",
    messages=[{"role": "user", "content": "你好"}],
)
print(r.choices[0].message.content)
```

`api_key` 随便填；如果启动时设了 `TA_API_KEY` 或在管理台建了密钥，则必须与之一致。

## WorkBuddy 等图形客户端

以 WorkBuddy 为例（Cherry Studio / ChatBox 等同类客户端字段类似）。协议选
**OpenAI Chat Completions 兼容**，其余按下表填：

| 设置项 | 填什么 |
|---|---|
| API 地址（Base URL） | `http://127.0.0.1:8787/v1`（末尾带 `/v1`，**不要**自己再拼 `/chat/completions`） |
| API Key | 任意；设了 `TA_API_KEY` 或管理台密钥时填一致的 |
| 模型 ID | `chat-pro` / `chat-flagship` / `chat-flash` |
| 工具调用（Tools / Function Calling） | **建议开启**，见下 |

**工具调用开关要不要勾？**

- 要让客户端侧的工具生效（联网搜索、读文件、生成图片等），**必须勾选**。
  网关三条协议都完整支持工具中继：请求里的 `tools` 会被注册成内核侧的 MCP 工具，
  模型决定调用时网关**挂起不返回**，把调用翻成标准格式交回客户端执行；
  客户端执行完带着结果回灌，模型接着生成（与下文 Codex CLI 是同一套桥，已实测）。
- 纯聊天可以不勾。不勾时请求里没有 `tools`，网关按纯对话处理，模型不发起任何工具调用。
- 安全边界：模型只会调用"客户端发来的工具"。桌面端内核自带的工具在对话中继轮一律关闭，
  不存在网关自作主张调用本地工具的情况。

## DSH（DeepSeek Harness）

DSH 的 `llm-pi-ai` 插件同时支持三种协议，在 cordis 配置的 `config.providers` 下按需配
一个或多个 provider。**三种协议的 `baseURL` 规则不同**（以 pi-ai 内置 provider 的官方
写法为准，已在源码核对）：

| `api` | `baseURL` 填法 | 实际请求路径 |
|---|---|---|
| `openai-completions` | `http://127.0.0.1:8787/v1`（带 `/v1`） | `/v1/chat/completions` |
| `openai-responses` | `http://127.0.0.1:8787/v1`（带 `/v1`） | `/v1/responses` |
| `anthropic-messages` | `http://127.0.0.1:8787`（**不带** `/v1`） | `/v1/messages`（SDK 自己拼） |

推荐配置（实测生效的形状，三个 provider 的 `models` 块相同，按需启用其一或全配）：

```yaml
- id: llm-pi-ai
  config:
    providers:
      # 日常推荐：OpenAI Chat Completions
      teleagent-completions:
        displayName: TeleAgent 本地反代
        api: openai-completions
        baseURL: http://127.0.0.1:8787/v1        # 带 /v1
        models:
          - id: chat-flagship
            contextWindow: 400000
            maxTokens: 65536
            name: 旗舰-1x
          - id: chat-pro
            contextWindow: 400000
            maxTokens: 65536
            name: Pro-0.6x
          - id: chat-flash
            contextWindow: 400000
            maxTokens: 65536
            name: Flash-0.2x
        apiKeyEnv: TELEAGENT_API_KEY             # 网关密钥放该环境变量；未启用网关密钥时值随意

      # 需要 Responses 协议时再启用：
      # teleagent-responses:
      #   displayName: TeleAgent 反代（Responses）
      #   api: openai-responses
      #   baseURL: http://127.0.0.1:8787/v1      # 带 /v1
      #   （models / apiKeyEnv 同上）

      # 需要 Anthropic 协议时再启用：
      # teleagent-anthropic:
      #   displayName: TeleAgent 反代（Anthropic）
      #   api: anthropic-messages
      #   baseURL: http://127.0.0.1:8787         # 不带 /v1！SDK 自己拼 /v1/messages
      #   （models / apiKeyEnv 同上）
```

使用时模型按 `<provider id>/<model id>` 引用，例如 `teleagent-completions/chat-flash`。

补充：

- `anthropic-messages` 下 DSH 可能调用的 `count_tokens`（`/v1/messages/count_tokens`）网关已实现。
- 三种协议发来的 `tools` 走同一套工具中继，开关行为见上文 WorkBuddy 一节。
- 改完配置重启 DSH 生效，模型选择器里出现对应条目。

## curl

```powershell
curl.exe -N -X POST http://127.0.0.1:8787/v1/chat/completions `
  -H "Content-Type: application/json" `
  -d '{\"model\":\"chat-flash\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}]}'
```

## 接 Codex CLI

> 命名说明（2026-07 起）：OpenAI 已把独立的 Codex 桌面端并入统一的 **ChatGPT 桌面应用**
> （Chat / Work / Codex 三种模式，Codex 成为其中一个模式）。**CLI 本身没有改名**：
> 命令仍是 `codex`，配置仍是 `~/.codex/config.toml`，本节的配置与实测照旧适用；
> 其余 Codex 字样（`wire_api`、cc-switch 的 `--app codex` 等）均为技术标识，未随改名变化。

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
| `claude`（Claude Code） | `POST /v1/messages` | ✅ 已实现，`tool_use`/`tool_result` 走同一套工具桥（冒烟测试通过） |
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
