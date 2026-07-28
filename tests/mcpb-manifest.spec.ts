/**
 * Offline checks on the MCP Bundle manifest.
 *
 * The manifest is hand-maintained but describes machine facts (the entry point a
 * host will execute, the env vars the server reads, the version it ships). It has
 * drifted from reality before — an earlier revision declared `type: "node"` with
 * `entry_point: "dist/cli.js"` while `.mcpbignore` stripped every `*.js` from the
 * bundle, so the packed extension pointed at a file it did not contain. These
 * tests pin the invariants a schema check cannot see.
 */
/* eslint-disable no-template-curly-in-string -- `${__dirname}` / `${user_config.x}`
   are stored literally in the manifest; the MCPB host substitutes them at launch. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { PROJECT_ROOT } from "../src/paths";

interface UserConfigEntry {
  type: "string" | "number" | "boolean" | "directory" | "file";
  title: string;
  description: string;
  required?: boolean;
  sensitive?: boolean;
  default?: unknown;
}

interface Manifest {
  manifest_version: string;
  name: string;
  version: string;
  description: string;
  author: string;
  icon?: string;
  server: {
    type: "node" | "python" | "binary" | "uv";
    entry_point: string;
    mcp_config: {
      command: string;
      args: string[];
      env: Record<string, string>;
      platform_overrides?: Record<string, { command?: string; args?: string[] }>;
    };
  };
  user_config: Record<string, UserConfigEntry>;
  compatibility: { platforms: string[] };
}

const manifest = JSON.parse(readFileSync(join(PROJECT_ROOT, "manifest.json"), "utf8")) as Manifest;
const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8")) as {
  version: string;
};

const USER_CONFIG_REF = /^\$\{user_config\.([a-z_]+)\}$/;

describe("mcpb manifest", () => {
  test("declares the required top-level fields", () => {
    expect(manifest.manifest_version).toBe("0.3");
    expect(manifest.name).toBe("mikrotik-mcp");
    expect(manifest.description).toBeTruthy();
    expect(manifest.author).toBeTruthy();
  });

  test("version tracks package.json", () => {
    expect(manifest.version).toBe(pkg.version);
  });

  test("icon resolves on disk", () => {
    expect(manifest.icon).toBeTruthy();
    expect(existsSync(join(PROJECT_ROOT, manifest.icon!))).toBe(true);
  });

  /**
   * The server is Bun-native (`bun:sqlite`, `Bun.serve`, `Bun.S3Client`, and
   * `@tikoci/centrs`, which ships raw TypeScript). An MCPB host supplies a Node
   * runtime, so a `type: "node"` manifest would crash on the first import. The
   * bundle therefore vendors Bun and runs `runtime/bun dist/cli.js serve`.
   */
  test("runs dist/cli.js under the vendored Bun runtime, not node", () => {
    const { type, entry_point: entry, mcp_config: cfg } = manifest.server;
    expect(type).toBe("binary");
    expect(entry).toBe("runtime/bun");
    expect(cfg.command).toBe("${__dirname}/runtime/bun");
    expect(cfg.args).toEqual(["${__dirname}/dist/cli.js", "serve"]);
    expect(cfg.platform_overrides?.win32?.command).toBe("${__dirname}/runtime/bun.exe");
  });

  test("every ${user_config.X} reference resolves to a declared field", () => {
    const refs = Object.values(manifest.server.mcp_config.env)
      .map((v) => v.match(USER_CONFIG_REF)?.[1])
      .filter((k): k is string => Boolean(k));

    expect(refs.length).toBeGreaterThan(0);
    for (const key of refs) expect(manifest.user_config).toHaveProperty(key);
  });

  test("every declared user_config field is wired to an env var", () => {
    const env = JSON.stringify(manifest.server.mcp_config.env);
    for (const key of Object.keys(manifest.user_config)) {
      expect(env).toContain(`\${user_config.${key}}`);
    }
  });

  test("credential fields are marked sensitive", () => {
    for (const key of ["password", "ssh_key_passphrase", "dashboard_token"]) {
      expect(manifest.user_config[key]?.sensitive).toBe(true);
    }
  });

  test("connection env vars match the names src/config.ts reads", () => {
    const config = readFileSync(join(PROJECT_ROOT, "src", "config.ts"), "utf8");
    for (const name of Object.keys(manifest.server.mcp_config.env)) {
      // The bundle pins this one rather than exposing it as a knob.
      if (name === "MIKROTIK_DISABLE_UPDATE_CHECK") continue;
      expect(config, `${name} is not read by loadConfig()`).toContain(name);
    }
  });

  test("targets the three MCPB platforms", () => {
    expect([...manifest.compatibility.platforms].sort()).toEqual(["darwin", "linux", "win32"]);
  });
});
