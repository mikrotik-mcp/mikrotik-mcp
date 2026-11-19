/// <reference types="bun" />
/**
 * The injection boundary, checked for every tool of the catalog.
 *
 * Each tool is called with a hostile value in every free-text argument. Every
 * command it then sends to the router is read as the router reads it: the
 * hostile text must be inside a string literal, never in command position.
 *
 * A tool whose argument IS a RouterOS command by design (the raw command tool,
 * scripts, plans) is listed in RAW_BY_DESIGN with the reason. Nothing else may
 * be added there to make this test pass: fix the tool instead.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { z } from "zod";

// No handler may reach a real device, the network, or the user's files.
const home = mkdtempSync(join(tmpdir(), "inject-home-"));
vi.stubEnv("HOME", home);
vi.stubEnv("MIKROTIK_BACKUP_DIR", join(home, "vault"));
vi.stubGlobal("fetch", () => Promise.reject(new Error("no network in this test")));

const sent = vi.hoisted(() => ({ commands: [] as string[] }));
const reply = (cmd: string): string => {
  sent.commands.push(cmd);
  if (/count-only/.test(cmd)) return "1";
  if (cmd.startsWith(":put")) return "*1";
  return ' 0   name="x" .id=*1 address=10.0.0.1/24 interface=ether1 disabled=no comment="c"';
};
vi.mock("../src/core/connector", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  executeMikrotikCommand: async (cmd: string) => reply(cmd),
  uploadFileToDevice: async () => {},
  downloadFileFromDevice: async () => Buffer.from(""),
}));
vi.mock("../src/ssh/client", () => ({
  MikroTikSSHClient: class {
    lastError = "no device in this test";
    connect = async () => false;
    disconnect = () => {};
  },
  decodeOutput: (data: Buffer) => data.toString(),
}));
vi.mock("../src/mac-telnet/client", () => ({
  MikroTikMacTelnetClient: class {
    lastError = "no device in this test";
    connect = async () => false;
    disconnect = () => {};
  },
}));

const { setConfig } = await import("../src/core/runtime");
const { loadConfig } = await import("../src/config");
const { allToolModules } = await import("../src/tools");
setConfig(loadConfig(["--host", "192.0.2.1", "--username", "admin", "--password", "x"]));

const MARK = "INJECTED_MARK";
/** One payload leaves a hand-written string; the other needs no string at all. */
const PAYLOADS = [
  `x" ; :log error ${MARK} ; "y`,
  `x ; :log error ${MARK} ; y`,
  `$[:log error ${MARK}]`,
];

/** What the router reads outside string literals: commands and separators. */
function outsideStrings(cmd: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < cmd.length; i += 1) {
    const char = cmd[i];
    if (inString && char === "\\") i += 1;
    else if (char === '"') inString = !inString;
    else if (!inString) out += char;
  }
  return inString ? `${out}<unterminated>` : out;
}

type Schema = z.ZodType & {
  def?: {
    type?: string;
    innerType?: Schema;
    element?: Schema;
    entries?: Record<string, string>;
    options?: Schema[];
    values?: unknown[];
    shape?: Record<string, Schema>;
  };
};

/** A value for one argument: the payload wherever free text is accepted. */
function fill(schema: Schema, payload: string): unknown {
  const def = schema.def ?? {};
  switch (def.type) {
    case "optional":
    case "default":
    case "nullable":
    case "prefault":
    case "catch":
    case "readonly":
      return fill(def.innerType as Schema, payload);
    case "string":
      return payload;
    case "number":
    case "int":
      return 1;
    case "boolean":
      return true;
    case "enum":
      return Object.values(def.entries ?? {})[0];
    case "literal":
      return def.values?.[0];
    case "array":
      return [fill(def.element as Schema, payload)];
    case "union":
      return fill((def.options ?? [])[0] as Schema, payload);
    case "object":
      return Object.fromEntries(
        Object.entries(def.shape ?? {}).map(([key, value]) => [key, fill(value, payload)]),
      );
    case "record":
      return { key: payload };
    default:
      return undefined;
  }
}

/** Fallbacks for an argument whose schema refuses the payload (an IP, a MAC, an id…). */
const SAFE = [
  "1",
  "a",
  "10.0.0.1",
  "10.0.0.0/24",
  "00:11:22:33:44:55",
  "*1",
  "ether1",
  "2001:db8::1",
  "1d",
];

function argsFor(shape: Record<string, Schema>, payload: string): Record<string, unknown> | null {
  const object = z.object(shape);
  const args = Object.fromEntries(
    Object.entries(shape).map(([key, schema]) => [key, fill(schema, payload)]),
  );
  for (let round = 0; round < 6; round += 1) {
    const result = object.safeParse(args);
    if (result.success) return result.data as Record<string, unknown>;
    for (const issue of result.error.issues) {
      const key = String(issue.path[0]);
      const schema = shape[key];
      if (!schema) continue;
      // The schema refuses the hostile value here: that argument is safe. Give it a valid one.
      const valid = SAFE.find((candidate) => schema.safeParse(candidate).success);
      if (valid !== undefined) args[key] = valid;
      else if (schema.safeParse(undefined).success) delete args[key];
      else args[key] = fill(schema, "a");
    }
  }
  return null;
}

