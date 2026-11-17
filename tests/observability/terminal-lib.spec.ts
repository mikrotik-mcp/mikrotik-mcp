/** Terminal browser helpers that need no DOM. */
import { describe, expect, test, vi } from "vite-plus/test";

vi.stubGlobal("location", { search: "" });
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
