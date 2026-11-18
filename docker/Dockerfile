# TeleAgent 反代（TA2API）Linux 运行时镜像
#
# 分层说明：
#   - 官方 Linux runtime（kernel/ais/node/python/rg）来自中电信官方 deb 包内压缩档，
#     逐字节 sha256 与 deb 清单一致：x64 见 docker/payload-manifest.txt，
#     arm64 见 docker/payload-manifest-arm64.txt（同版 3.1.0 官方 deb）。
#     python 压缩包超过 GitHub 单文件 100MB 限制，因此不进 git，
#     两套载荷同挂 Release（tag: payload-3.1.0-dev-20261116），构建时下载并校验。
#   - PAYLOAD_ARCH：载荷架构 x64 / arm64，默认跟随构建目标平台自动选择
#     （buildx 的 TARGETARCH，amd64 归一为 x64）；需要显式指定时
#     docker build --build-arg PAYLOAD_ARCH=arm64。
#   - ARM64（aarch64，如飞牛 fnOS）原生支持：kernel/ais 是静态 Go 二进制，
#     node/python 均为官方 arm64 构建、版本与 x64 完全同线，
#     kernel 均为 3.1.0-dev-3-1-0-20261116095753（与 PC 桌面端对齐）。
#   - /data 是凭据数据根（PC 导出包挂载点），镜像内已内置 3.1.0-dev 的 runtimes。
#   - gateway 与 renew 两个角色共用本镜像，compose 里用不同 command 区分。
FROM debian:bookworm-slim

# 载荷架构：优先 PAYLOAD_ARCH（显式指定），否则跟随 buildx 的 TARGETARCH。
# 非法的架构值会让下面的校验步直接构建失败；两者都不传时按 TARGETARCH 判断。
ARG TARGETARCH
ARG PAYLOAD_ARCH

# 载荷 Release 基址（x64 与 arm64 同 tag，文件名按架构区分）
ARG PAYLOAD_BASE=https://github.com/ghg6666678/TA2API/releases/download/payload-3.1.0-dev-20261116

RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates tzdata curl tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 两套清单一并进入构建层，按架构选定（x64 沿用原文件名，arm64 加 -arm64 后缀）
COPY docker/payload-manifest.txt /tmp/payload-manifest-x64.txt
COPY docker/payload-manifest-arm64.txt /tmp/payload-manifest-arm64.txt
COPY docker/runtimes.version.json /tmp/runtimes.version-x64.json
COPY docker/runtimes.version.arm64.json /tmp/runtimes.version-arm64.json

# 下载官方 runtime 载荷 → 校验 → 解包到 /opt/runtimes（kernel/ais 保持压缩包原目录形态，
# node/python 追加一层平铺软链，兼容内核不同版本可能的查找约定）
RUN set -eux; \
    A="${PAYLOAD_ARCH:-${TARGETARCH:-}}"; \
    case "$A" in \
      amd64) A="x64";; \
      x64|arm64) :;; \
      *) echo "!! 不支持的载荷架构（PAYLOAD_ARCH=${PAYLOAD_ARCH:-未指定} TARGETARCH=${TARGETARCH:-未指定}）" >&2; exit 1;; \
    esac; \
    MANIFEST="/tmp/payload-manifest-$A.txt"; \
    VERSION_JSON="/tmp/runtimes.version-$A.json"; \
    echo "[build] payload arch = $A"; \
    mkdir -p /tmp/payload /opt/runtimes/node /opt/runtimes/python "/opt/runtimes/ripgrep/linux-$A"; \
    for f in "node-linux-$A.tar.gz" "python-linux-$A.tar.gz" "super-agent-code-linux-$A.tar.gz" "teleagent-ais-linux-$A.tar.gz"; do \
      curl -fsSL --retry 3 -o "/tmp/payload/$f" "$PAYLOAD_BASE/$f"; \
    done; \
    curl -fsSL --retry 3 -o "/tmp/payload/ripgrep-linux-$A-rg" "$PAYLOAD_BASE/ripgrep-linux-$A-rg"; \
    ( cd /tmp/payload && sha256sum -c "$MANIFEST" ); \
    tar -xzf "/tmp/payload/super-agent-code-linux-$A.tar.gz" -C /opt/runtimes; \
    tar -xzf "/tmp/payload/teleagent-ais-linux-$A.tar.gz" -C /opt/runtimes; \
    tar -xzf "/tmp/payload/node-linux-$A.tar.gz" -C /opt/runtimes/node; \
    tar -xzf "/tmp/payload/python-linux-$A.tar.gz" -C /opt/runtimes/python; \
    install -m 0755 "/tmp/payload/ripgrep-linux-$A-rg" "/opt/runtimes/ripgrep/linux-$A/rg"; \
    install -m 0644 "$VERSION_JSON" /opt/runtimes/.version.json; \
    NODE_DIR="$(find /opt/runtimes/node -mindepth 1 -maxdepth 1 -type d -name 'node-v*' -print -quit)"; \
    ln -sfn "$NODE_DIR" /opt/runtimes/node/current; \
    ln -sfn "current/bin" /opt/runtimes/node/bin; \
    ln -sfn "current/lib" /opt/runtimes/node/lib; \
    PY_DIR="/opt/runtimes/python/python"; \
    ln -sfn "python/bin" /opt/runtimes/python/bin; \
    ln -sfn "python/lib" /opt/runtimes/python/lib; \
    ln -sfn "python/bin/python3.12" /opt/runtimes/python/python3.12; \
    chmod +x /opt/runtimes/super-agent-code/bin/TeleAgent /opt/runtimes/ais/bin/ais; \
    rm -rf /tmp/payload /tmp/payload-manifest-*.txt /tmp/runtimes.version-*.json

# 代理本体（纯 ESM，无需 npm install）
COPY server.mjs ./
COPY lib ./lib
COPY tools ./tools

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

# /data = 凭据数据根（current-owner.json / Local State / token.json / device-meta.json /
# model-catalog.json / runtimes/.version.json），由 PC 导出包挂载进容器
ENV TA_DEVICE_DATA_ROOT=/data \
    TA_HOST=0.0.0.0 \
    TA_PORT=8787 \
    NODE_ENV=production
VOLUME /data
EXPOSE 8787

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
# gateway 角色；renew 角色在 compose 里用 command 覆盖
CMD ["node", "/app/server.mjs"]
