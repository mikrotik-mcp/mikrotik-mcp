/** Read-back for writes: what the router's change log says a call did. */
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import { MikrotikConfigSchema } from "../src/config";
import { READ, WRITE, defineTool, registerTools } from "../src/core/registry";
import { getConfig, setConfig } from "../src/core/runtime";
import { describeChange, newEntries, parseHistory } from "../src/core/write-verify";

const BEFORE = `Flags: U - UNDOABLE
Columns: ACTION, BY, POLICY, TIME
  ACTION                      BY     POLICY  TIME
U route ::/0 changed                 write   2026-11-19 04:21:27
U route 0.0.0.0/0 changed            write   2026-11-19 04:21:27
  address list entry removed  admin  write   2026-11-19 04:00:00
`;

test("the log is read as entries, newest first", () => {
  expect(parseHistory(BEFORE)).toEqual([
    "route ::/0 changed  write  2026-11-19 04:21:27",
    "route 0.0.0.0/0 changed  write  2026-11-19 04:21:27",
    "address list entry removed  admin  write  2026-11-19 04:00:00",
  ]);
  expect(parseHistory("")).toEqual([]);
});

test("new entries are the lines above the old top of the log", () => {
  const before = parseHistory(BEFORE);
  expect(newEntries(before, before)).toEqual([]);
  const added = ["ip address added  admin  write  2026-11-19 05:00:00", ...before];
  expect(newEntries(before, added)).toEqual([added[0]]);
  // An empty log before: everything after is new.
  expect(newEntries([], ["x"])).toEqual(["x"]);
  // The old top is gone: the log rolled over, the count is not known.
  expect(newEntries(before, ["a", "b", "c", "d"])).toBeNull();
  // A repeated line does not hide a new copy of itself.
  const same = ["route changed", "route changed", "other"];
  expect(newEntries(same, ["route changed", ...same])).toEqual(["route changed"]);
});

test("the sentence says what happened, or that nothing did", () => {
  expect(describeChange([])).toContain("no change recorded");
  expect(describeChange(["ip address added"])).toBe(
    "Router change log: 1 new entry (newest first):\n  - ip address added",
  );
  const many = describeChange(Array.from({ length: 20 }, (_, i) => `entry ${i}`));
  expect(many).toContain("20 new entries");
  expect(many).toContain("… and 8 more");
  expect(describeChange(null)).toContain("rolled over");
});

/** Through the registry: a write gets the router's log added; a read does not. */

const command = vi.hoisted(() => vi.fn());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
const original = getConfig();
afterEach(() => setConfig(original));

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
function register(verifyWrites: boolean): Record<string, Handler> {
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { home: { host: "192.0.2.1" } },
      defaultDevice: "home",
      verifyWrites,
    }),
  );
  const handlers: Record<string, Handler> = {};
  const server = {
    registerTool: (name: string, _meta: unknown, handler: Handler) => {
      handlers[name] = handler;
      return { enable() {}, disable() {} };
    },
  };
  registerTools(server as never, [
    [
      defineTool({
        name: "enable_thing",
        title: "Enable",
        description: "d",
        annotations: WRITE,
        inputSchema: { name: z.string() },
        handler: async (a, ctx) => {
          await (command as (c: string, x: unknown) => Promise<string>)(
            `/thing enable ${a.name}`,
            ctx,
          );
          return "Thing enabled successfully.";
        },
      }),
      defineTool({
        name: "note_thing",
        title: "Note",
        description: "d",
        annotations: WRITE,
        hostOnly: true,
        inputSchema: {},
        handler: async () => "Noted on the MCP host.",
      }),
      defineTool({
        name: "list_things",
        title: "List",
        description: "d",
        annotations: READ,
        inputSchema: {},
        handler: async () => "none",
      }),
    ],
  ]);
  return handlers;
}

beforeEach(() => command.mockReset());
const HEAD = "Flags: U - UNDOABLE\nColumns: ACTION, BY, POLICY, TIME\n";

test("a write that changed nothing says so, from the router's log", async () => {
  const tools = register(true);
  command.mockImplementation(async (cmd: string) =>
    cmd === "/system history print"
      ? `${HEAD}U old change  admin  write  2026-01-01 00:00:00\n`
      : "",
  );
  const text = (await tools.enable_thing!({ name: "ghost" })).content.map((c) => c.text).join("\n");
  expect(text).toContain("Thing enabled successfully.");
  expect(text).toContain("Router change log: no change recorded for this call.");
  expect(command.mock.calls.map((c) => c[0])).toEqual([
    "/system history print",
    "/thing enable ghost",
    "/system history print",
  ]);
  // The probe reads with READ risk, so it stays out of an open Safe Mode session.
  expect((command.mock.calls[0]![1] as { risk: string }).risk).toBe("READ");
});

test("a write that changed something lists the new entries; reads and opt-out add nothing", async () => {
  let tools = register(true);
  let done = false;
  command.mockImplementation(async (cmd: string) => {
    if (cmd !== "/system history print") {
      done = true;
      return "";
    }
    return `${HEAD}${done ? "U thing enabled  admin  write  2026-01-01 00:00:05\n" : ""}U old change  admin  write  2026-01-01 00:00:00\n`;
  });
  const text = (await tools.enable_thing!({ name: "real" })).content.map((c) => c.text).join("\n");
  expect(text).toContain("Router change log: 1 new entry (newest first):\n  - thing enabled");

  command.mockClear();
  await tools.list_things!({});
  expect(command).not.toHaveBeenCalled();

  tools = register(false);
  const plain = (await tools.enable_thing!({ name: "real" })).content.map((c) => c.text).join("\n");
  expect(plain).not.toContain("Router change log");
});

test("a change log that cannot be read never fails the write", async () => {
  const tools = register(true);
  command.mockImplementation(async (cmd: string) => {
    if (cmd === "/system history print") throw new Error("connection lost");
    return "";
  });
  const result = await tools.enable_thing!({ name: "real" });
  expect(result.content[0]!.text).toBe("Thing enabled successfully.");
  expect(JSON.stringify(result)).not.toContain("Router change log");
});

test("a write that changes only the MCP host does not read the router's log", async () => {
  const tools = register(true);
  const text = (await tools.note_thing!({})).content.map((c) => c.text).join("\n");
  expect(text).toContain("Noted on the MCP host.");
  expect(text).not.toContain("Router change log");
  // No SSH round trip for a tool that never touches the router.
  expect(command).not.toHaveBeenCalled();
});
