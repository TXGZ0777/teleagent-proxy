# 客户端接入

端点统一是 `http://127.0.0.1:8787/v1`；三条协议（OpenAI / Responses / Anthropic）
共用同一套会话映射、上下文裁剪与工具中继。

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

## Cherry Studio / ChatBox 等图形客户端

- API 地址：`http://127.0.0.1:8787/v1`
- API Key：任意（或与 `TA_API_KEY` 一致）
- 模型：`chat-pro` / `chat-flagship` / `chat-flash`

## DSH（DeepSeek Harness）

DSH 内置 provider 只认自己的协议；要用这里的端点，按"OpenAI 兼容自定义 provider"配置，
`baseURL = http://127.0.0.1:8787/v1`，模型填 `deepseek-account/<你的模型名>` 形式的自定义路由。

## curl

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