/** Tools whose argument is a RouterOS command or script by design. */
const RAW_BY_DESIGN: Record<string, string> = {
  run_routeros_command: "runs the command the caller gives",
  firmware_post_upgrade: "its commands argument is a list of commands to run after an upgrade",
};

const ctx = { device: undefined, info: () => {}, error: () => {} };
const tools = allToolModules.flat();

test(
  "no tool lets a hostile argument reach the router in command position",
  { timeout: 300_000 },
  async () => {
    const leaks: string[] = [];
    let called = 0;
    for (const tool of tools) {
      if (tool.name in RAW_BY_DESIGN) continue;
      for (const payload of PAYLOADS) {
        const args = argsFor((tool.inputSchema ?? {}) as Record<string, Schema>, payload);
        if (!args) continue;
        sent.commands = [];
        called += 1;
        await Promise.race([
          Promise.resolve()
            .then(() => tool.handler(args as never, ctx as never))
            .catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 1500)),
        ]);
        for (const cmd of sent.commands) {
          const outside = outsideStrings(cmd);
          if (outside.includes(MARK) || outside.includes("<unterminated>"))
            leaks.push(`${tool.name}: ${cmd.slice(0, 220)}`);
        }
      }
    }
    expect(called).toBeGreaterThan(tools.length);
    expect(Array.from(new Set(leaks))).toEqual([]);
  },
);

/**
 * Read-only mode and the READ risk ceiling register tools by their annotation
 * alone, so a READ tool that changes the router breaks both (GHSA-p524-m32j-hf32).
 * A command changes the router when it has a changing verb, or writes a file.
 */
const CHANGES =
  /(?:^|[\s/[{;])(?:add|set|remove|enable|disable|unset|import|reboot|shutdown|upgrade|downgrade|install|uninstall|reset-configuration|save|restore|load|format-drive|run|fetch|move)(?:\s|$)|(?:^|\s)file=/;

test("no READ tool sends a command that changes the router", { timeout: 300_000 }, async () => {
  const offenders: string[] = [];
  let called = 0;
  for (const tool of tools) {
    if (tool.annotations.readOnlyHint !== true) continue;
    const args = argsFor((tool.inputSchema ?? {}) as Record<string, Schema>, "a");
    if (!args) continue;
    sent.commands = [];
    called += 1;
    await Promise.race([
      Promise.resolve()
        .then(() => tool.handler(args as never, ctx as never))
        .catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
    for (const cmd of sent.commands)
      if (CHANGES.test(outsideStrings(cmd))) offenders.push(`${tool.name}: ${cmd.slice(0, 160)}`);
  }
  expect(called).toBeGreaterThan(200);
  expect(Array.from(new Set(offenders))).toEqual([]);
});

/** Only the arguments a caller must give, with plain values. */
function requiredArgs(shape: Record<string, Schema>): Record<string, unknown> | null {
  const required = Object.fromEntries(
    Object.entries(shape).filter(([, schema]) => !schema.safeParse(undefined).success),
  );
  return argsFor(required, "a");
}

/**
 * A `set` command changes an item that exists. A parameter with a schema
 * default that the handler always writes resets that setting on every call:
 * `set_dns_servers` once wrote `allow-remote-requests=no` whenever it was
 * called with `servers` alone, and so stopped DNS for the router's clients.
 * A default is fine on an `add` command, which makes a new item.
 */
test("a set command writes only what the caller gave", async () => {
  const leaks: string[] = [];
  for (const tool of allToolModules.flat()) {
    if (tool.annotations.readOnlyHint === true) continue;
    const shape = (tool.inputSchema ?? {}) as Record<string, Schema>;
    const defaults = Object.entries(shape)
      .filter(([, schema]) => schema.def?.type === "default")
      .map(([key]) => key);
    if (defaults.length === 0) continue;
    const given = requiredArgs(shape);
    const parsed = given && z.object(shape).safeParse(given);
    if (!parsed || !parsed.success) continue;
    sent.commands = [];
    try {
      await tool.handler(
        parsed.data as never,
        { info() {}, error() {}, warn() {}, debug() {} } as never,
      );
    } catch {
      // A tool that needs more than the mock gives is not what this test reads.
    }
    const sets = sent.commands.filter((cmd) => /^\/[a-z0-9 /-]+ set\b/.test(cmd)).join(" ; ");
    const written = defaults.filter((key) =>
      new RegExp(`[ ;]${key.replaceAll("_", "-")}=`).test(sets),
    );
    if (written.length > 0) leaks.push(`${tool.name}: ${written.join(", ")}`);
  }
  expect(leaks).toEqual([]);
}, 120_000);
