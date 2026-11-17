/**
 * Dashboard terminal: who may use it, how a command is classified, how the
 * router's inspect replies are parsed, and what the run route streams.
 * No router: the device choke point is mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DeviceConnectionError } from "../../src/core/device-connection-error";
import {
  classifyCommand,
  createTerminalRoutes,
  parseCompletions,
  parseFoundTools,
  parseHighlight,
  parseSyntaxHelp,
  rankCommands,
  terminalAccess,
} from "../../src/observability/terminal-routes";

const state = vi.hoisted(() => ({
  readOnly: false,
  run: vi.fn(),
  capture: vi.fn(),
  safe: {
    isActive: false,
    enable: vi.fn(),
    commit: vi.fn(),
    rollback: vi.fn(),
  },
  history: [] as Record<string, unknown>[],
}));
vi.mock("../../src/core/connector", async (original) => ({
  ...(await original<typeof import("../../src/core/connector")>()),
  executeMikrotikCommand: state.run,
}));
vi.mock("../../src/tools/tool-gateway", () => ({ toolGatewayTools: [] }));
vi.mock("../../src/ssh/safe-mode", () => ({
  getSafeModeManager: () => state.safe,
}));
vi.mock("../../src/tools/config-snapshot", () => ({
  configSnapshotTools: [
    {
      name: "capture_config_snapshot",
      inputSchema: {},
      handler: (...a: unknown[]) => state.capture(...a),
    },
    { name: "diff_config_snapshots", inputSchema: {}, handler: async () => "CONFIG DIFF\n+added" },
  ],
}));
vi.mock("../../src/core/runtime", () => ({
  getConfig: () => ({ readOnly: state.readOnly }),
  resolveDeviceName: (name?: string) => name ?? "lab",
}));

const routes = (denied: string | null = null) =>
  createTerminalRoutes({
    denied,
    store: async () =>
      ({
        addHistory: (entry: Record<string, unknown>) => state.history.push(entry),
      }) as never,
  });
const call = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
  const url = new URL(`http://127.0.0.1:9090${path}`);
  return routes()(
    new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body) }),
    url,
  );
};
const lines = async (res: Response | null) =>
  (await res!.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

beforeEach(() => {
  state.readOnly = false;
  state.run.mockReset();
  state.capture.mockReset();
  state.history = [];
});

describe("terminal access", () => {
  it("needs a dashboard token or a loopback bind, and honours the off switch", () => {
    expect(terminalAccess({ host: "127.0.0.1" })).toBeNull();
    expect(terminalAccess({ host: "0.0.0.0", token: "t" })).toBeNull();
    expect(terminalAccess({ host: "0.0.0.0" })).toMatch(/token/);
    expect(terminalAccess({ host: "192.0.2.5" })).toMatch(/127\.0\.0\.1/);
    expect(terminalAccess({ host: "127.0.0.1", terminal: false })).toMatch(/turned off/);
  });

  it("answers 403 on every route but state when denied", async () => {
    const denied = routes("locked");
    const at = (path: string) => new URL(`http://127.0.0.1:9090${path}`);
    const stateRes = await denied(
      new Request(at("/api/terminal/state")),
      at("/api/terminal/state"),
    );
    expect(await stateRes!.json()).toMatchObject({ enabled: false, reason: "locked" });
    const run = at("/api/terminal/run");
    const res = await denied(
      new Request(run, { method: "POST", body: '{"command":"/log print"}' }),
      run,
    );
    expect(res!.status).toBe(403);
    expect(state.run).not.toHaveBeenCalled();
  });
});

describe("command classification", () => {
  it("treats prints, exports and diagnostics as reads", () => {
    for (const command of [
      "/ip address print",
      "ip address print detail where disabled=no",
      "/export",
      "/ping 1.1.1.1 count=3",
      "/tool traceroute 1.1.1.1",
      ":put hello",
    ])
      expect(classifyCommand(command), command).toBe("READ");
  });
  it("treats everything else as a write, and removals as destructive", () => {
    expect(classifyCommand("/ip address add address=10.0.0.1/24 interface=ether1")).toBe("WRITE");
    expect(classifyCommand(":put [/system reset-configuration]")).toBe("DESTRUCTIVE");
    expect(classifyCommand("/ip firewall filter remove [find]")).toBe("DESTRUCTIVE");
    expect(classifyCommand("/system reboot")).toBe("DESTRUCTIVE");
    expect(classifyCommand("/ip address print; /system reboot")).toBe("DESTRUCTIVE");
  });
});

describe("router inspect replies", () => {
  it("reads one token class per input byte", () => {
    expect(parseHighlight("highlight=dir;dir;none;obj-inactive;type=highlight\r\n")).toEqual([
      "dir",
      "dir",
      "none",
      "obj-inactive",
    ]);
    expect(parseHighlight("")).toEqual([]);
  });
  it("keeps shown completions, best first, with their offset", () => {
    const print = [
      "Columns: TYPE, COMPLETION, STYLE, OFFSET, PREFERENCE, SHOW",
      "TYPE        COMPLETION  STYLE        OFFSET  PREFERENCE  SHOW",
      "completion  /           dir               8  95          yes ",
      "completion  address     dir               4  96          yes ",
      "completion              none              8  -1          no  ",
      "completion  ;           syntax-meta       8  40          no  ",
    ].join("\r\n");
    expect(parseCompletions(print)).toEqual([
      { completion: "address", style: "dir", offset: 4 },
      { completion: "/", style: "dir", offset: 8 },
    ]);
  });
});

describe("suggestions", () => {
  it("ranks known commands by the words of the question, each command once", () => {
    const known = [
      "/ip firewall filter print",
      "/ip address print",
      "/ip firewall filter print",
      "/log print",
    ];
    expect(rankCommands("show firewall filter rules", known)).toEqual([
      "/ip firewall filter print",
    ]);
    expect(rankCommands("ip print", known)).toEqual([
      "/ip firewall filter print",
      "/ip address print",
      "/log print",
    ]);
    expect(rankCommands("a ?", known)).toEqual([]);
  });
  it("reads tool names and titles from a find_tools answer", () => {
    const answer =
      'Found 2 tools for "nat":\n\n1. create_nat_rule  [Firewall NAT]\n   Create NAT Rule — adds a rule · params: chain\n   Run: …\n\n' +
      "2. list_nat_rules  [Firewall NAT]\n   List NAT Rules — lists them · params: none\n   Run: …";
    expect(parseFoundTools(answer)).toEqual([
      { name: "create_nat_rule", title: "Create NAT Rule" },
      { name: "list_nat_rules", title: "List NAT Rules" },
    ]);
  });
});

describe("router syntax help", () => {
  it("reads each explanation, keeps a semicolon inside a text, drops empty records", () => {
    const reply =
      "nested=0;nonorm=true;symbol=;symbol-type=collection;text=;type=syntax;" +
      "nested=1;nonorm=false;symbol=address;symbol-type=explanation;text=Local IP address;type=syntax;" +
      "nested=1;nonorm=false;symbol=;symbol-type=definition;text=ether1 | lo | ...;type=syntax;" +
      "nested=2;nonorm=false;symbol=wg-rw;symbol-type=explanation;text=WG server; phones;type=syntax\r\n";
    expect(parseSyntaxHelp(reply)).toEqual([
      { symbol: "address", text: "Local IP address", nested: 1 },
      { symbol: "", text: "ether1 | lo | ...", nested: 1 },
      { symbol: "wg-rw", text: "WG server; phones", nested: 2 },
    ]);
    expect(parseSyntaxHelp("")).toEqual([]);
  });
});

describe("safe mode", () => {
  const act = async (action: string) =>
    (await call("/api/terminal/safe-mode", { device: "lab", action }))!;

  it("enables, commits and rolls back through the device's Safe Mode session", async () => {
    state.safe.enable.mockImplementation(async () => {
      state.safe.isActive = true;
      return "Safe mode enabled.";
    });
    state.safe.commit.mockResolvedValue({ ok: true, message: "Changes kept." });
    state.safe.rollback.mockResolvedValue("Rolled back.");
    expect(await (await act("enable")).json()).toEqual({
      ok: true,
      message: "Safe mode enabled.",
      active: true,
    });
    expect(await (await act("commit")).json()).toMatchObject({
      ok: true,
      message: "Changes kept.",
    });
    expect(await (await act("rollback")).json()).toMatchObject({ message: "Rolled back." });
    state.safe.isActive = false;
  });

  it("reports a failed enable or commit as not ok, and rejects other actions", async () => {
    state.safe.enable.mockResolvedValue("Error: could not open the session");
    state.safe.commit.mockResolvedValue({ ok: false, message: "Nothing was saved." });
    expect(await (await act("enable")).json()).toMatchObject({ ok: false });
    expect(await (await act("commit")).json()).toMatchObject({ ok: false });
    expect((await act("explode")).status).toBe(400);
    state.readOnly = true;
    expect((await act("enable")).status).toBe(403);
  });
});

describe("run route", () => {
  it("streams output, then an end record, and saves the command", async () => {
    state.run.mockImplementation(async (_command, _ctx, opts) => {
      opts.onData("line 1\r\n");
      opts.onData("line 2\r\n");
      return "line 1\r\nline 2\r\n";
    });
    const out = await lines(
      await call("/api/terminal/run", { device: "lab", command: " /log print " }),
    );
    expect(out.map((m) => m.t)).toEqual(["start", "out", "out", "end"]);
    expect(out[0]).toMatchObject({ device: "lab", risk: "READ" });
    expect(out.at(-1)).toMatchObject({ ok: true, retryable: false });
    expect(state.run.mock.calls[0][0]).toBe("/log print");
    expect(state.history[0]).toMatchObject({ device: "lab", command: "/log print", ok: true });
  });

  it("reports a command RouterOS rejected as failed and not retryable", async () => {
    state.run.mockResolvedValue("syntax error (line 1 column 5)");
    const end = (await lines(await call("/api/terminal/run", { command: "/ip adress print" }))).at(
      -1,
    );
    expect(end).toMatchObject({ ok: false, retryable: false });
  });

  it("allows a retry only when the retry cannot repeat a change", async () => {
    const endOf = async (command: string) =>
      (await lines(await call("/api/terminal/run", { command }))).at(-1);
    // Never reached the router: any command may be sent again.
    state.run.mockRejectedValue(new DeviceConnectionError("lab", "connect failed"));
    expect(await endOf("/ip address add address=10.0.0.1/24 interface=ether1")).toMatchObject({
      ok: false,
      retryable: true,
    });
    // Lost after dispatch: a read may repeat, a write may already have run.
    state.run.mockRejectedValue(new Error("SSH connection closed before command completion."));
    expect(await endOf("/ip address print")).toMatchObject({ retryable: true });
    expect(await endOf("/ip address add address=10.0.0.1/24 interface=ether1")).toMatchObject({
      retryable: false,
    });
  });

  it("takes a snapshot before a change when asked, and never before a read", async () => {
    state.run.mockResolvedValue("");
    state.capture.mockResolvedValue("captured");
    const write = "/ip address add address=10.0.0.1/24 interface=ether1";
    const end = (
      await lines(await call("/api/terminal/run", { command: write, snapshot: true }))
    ).at(-1);
    expect(end).toMatchObject({ ok: true, snapshot: true });
    expect(state.capture).toHaveBeenCalledOnce();
    await lines(await call("/api/terminal/run", { command: "/log print", snapshot: true }));
    await lines(await call("/api/terminal/run", { command: write }));
    expect(state.capture).toHaveBeenCalledOnce();
  });

  it("does not run the change when the snapshot fails", async () => {
    state.capture.mockRejectedValue(new Error("disk full"));
    const end = (
      await lines(await call("/api/terminal/run", { command: "/system reboot", snapshot: true }))
    ).at(-1);
    expect(end).toMatchObject({ ok: false, retryable: false, snapshot: false });
    expect(end.error).toMatch(/NOT run.*disk full/);
    expect(state.run).not.toHaveBeenCalled();
  });

  it("reports what changed since the newest snapshot", async () => {
    const res = await call("/api/terminal/changes", { device: "lab" });
    expect(await res!.json()).toEqual({ text: "CONFIG DIFF\n+added" });
  });

  it("refuses writes on a read-only server and rejects cross-origin requests", async () => {
    state.readOnly = true;
    expect((await call("/api/terminal/run", { command: "/system reboot" }))!.status).toBe(403);
    expect((await call("/api/terminal/run", { command: "/log print" }))!.status).toBe(200);
    state.readOnly = false;
    const url = new URL("http://127.0.0.1:9090/api/terminal/run");
    const foreign = await routes()(
      new Request(url, {
        method: "POST",
        headers: { origin: "https://evil.example" },
        body: '{"command":"/log print"}',
      }),
      url,
    );
    expect(foreign!.status).toBe(403);
  });
});
