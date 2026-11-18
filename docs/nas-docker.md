# TeleAgent NAS / Docker 部署指南（fnOS / 通用 Docker）

把 TA2API 从「PC 常驻」搬到 NAS：**gateway**（OpenAI 兼容端点）与 **renew**（凭据续期守护）
两个角色共用同一个 Linux 镜像，用不同 command 区分，共享同一个凭据数据根卷。
PC 侧只需要做一件事——跑一次导出工具。

```
PC（Windows，跑一次导出工具）
   │  ta-export/（凭据 + 主密钥）
   ▼  SMB / scp
NAS Docker
   ├─ gateway 容器 :8787 → OpenAI 兼容端点（/v1/chat/completions / /v1/responses / Anthropic）
   │     └─ TeleAgent 官方 Linux kernel（镜像内置，官方 deb 原包）
   └─ renew 容器 → 每 6h 检查、每日至多一次 token-refresh（桌面端同款协议）
         共享卷：/data = ta-export（凭据数据根）
```

**完整性链**：镜像内的 kernel / ais / node / python / ripgrep 全部来自官方 deb 包内的
Linux runtime 压缩档（逐字节 sha256 与 deb 清单一致），清单固化在
`docker/payload-manifest.txt`；python 包 111MB 超过 GitHub 单文件限制，所以载荷挂在仓库
Release（tag `payload-3.1.0-dev-20261116`），**构建时下载并 sha256 校验**，校验不过构建直接失败。

---

## 0. 前置条件

| 项 | 要求 |
| --- | --- |
| PC | Windows，TeleAgent 桌面端**已登录**（导出与 DPAPI 解密都在 PC 上完成） |
| NAS | 有 Docker（fnOS：应用中心装 Docker / Compose）；能访问 GitHub（拉 GHCR 镜像、构建时下载 Release 载荷） |
| Node | PC 上要有 Node ≥ 20（跑导出工具；桌面端用户一般已有） |
| 网络 | NAS 与 PC 能访问 `agent-pre.teleai.com.cn`（登录/续期）与模型流量网关 |

## 1. PC：导出凭据（一次性）

```powershell
cd teleagent-proxy
node tools/export-credentials.mjs            # 导出到 .\ta-export
# 或指定目录：
node tools/export-credentials.mjs --out D:\ta-export
```

工具做三件事：① DPAPI 解出 32B 主密钥写成 `crypt-key.b64`；② 拷贝 NAS 需要的最小文件集；
③ **round-trip 校验**——用导出的主密钥解开导出的 token.json，确认是合法 JWT 才算成功
（输出 `round-trip : OK — token 可解，N 天后过期`）。

导出产物（相对 `ta-export/`）：

| 文件 | 用途 |
| --- | --- |
| `current-owner.json` | 当前账号定位（resolveOwner） |
| `Local State` | 桌面端同构目录（v10 密钥容器） |
| `app-auth/device-meta.json` | deviceId（续期请求的设备头） |
| `runtimes/.version.json` | PC 桌面内核版本（X-App-Version 语义） |
| `users/<账号>/app-auth/token.json` | 加密登录态（renew 读+写回的同一文件） |
| `users/<账号>/model-catalog.json` | 模型目录（gateway `/v1/models` 的来源） |
| `ta-export-meta.json` | 导出时间与版本记录 |
| `crypt-key.b64` | **32B 主密钥（base64 单行）→ 第 3 步的 `TA_CRYPT_KEY`** |

> ⚠️ `crypt-key.b64` 等同账号凭据：不要提交进 git（`ta-export/` 已被 .gitignore）、
> 不要发给别人、放在只有你自己能读的 NAS 目录里。

## 2. 拷贝到 NAS

整个 `ta-export` 目录原样拷到 NAS，例如 fnOS 共享文件夹：

```
/vol1/1000/docker/ta2api/data/        ← ta-export 的内容放在这里
├── current-owner.json
├── Local State
├── app-auth/device-meta.json
├── runtimes/.version.json
├── users/<账号>/app-auth/token.json
├── users/<账号>/model-catalog.json
├── ta-export-meta.json
└── crypt-key.b64
```

（Linux 文件权限：确保运行容器的用户可读；token.json 在续期成功后会被容器以 0600 重写，属主变为容器内 uid，属正常现象。）

## 3. 准备 .env

在仓库根目录（或 fnOS 的 compose 工作目录，保证 `docker/docker-compose.yml` 相对路径成立）：

```bash
cp docker/.env.example .env
```

编辑 `.env`，三个关键字段：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `TA_DATA_ROOT` | ✅ | 指向第 2 步的数据根目录，如 `/vol1/1000/docker/ta2api/data` |
| `TA_CRYPT_KEY` | ✅ | `crypt-key.b64` 的**内容**（一行 base64），不是文件路径 |
| `TA_API_KEY` | 强烈建议 | 端点 Bearer 密钥；端口暴露在局域网时必须设置 |

可选：`TA_PORT`（宿主映射端口，默认 8787）、`TA_OS_TYPE`（积分接口 OS 头覆盖）。

## 4. 启动

```bash
docker compose -f docker/docker-compose.yml up -d
```

