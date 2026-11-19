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

/** The settings every `set` in these commands writes, with their values. */
function settingsWritten(commands: string[]): Map<string, string> {
  const written = new Map<string, string>();
  for (const command of commands) {
    // Strings are taken out first, so a `;` or `=` inside one is not read as syntax.
    const strings: string[] = [];
    const masked = command.replace(/"(?:\\.|[^"\\])*"/g, (text) => `§${strings.push(text) - 1}§`);
    for (const part of masked.split(/[;\n]/)) {
      const at = part.search(/(?:^|[\s/{])set(?:\s|$)/);
      if (at < 0) continue;
      let rest = part.slice(at).replace(/^[\s/{]*set/, "");
      // `[find ...]` and `where ...` choose the item. They do not write.
      for (let depth = 0; depth < 6; depth += 1) rest = rest.replace(/\[[^[\]]*\]/g, "§");
      rest = rest.replace(/\swhere\s.*$/, "");
      for (const match of rest.matchAll(/(?:^|\s)([a-zA-Z.][\w.-]*)=(\S*)/g)) {
        if (match[1] === "numbers" || match[1] === ".id") continue;
        const value = match[2]!
          .replace(/§(\d+)§/g, (_, index) => strings[Number(index)]!)
          .replace(/[}\s]+$/, "");
        written.set(match[1]!, value);
      }
    }
  }
  return written;
}

/** Every text a given argument can become in a command: true is `yes`, a list is each item. */
function textsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(textsOf);
  if (value && typeof value === "object") return Object.values(value).flatMap(textsOf);
  if (typeof value === "boolean") return value ? ["yes", "true"] : ["no", "false"];
  return [String(value)];
}

/** Arguments that let a call run but name no setting. */
const GATE = /^(?:apply|confirm\w*|dry_run|force|physical\w*|acknowledge\w*|i_understand\w*)$/;

/**
 * Tools whose job is to write a fixed value. Each entry says why. Do not add a
 * tool here to make the test pass: make the tool keep what it was not given.
 */
const FIXED_BY_DESIGN: [RegExp, string][] = [
  [/^(?:enable|disable)_/, "writes disabled=yes or disabled=no: that is the request"],
  [/_enabled$/, "writes disabled as the opposite of the `enabled` it was given"],
  [/^allow_device$/, "writes block-access=no: that is the request"],
  [/^(?:start|stop)_packet_capture$/, "turns sniffer streaming on or off: that is the request"],
  [/^audit_remediate$/, "applies the fixes its own audit found"],
];

/**
 * A `set` command changes an item that exists, so it may write only what the
 * caller gave. `set_dns_servers` once wrote `allow-remote-requests=no` on every
 * call, and a call that only changed the servers stopped DNS for every client.
 *
 * Each write tool is called with its required arguments alone, then with each
 * optional argument alone. The mock router answers every read, so the handler
 * reaches its write. Two rules:
 *   1. With the required arguments alone, every value written is one of them.
 *   2. One optional argument adds at most one setting.
 * A default on an `add` command is fine: it makes a new item.
 */
test("a set command writes only what the caller gave", { timeout: 300_000 }, async () => {
  const leaks = new Set<string>();
  let writes = 0;
  const call = async (tool: (typeof tools)[number], args: unknown) => {
    sent.commands = [];
    await Promise.race([
      Promise.resolve()
        .then(() => tool.handler(args as never, ctx as never))
        .catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
    const written = settingsWritten(sent.commands);
    if (written.size > 0) writes += 1;
    return written;
  };
  // "a" is a name; "*1" is an item id, for the tools that look the item up first.
  for (const payload of ["a", "*1"]) {
    for (const tool of tools) {
      if (tool.annotations.readOnlyHint === true || tool.name in RAW_BY_DESIGN) continue;
      const shape = (tool.inputSchema ?? {}) as Record<string, Schema>;
      const object = z.object(shape);
      const required = argsFor(
        Object.fromEntries(
          Object.entries(shape).filter(([, schema]) => !schema.safeParse(undefined).success),
        ),
        payload,
      );
      if (!required) continue;
      const base: Record<string, unknown> = { ...required };
      for (const [key, schema] of Object.entries(shape)) {
        const open = key !== "dry_run";
        if (!(key in base) && GATE.test(key) && schema.safeParse(open).success) base[key] = open;
      }
      const parsedBase = object.safeParse(base);
      if (!parsedBase.success) continue;

      const alone = await call(tool, parsedBase.data);
      if (!FIXED_BY_DESIGN.some(([name]) => name.test(tool.name))) {
        const given = textsOf(required);
        for (const [key, value] of alone) {
          const text = value.replace(/^"|"$/g, "");
          if (!given.some((item) => text.includes(item)))
            leaks.add(`${tool.name}: writes ${key}=${value} when it was not given`);
        }
      }

      for (const [key, schema] of Object.entries(shape)) {
        if (key in base) continue;
        let value = fill(schema, "zz");
        if (!schema.safeParse(value).success)
          value = SAFE.find((candidate) => schema.safeParse(candidate).success);
        const values = value === true ? [true, false] : value === undefined ? [] : [value];
        for (const one of values) {
          const parsed = object.safeParse({ ...base, [key]: one });
          if (!parsed.success) continue;
          const written = await call(tool, parsed.data);
          const added = [...written].filter(([name, text]) => alone.get(name) !== text);
          if (added.length > 1)
            leaks.add(
              `${tool.name}: ${key} alone writes ${added.map(([name, text]) => `${name}=${text}`).join(" ")}`,
            );
        }
      }
    }
  }
  // If the mock stops reaching the writes, this test would pass and check nothing.
  expect(writes).toBeGreaterThan(1000);
  expect([...leaks]).toEqual([]);
});
