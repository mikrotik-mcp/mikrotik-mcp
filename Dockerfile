# syntax=docker/dockerfile:1
# Pin the latest stable Bun (checked 2026-10-03); override deliberately at build time.
ARG BUN_VERSION=1.4.2
# Build architecture-independent JS natively (avoid running JSC under QEMU).
FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION}-alpine AS build-base
WORKDIR /app

# Prepare writable defaults on the builder too: no target-platform RUN or QEMU.
FROM build-base AS defaults
RUN mkdir -p /state/.mikrotik-mcp && chmod 0700 /state/.mikrotik-mcp
COPY --chmod=0600 docker/devices.example.json /state/.mikrotik-mcp/devices.json

FROM build-base AS dependencies
# Keep Bun's catalog/peer settings and lockfile together. No Node, Git or hooks.
COPY package.json bun.lock bunfig.toml ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --ignore-scripts

FROM dependencies AS build
# .dockerignore is an allow-list: local configs, keys and databases never enter.
COPY . .
# The Docker-only Bun bundler handles centrs' raw TS exports directly. The npm
# library still uses bunup with centrs external; its packaging is unchanged.
# SDK and Zod stay in the same bundle. Only file-backed runtime packages remain.
RUN bun build src/cli.ts src/index.ts --target=bun --packages=bundle \
      --minify --keep-names --external=ssh2 --external=figlet \
      --outdir=dist --metafile=docker-build-meta.json \
    && bun run test:built \
    && bun run build:ui \
    && bun scripts/package-docker.ts /out

# Intentionally NOT pinned to BUILDPLATFORM or ARM. BuildKit selects the requested
# linux/amd64 or linux/arm64 base; Docker Desktop runs it on Windows/macOS as well.
FROM oven/bun:${BUN_VERSION}-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    MIKROTIK_CONFIG_FILE=/home/bun/.mikrotik-mcp/devices.json
# App files are root-owned/read-only to bun; state alone is writable/persistable.
# Defaults live in JSON, not ENV: saved settings must survive a restart unchanged.
# Mount a writable file here, or mount its parent directory for atomic saves.
COPY --from=defaults --chown=bun:bun /state/ /home/bun/
COPY --from=build /out/ ./
USER bun
EXPOSE 8000 9090
# Uses Bun instead of adding curl/wget; follows the configured MCP port.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["bun", "--bun", "--no-install", "--no-env-file", "dist/docker-healthcheck.js"]
ENTRYPOINT ["bun", "--bun", "--no-install", "--no-env-file", "dist/cli.js"]
CMD ["serve"]
