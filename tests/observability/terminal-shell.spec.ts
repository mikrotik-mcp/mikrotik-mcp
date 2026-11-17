/** Shell recordings on disk: listing, reading, deleting, and safe ids. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";

vi.mock("../../src/ssh/client", () => ({ MikroTikSSHClient: class {} }));
vi.mock("../../src/core/runtime", () => ({ getDevice: () => ({}) }));
vi.mock("../../src/core/transport", () => ({
  isMacTelnetDevice: () => false,
  resolveJump: () => undefined,
  sshOptionsOf: () => ({}),
}));
vi.mock("../../src/observability/recorder", () => ({ recordToolCall: () => false }));

const shell = await import("../../src/observability/terminal-shell");

test("recordings are listed newest first and read by a safe id only", () => {
  const dir = mkdtempSync(join(tmpdir(), "term-rec-"));
  shell.setRecordingDir(dir);
  writeFileSync(join(dir, "1000_home-ax3_aaaaaaaa.cast"), '{"version":2}\n[0.1,"o","hi"]\n');
  writeFileSync(join(dir, "2000_lab_router_bbbbbbbb.cast"), '{"version":2}\n');
  writeFileSync(join(dir, "notes.txt"), "not a recording");
  expect(
    shell.listRecordings().map(({ id, device, started }) => ({ id, device, started })),
  ).toEqual([
    { id: "2000_lab_router_bbbbbbbb.cast", device: "lab_router", started: 2000 },
    { id: "1000_home-ax3_aaaaaaaa.cast", device: "home-ax3", started: 1000 },
  ]);
  expect(shell.readRecording("1000_home-ax3_aaaaaaaa.cast")).toContain('"hi"');
  // No path may leave the recordings folder.
  expect(shell.readRecording("../notes.txt")).toBeUndefined();
  expect(shell.readRecording("notes.txt")).toBeUndefined();
  expect(shell.deleteRecording("../../etc/passwd.cast")).toBe(false);
  expect(shell.deleteRecording("1000_home-ax3_aaaaaaaa.cast")).toBe(true);
  expect(shell.listRecordings()).toHaveLength(1);
  shell.setRecordingDir(undefined);
  expect(shell.listRecordings()).toEqual([]);
});