fnOS 图形界面：Docker → Compose → 新建项目，compose 文件选 `docker/docker-compose.yml`，
项目目录放在仓库根（`.env` 所在目录），启动即可。

会起两个容器：`ta2api-gateway`（端点）+ `ta2api-renew`（续期守护，桌面端同款节奏：
启动补偿 + 每 6h 检查、按日去重每日至多一次）。

首次启动 entrypoint 会做软链兜底（镜像内置 runtime 挂进数据根）并检查凭据文件，
缺文件时会打印 `[entrypoint] 数据根缺少 xxx —— 先在 PC 上按 docs/nas-docker.md 完成凭据导出` 并退出——按提示补齐重跑。

## 5. 验证

```bash
# 模型列表（带 Bearer）
curl http://NAS_IP:8787/v1/models -H "Authorization: Bearer $TA_API_KEY"

# 一次对话
curl http://NAS_IP:8787/v1/chat/completions \
  -H "Authorization: Bearer $TA_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"chat-flash","messages":[{"role":"user","content":"你好"}]}'
```

客户端接入与 PC 版完全一致：`base_url = http://NAS_IP:8787/v1`（OpenAI 兼容），
Anthropic 客户端用 `/v1` + Anthropic 协议；管理台在 `http://NAS_IP:8787/admin`。

## 6. 续期机制与关键操作点（务必读）

- **节奏**：renew 容器每 6h 检查一次，按本地日去重、每日至多续期一次；
  token 剩余 >21 天时自动跳过（轮换会作废其它持有方，不会提前换）。
  手动立即续期：`docker exec ta2api-renew node tools/renew-credentials.mjs once --force`
  （预览请求：`once --dry-run`，只看不发）。
- **★ 首次续期后，PC 桌面端需要重新登录一次。** 服务端按「登录实例」发会话，refresh
  会轮换当前会话凭据、旧 token 只有 60s 吊销宽限：NAS 用导出的 token 完成首次续期后，
  PC 桌面手里的旧 token 会失效并要求重新登录。重新登录产生的是**另一条**会话，
  与 NAS 互不干扰——登录完即可，**不需要**重新导出（NAS 继续用自己的那条会话）。
- **会话寿命**：token 短期有效 + 90 天绝对期限。renew 日志出现「终态失败（会话已死）」
  或 `SESSION_ABSOLUTE_EXPIRED` 时，续期链已死：到 PC 重新登录 TeleAgent，然后**重新跑**
  `node tools/export-credentials.mjs` 并替换 NAS 上的数据根内容。
- renew 失败但非终态（网络抖动等）会自动重试，无需干预；观察：
  `docker logs -f ta2api-renew`。

## 7. 版本说明

镜像内置 runtime 为官方 deb 的 3.1.0-dev；PC 导出包的 `runtimes/.version.json` 记录的是
**签发 token 的桌面端版本**（续期请求的 `X-App-Version` 用它，保持与签发设备一致）。
两者不一致只在启动日志打一行提示，不影响运行；想让数据根对齐镜像版本，删掉
`<TA_DATA_ROOT>/runtimes/.version.json` 后重启容器即可（entrypoint 会拷入镜像版本）。

## 8. 不方便拉 GHCR？本地构建

```bash
docker compose -f docker/docker-compose.yml build
docker compose -f docker/docker-compose.yml up -d
```

构建脚本自动从 GitHub Release 下载 5 个官方载荷并按 `docker/payload-manifest.txt` 校验
sha256，任何字节不符都会中止构建。

## 9. 排错速查

| 症状 | 处理 |
| --- | --- |
| `[entrypoint] 数据根缺少 …` | 数据根没拷全；回 PC 重跑导出工具并整目录替换 |
| `TA_CRYPT_KEY 非法：期望 32 字节` | `.env` 里填的是文件路径？应填 `crypt-key.b64` 的内容 |
| `token.json 解密失败（TA_CRYPT_KEY 与该文件的主密钥不匹配？）` | 数据根与主密钥来自两次不同的导出；重新导出并整体替换 |
| `/v1/models` 为空 | 数据根缺 `users/<账号>/model-catalog.json`，重新导出 |
| renew 报 `终态失败` / `SESSION_ABSOLUTE_EXPIRED` | 见第 6 节：PC 重新登录 + 重新导出 |
| 积分接口 4xx/鉴权异常 | 尝试 `.env` 加 `TA_OS_TYPE=windows` 后重启 gateway |
| 端口被占 | compose 里改 `TA_PORT` |
| 想看请求/内核日志 | `docker logs ta2api-gateway`；内核日志在数据根 `logs*/` 与 `runtime/` 下 |

## 10. 升级

```bash
docker compose -f docker/docker-compose.yml pull   # GHCR 镜像更新
docker compose -f docker/docker-compose.yml up -d
```

runtime 载荷升级 = 官方 deb 换版 → 新 Release tag → 更新 `docker/payload-manifest.txt`
与 `docker/runtimes.version.json` → 重新构建/发布镜像（仓库的 GitHub Actions 在 push 到
main 时自动构建并发布 `ghcr.io/ghg6666678/ta2api:{latest,<sha>}`）。
凭据数据根与镜像版本无关，升级镜像**不需要**重新导出凭据。
