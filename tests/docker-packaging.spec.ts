/// <reference types="node" />
/* eslint-disable no-template-curly-in-string -- Docker/Compose expand these literals. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { PROJECT_ROOT } from "../src/paths";

const read = (path: string): string => readFileSync(join(PROJECT_ROOT, path), "utf8");
const dockerfile = read("Dockerfile");
const runtime = dockerfile.split(" AS runtime")[1];

describe("Docker production packaging", () => {
  test("pulls the versioned Docker Hub image without an implicit local build", () => {
    const compose = read("docker-compose.yml");
    const { version } = JSON.parse(read("package.json")) as { version: string };
    expect(compose).toContain(`image: alimaster/mikrotik-mcp:\${MIKROTIK_IMAGE_TAG:-${version}}`);
    expect(compose).not.toMatch(/^\s+build:/m);
    expect(compose).not.toMatch(/^\s+platform:/m);
  });

  test("pins one Bun version matching the package manager for every stage", () => {
    const pkg = JSON.parse(read("package.json")) as { packageManager: string };
    expect(dockerfile).toContain(`ARG BUN_VERSION=${pkg.packageManager.replace("bun@", "")}`);
    expect(dockerfile).toContain(
      "FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION}-alpine AS build-base",
    );
    expect(dockerfile).toContain("FROM oven/bun:${BUN_VERSION}-alpine AS runtime");
    expect(dockerfile).toContain("COPY package.json bun.lock bunfig.toml ./");
    expect(dockerfile).toContain("bun install --frozen-lockfile --ignore-scripts");
  });

  test("ships only assembled runtime files and runs without auto-install as non-root", () => {
    expect(runtime).toContain("COPY --from=build /out/ ./");
    expect(runtime).toContain("USER bun");
    expect(runtime).toContain('["bun", "--bun", "--no-install", "--no-env-file", "dist/cli.js"]');
    expect(runtime).not.toMatch(/bun install|apk add|COPY \. \./);
    expect(runtime).toContain("/home/bun/.mikrotik-mcp");
  });

  test("cross-builds without executing target binaries or pinning the runtime architecture", () => {
    expect(runtime).not.toMatch(/^RUN\s/m);
    expect(dockerfile).not.toMatch(/--platform=(?:linux\/|\$TARGETPLATFORM)/);
    expect(runtime).toContain("COPY --from=defaults --chown=bun:bun /state/ /home/bun/");
    expect(dockerfile).toContain("chmod 0700 /state/.mikrotik-mcp");
    expect(dockerfile).toContain(
      "COPY --chmod=0600 docker/devices.example.json /state/.mikrotik-mcp/devices.json",
    );
  });

  test("checks both architectures on native CI runners without publishing", () => {
    const workflow = read(".github/workflows/docker.yml");
    for (const value of ["ubuntu-24.04", "ubuntu-24.04-arm", "linux/amd64", "linux/arm64"]) {
      expect(workflow).toContain(value);
    }
    expect(workflow).toContain("--network none");
    expect(workflow).toContain("check-docker-runtime.ts");
    expect(workflow).not.toMatch(/setup-qemu|docker (?:push|login)|--push/);
  });

  test("keeps offline build verification and all UI assets", () => {
    expect(dockerfile).toContain("bun run test:built");
    expect(dockerfile).toContain("bun run build:ui");
    const packager = read("scripts/package-docker.ts");
    for (const path of [
      "prompts",
      "schemas",
      "policies",
      "assets/flags",
      "dist/cli.js",
      "dist/ui",
    ]) {
      expect(packager).toContain(`"${path}"`);
    }
    expect(packager).toContain("THIRD-PARTY-NOTICES.txt");
  });

  test("denies local data in the Docker context by default", () => {
    const patterns = read(".dockerignore")
      .split("\n")
      .filter((s) => s && !s.startsWith("#"));
    expect(patterns[0]).toBe("**");
    expect(patterns).not.toContain("!.env");
    expect(patterns).not.toContain("!devices.json");
    expect(patterns).not.toContain("!node_modules/");
    expect(patterns).toContain("**/.env.*");
    expect(patterns).toContain("**/*.db");
  });

  test("uses Bun liveness on the configured port with dashboard opt-in on 9090", () => {
    expect(runtime).toContain('"dist/docker-healthcheck.js"');
    const defaults = JSON.parse(read("docker/devices.example.json"));
    expect(defaults.mcp).toEqual({ transport: "streamable-http", host: "0.0.0.0", port: 8000 });
    expect(defaults.dashboard).toEqual({ enabled: false, host: "0.0.0.0", port: 9090 });
    expect(runtime).not.toMatch(/MIKROTIK_(MCP|DASHBOARD)__/);
    expect(runtime).toContain("MIKROTIK_CONFIG_FILE=/home/bun/.mikrotik-mcp/devices.json");
    expect(runtime).toContain("COPY --from=defaults --chown=bun:bun /state/ /home/bun/");
    const healthcheck = read("scripts/docker-healthcheck.ts");
    expect(healthcheck).toContain("process.env.MIKROTIK_MCP__PORT");
    expect(healthcheck).toContain("config.mcp?.port");
    expect(healthcheck).toContain("AbortSignal.timeout(3000)");
    const compose = read("docker-compose.yml");
    expect(compose).not.toContain("wget");
    expect(compose).toContain("127.0.0.1:${MCP_PORT:-8000}:${MCP_PORT:-8000}");
    expect(compose).toContain("127.0.0.1:${DASHBOARD_PORT:-9090}:${DASHBOARD_PORT:-9090}");
    expect(compose).toContain("mikrotik-state:/home/bun/.mikrotik-mcp");
    expect(compose).toContain("source: ${MIKROTIK_CONFIG_PATH:-./devices.json}");
    expect(compose).toContain("target: /home/bun/.mikrotik-mcp/devices.json");
    expect(compose).toContain("create_host_path: false");
    expect(compose).toContain("read_only: false");
    expect(compose).not.toMatch(/MIKROTIK_MCP__PORT:|MIKROTIK_MCP__TRANSPORT:/);
  });
});
