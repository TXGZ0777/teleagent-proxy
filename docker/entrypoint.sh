#!/bin/bash
# 容器入口：准备数据根 → 选定镜像内置 node → 转交原命令
# gateway 角色 CMD=node /app/server.mjs；renew 角色 command=node /app/tools/renew-credentials.mjs daemon
set -e

NODE_BIN_DIR="$(find /opt/runtimes/node -mindepth 1 -maxdepth 1 -type d -name 'node-v*' -print -quit)/bin"
if [ ! -x "$NODE_BIN_DIR/node" ]; then
  echo "[entrypoint] 镜像内 node 缺失：$NODE_BIN_DIR" >&2
  exit 1
fi
export PATH="$NODE_BIN_DIR:$PATH"

DATA_ROOT="${TA_DEVICE_DATA_ROOT:-/data}"
mkdir -p "$DATA_ROOT/runtimes"

# 镜像内置 runtimes（官方 deb 原包，/opt/runtimes）软链进数据根：
# paths.mjs 的 KERNEL_BINARY 与内核自身的 sibling 查找都按
# <数据根>/runtimes/<...> 解析；数据根里已有实体时（全量导出包）尊重挂载内容。
for d in super-agent-code ais node python ripgrep; do
  if [ ! -e "$DATA_ROOT/runtimes/$d" ]; then
    ln -s "/opt/runtimes/$d" "$DATA_ROOT/runtimes/$d"
  fi
done

# 数据根缺 runtimes/.version.json 时用镜像内置的（与镜像内 kernel/ais 版本一致）
if [ ! -f "$DATA_ROOT/runtimes/.version.json" ]; then
  cp /opt/runtimes/.version.json "$DATA_ROOT/runtimes/.version.json"
fi

# 凭据文件缺失时给出可操作提示，而不是让 server.mjs 的报错悬空
for f in current-owner.json "Local State" "users"; do
  if [ ! -e "$DATA_ROOT/$f" ]; then
    echo "[entrypoint] 数据根缺少 $f —— 先在 PC 上按 docs/nas-docker.md 完成凭据导出" >&2
    exit 1
  fi
done

# 版本提示（不阻塞）：数据根 .version.json 与镜像内核版本不一致只是信息字段，不影响运行
IMG_VER="$(node -e "console.log(require('/opt/runtimes/.version.json').superAgentCode||'')" 2>/dev/null || true)"
DAT_VER="$(node -e "console.log(require(process.env.TA_DEVICE_DATA_ROOT + '/runtimes/.version.json').superAgentCode||'')" 2>/dev/null || true)"
if [ -n "$IMG_VER" ] && [ -n "$DAT_VER" ] && [ "$IMG_VER" != "$DAT_VER" ]; then
  echo "[entrypoint] 提示：数据根 kernel 版本($DAT_VER) 与镜像($IMG_VER) 不同；如需对齐请删除 $DATA_ROOT/runtimes/.version.json 后重启" >&2
fi

exec "$@"
