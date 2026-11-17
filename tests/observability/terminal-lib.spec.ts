/** Terminal browser helpers that need no DOM. */
import { describe, expect, test, vi } from "vite-plus/test";

vi.stubGlobal("location", { search: "" });
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
const lib = await import("../../ui/observability/terminal-lib");

const blocks = [
  {
    ts: Date.UTC(2026, 0, 2, 3, 4, 5),
    command: "/ip address print",
    output: "0 10.0.0.1/24",
    status: "ok",
    ms: 12,
  },
  {
    ts: Date.UTC(2026, 0, 2, 3, 4, 6),
    command: "/ip adress print",
    output: "",
    status: "error",
    error: "bad command name",
  },
];

describe("session export", () => {
  test("txt is a transcript with errors marked", () => {
    const text = lib.exportSession("lab", blocks, "txt");
    expect(text).toContain("[2026-01-02 03:04:05] lab > /ip address print\n0 10.0.0.1/24");
    expect(text).toContain("! bad command name");
  });
  test("rsc keeps only the commands that succeeded", () => {
    const lines = lib.exportSession("lab", blocks, "rsc").trim().split("\n");
    expect(lines[0]).toMatch(/^# lab - commands exported/);
    expect(lines.slice(1)).toEqual(["/ip address print"]);
  });
  test("md has one section per command", () => {
    const text = lib.exportSession("lab", blocks, "md");
    expect(text).toContain("# Terminal session - lab");
    expect(text).toContain("### `/ip address print`");
    expect(text).toContain("```text\n0 10.0.0.1/24\n```");
    expect(text).toContain("bad command name");
  });
});

describe("snippets", () => {
  const snippet =
    "/ip firewall address-list add list={{list=blocked}} address={{ip}} comment={{ list }}";
  test("lists each placeholder once, with its default", () => {
    expect(lib.snippetFields(snippet)).toEqual([
      { name: "list", fallback: "blocked" },
      { name: "ip", fallback: "" },
    ]);
    expect(lib.snippetFields("/ip address print")).toEqual([]);
  });
  test("fills every occurrence, falling back to the default", () => {
    expect(lib.fillSnippet(snippet, { ip: "10.0.0.9", list: "" })).toBe(
      "/ip firewall address-list add list=blocked address=10.0.0.9 comment=blocked",
    );
    expect(lib.fillSnippet(snippet, { ip: "10.0.0.9", list: "guests" })).toBe(
      "/ip firewall address-list add list=guests address=10.0.0.9 comment=guests",
    );
  });
});

describe("watch alerts", () => {
  const output = "  uptime: 2d\n  cpu-load: 87%\n  free-memory: 512.5MiB\n ether1 link down";
  test("changed fires only when an earlier run differs", () => {
    expect(lib.evalAlert("changed", output, "")).toBeNull();
    expect(lib.evalAlert("changed", output, output)).toBeNull();
    expect(lib.evalAlert("Changed", output, "old")).toBe("The output changed.");
  });
  test("a number rule reads the value after the key", () => {
    expect(lib.evalAlert("cpu-load > 80", output, "")).toBe("cpu-load is 87 (> 80)");
    expect(lib.evalAlert("cpu-load > 90", output, "")).toBeNull();
    expect(lib.evalAlert("free-memory<=512.5", output, "")).toBe("free-memory is 512.5 (<= 512.5)");
    expect(lib.evalAlert("no-such-key > 1", output, "")).toBeNull();
  });
  test("text and regex rules, and a bad regex never throws", () => {
    expect(lib.evalAlert("LINK DOWN", output, "")).toContain("contains");
    expect(lib.evalAlert("/ether\\d+ link (down|up)/", output, "")).toContain("ether1 link down");
    expect(lib.evalAlert("/(/", output, "")).toBeNull();
    expect(lib.evalAlert("  ", output, "")).toBeNull();
  });
});

test("a script drops comments and blank lines, and joins continued lines", () => {
  const script = [
    "# header",
    "",
    "/ip address print",
    "/ip firewall filter add chain=input \\",
    "    action=accept comment=ok",
    "  # indented comment",
    "/log print",
  ].join("\n");
  expect(lib.scriptLines(script)).toEqual([
    "/ip address print",
    "/ip firewall filter add chain=input action=accept comment=ok",
    "/log print",
  ]);
  expect(lib.scriptLines("\n# only a comment\n")).toEqual([]);
});

describe("pipes", () => {
  test("splits trailing filters, and leaves RouterOS's own | alone", () => {
    expect(lib.splitPipes("/interface print | grep ether | count")).toEqual({
      command: "/interface print",
      filters: ["grep ether", "count"],
    });
    expect(lib.splitPipes(":put (1 | 2)").filters).toEqual([]);
    expect(lib.splitPipes('/log print where message~"a|b"').filters).toEqual([]);
    expect(lib.splitPipes(":put [:pick $a 0 1] | unknown").filters).toEqual([]);
    expect(lib.splitPipes("/ip address print").command).toBe("/ip address print");
  });
  test("applies grep, sort, uniq, head, tail and count in order", () => {
    const output = "ether2 up\nether1 down\nwg1 up\nether1 down\n";
    expect(lib.applyPipes(output, ["grep ether"])).toBe("ether2 up\nether1 down\nether1 down");
    expect(lib.applyPipes(output, ["grep -v ETHER", "count"])).toBe("1");
    expect(lib.applyPipes(output, ["grep ether", "sort", "uniq"])).toBe("ether1 down\nether2 up");
    expect(lib.applyPipes(output, ["head 1"])).toBe("ether2 up");
    expect(lib.applyPipes("a\nb\nc", ["tail 2"])).toBe("b\nc");
    expect(lib.applyPipes(output, ["grep ("])).toBe("");
  });
});

test("reads the number after a key, in print and as-value forms", () => {
  expect(lib.readNumber("  cpu-load: 37%\n  uptime: 2d", "cpu-load")).toBe(37);
  expect(lib.readNumber("rx-byte=1024;tx-byte=-5.5", "tx-byte")).toBe(-5.5);
  expect(lib.readNumber("cpu-load: 37%", "load")).toBeUndefined();
  expect(lib.readNumber("cpu-load: 37%", "")).toBeUndefined();
});

describe("output tokens", () => {
  test("finds IPv4 addresses, prefixes and MAC addresses, and nothing else", () => {
    const text = "0 10.0.0.1/24 ether1 00:0C:29:AB:cd:ef v7.25.1 999.1.1.1 12:39:53";
    const parts = lib.tokenize(text);
    expect(parts.filter((part) => typeof part !== "string")).toEqual([
      { kind: "ip", value: "10.0.0.1/24" },
      { kind: "mac", value: "00:0C:29:AB:cd:ef" },
    ]);
    expect(parts.map((part) => (typeof part === "string" ? part : part.value)).join("")).toBe(text);
  });
  test("suggests commands that use the host, not the prefix, for ping", () => {
    const commands = lib.tokenCommands({ kind: "ip", value: "10.0.0.1/24" });
    expect(commands[0]).toEqual({ label: "Ping", command: "/ping 10.0.0.1 count=4" });
    expect(commands.at(-1)?.command).toContain("address=10.0.0.1/24");
    expect(lib.tokenCommands({ kind: "mac", value: "00:0C:29:AB:CD:EF" })[0]?.command).toBe(
      "/ip arp print where mac-address=00:0C:29:AB:CD:EF",
    );
  });
});

describe("undo", () => {
  test("enable and disable swap, with the target kept", () => {
    expect(lib.planUndo("/interface disable ether5")).toEqual({
      kind: "known",
      undo: "/interface enable ether5",
    });
    expect(lib.planUndo("/ip firewall filter enable 3")).toEqual({
      kind: "known",
      undo: "/ip firewall filter disable 3",
    });
    expect(lib.planUndo("/interface set ether5 disabled=yes")).toEqual({
      kind: "known",
      undo: "/interface set ether5 disabled=no",
    });
  });
  test("an add is wrapped to learn the id, and undone by removing that id", () => {
    const plan = lib.planUndo("/ip address add address=10.0.0.1/24 interface=ether1");
    expect(plan).toEqual({
      kind: "add",
      wrapped: ":put [/ip address add address=10.0.0.1/24 interface=ether1]",
      path: "/ip address",
    });
    expect(lib.undoOfAdd("/ip address", "*1A\n")).toBe("/ip address remove *1A");
    expect(lib.undoOfAdd("/ip address", "failure: already have such address")).toBeUndefined();
  });
  test("nothing is offered when the undo is not certain", () => {
    for (const command of [
      "/ip address print",
      "/ip address remove 2",
      "/interface set ether5 mtu=1400",
      "/interface set ether5 disabled=yes mtu=1400",
      "/ip address add address=[:put 1] interface=ether1",
      "/interface disable ether5; /system reboot",
      ":put hello",
    ])
      expect(lib.planUndo(command), command).toBeNull();
  });
});

test("a recording is read frame by frame, and a cut-off last line is skipped", async () => {
  const { castSize, frameTimes, parseCast } =
    await import("../../ui/observability/terminal-recordings");
  const cast =
    '{"version":2,"width":80,"height":24}\n[0.1,"o","hello"]\n[0.5,"i","x"]\n[1.2,"o","\\r\\nworld"]\n[2.0,"o","cut';
  expect(parseCast(cast)).toEqual([
    [0.1, "hello"],
    [1.2, "\r\nworld"],
  ]);
  expect(castSize(cast)).toEqual({ cols: 80, rows: 24 });
  expect(castSize("not json")).toEqual({ cols: 100, rows: 30 });
  // A long idle pause is played as two seconds.
  expect(
    frameTimes([
      [0.5, "a"],
      [1.5, "b"],
      [61.5, "c"],
    ]),
  ).toEqual([0, 1, 3]);
});
