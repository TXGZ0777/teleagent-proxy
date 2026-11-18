# TeleAgent 反代（TA2API）Linux 运行时镜像
#
# 分层说明：
#   - 官方 Linux runtime（kernel/ais/node/python/rg）来自中电信官方 deb 包内压缩档，
#     逐字节 sha256 与 deb 清单一致（docker/payload-manifest.txt）。
#     python 压缩包 111MB 超过 GitHub 单文件 100MB 限制，因此不进 git，
#     而是挂在仓库 Release（tag: payload-3.1.0-dev-20261116），构建时下载并校验。
#   - /data 是凭据数据根（PC 导出包挂载点），镜像内已内置 3.1.0-dev 的 runtimes。
#   - gateway 与 renew 两个角色共用本镜像，compose 里用不同 command 区分。
FROM debian:bookworm-slim

ARG PAYLOAD_BASE=https://github.com/ghg6666678/TA2API/releases/download/payload-3.1.0-dev-20261116

RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates tzdata curl tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY docker/payload-manifest.txt /tmp/payload-manifest.txt
COPY docker/runtimes.version.json /opt/runtimes/.version.json

# 下载官方 runtime 载荷 → 校验 → 解包到 /opt/runtimes（kernel/ais 保持压缩包原目录形态，
# node/python 追加一层平铺软链，兼容内核不同版本可能的查找约定）
RUN set -eux; \
    mkdir -p /tmp/payload /opt/runtimes/node /opt/runtimes/python /opt/runtimes/ripgrep/linux-x64; \
    for f in node-linux-x64.tar.gz python-linux-x64.tar.gz super-agent-code-linux-x64.tar.gz teleagent-ais-linux-x64.tar.gz; do \
      curl -fsSL --retry 3 -o "/tmp/payload/$f" "$PAYLOAD_BASE/$f"; \
    done; \
    curl -fsSL --retry 3 -o /tmp/payload/ripgrep-linux-x64-rg "$PAYLOAD_BASE/ripgrep-linux-x64-rg"; \
    ( cd /tmp/payload && sha256sum -c /tmp/payload-manifest.txt ); \
    tar -xzf /tmp/payload/super-agent-code-linux-x64.tar.gz -C /opt/runtimes; \
    tar -xzf /tmp/payload/teleagent-ais-linux-x64.tar.gz -C /opt/runtimes; \
    tar -xzf /tmp/payload/node-linux-x64.tar.gz -C /opt/runtimes/node; \
    tar -xzf /tmp/payload/python-linux-x64.tar.gz -C /opt/runtimes/python; \
    install -m 0755 /tmp/payload/ripgrep-linux-x64-rg /opt/runtimes/ripgrep/linux-x64/rg; \
    NODE_DIR="$(find /opt/runtimes/node -mindepth 1 -maxdepth 1 -type d -name 'node-v*' -print -quit)"; \
    ln -sfn "$NODE_DIR" /opt/runtimes/node/current; \
    ln -sfn "current/bin" /opt/runtimes/node/bin; \
    ln -sfn "current/lib" /opt/runtimes/node/lib; \
    PY_DIR="/opt/runtimes/python/python"; \
    ln -sfn "python/bin" /opt/runtimes/python/bin; \
    ln -sfn "python/lib" /opt/runtimes/python/lib; \
    ln -sfn "python/bin/python3.12" /opt/runtimes/python/python3.12; \
    chmod +x /opt/runtimes/super-agent-code/bin/TeleAgent /opt/runtimes/ais/bin/ais; \
    rm -rf /tmp/payload /tmp/payload-manifest.txt

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
