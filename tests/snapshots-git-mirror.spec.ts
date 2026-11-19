/// <reference types="bun" />
/** Git mirror for snapshots: clean files, a commit only on change. The `git` program is faked. */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import {
  canonicalExport,
  configureGitMirror,
  gitMirrorIdle,
  mirrorSnapshot,
  noteSnapshot,
  safeName,
  setGitRunner,
} from "../src/snapshots/git-mirror";
import type { Snapshot } from "../src/snapshots/store";

const EXPORT = `# 2026-01-02 03:04:05 by RouterOS 7.25.1
# software id = ABCD-1234
/ip address
add address=10.0.0.1/24 interface=bridge
/interface bridge
add name=bridge
/ip address
add address=10.0.1.1/24 interface=ether2
`;

const snapshot = (over: Partial<Snapshot> = {}): Snapshot =>
  ({
    id: "s1",
    device: "MOM Afranet",
    ts: 1,
    body: EXPORT,
    bytes: 1,
    lines: 1,
    sha: "abc",
    ...over,
  }) as Snapshot;

afterEach(() => {
  setGitRunner();
  configureGitMirror();
});

test("a device name cannot leave the directory or look like an option", () => {
  expect(safeName("MOM Afranet")).toBe("MOM_Afranet");
  expect(safeName("../../etc/passwd")).toBe("_.._etc_passwd");
  expect(safeName("--upload-pack=x")).toBe("upload-pack_x");
  expect(safeName("...")).toBe("device");
});

test("the file has no timestamp, and sorting puts sections in a fixed order", () => {
  const plain = canonicalExport(EXPORT);
  expect(plain).not.toContain("2026-01-02");
  expect(plain.startsWith("# software id = ABCD-1234\n/ip address\n")).toBe(true);
  expect(canonicalExport(EXPORT.replace("03:04:05", "09:09:09"))).toBe(plain);

  expect(canonicalExport(EXPORT, true)).toBe(
    [
      "# software id = ABCD-1234",
      "/interface bridge",
      "add name=bridge",
      "/ip address",
      "add address=10.0.0.1/24 interface=bridge",
      "/ip address",
      "add address=10.0.1.1/24 interface=ether2",
      "",
    ].join("\n"),
  );
});

test("a change is committed with a safe argument list; no change makes no commit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "git-mirror-"));
  const calls: string[][] = [];
  let dirty = true;
  setGitRunner(async (args) => {
    calls.push(args);
    return args[0] === "status" && dirty ? " M MOM_Afranet.rsc\n" : "";
  });

  expect(
    await mirrorSnapshot(
      { dir, push: true, author: "Ops <ops@example.net>" },
      snapshot({ label: "pre-change" }),
    ),
  ).toBe("pushed");
  expect(readFileSync(join(dir, "MOM_Afranet.rsc"), "utf8")).toBe(canonicalExport(EXPORT));
  expect(calls.map((c) => (c[0] === "-c" ? "commit" : c[0]))).toEqual([
    "init",
    "add",
    "status",
    "commit",
    "push",
  ]);
  expect(calls[1]).toEqual(["add", "--", "MOM_Afranet.rsc"]);
  const commit = calls[3]!;
  expect(commit.slice(0, 4)).toEqual(["-c", "user.name=Ops", "-c", "user.email=ops@example.net"]);
  expect(commit[commit.indexOf("-m") + 1]).toBe("MOM Afranet: pre-change\n\nsha abc");
  expect(commit.slice(-2)).toEqual(["--", "MOM_Afranet.rsc"]);

  dirty = false;
  calls.length = 0;
  expect(await mirrorSnapshot({ dir }, snapshot())).toBe("unchanged");
  expect(calls.some((c) => c.includes("commit"))).toBe(false);
  expect(await mirrorSnapshot({ dir, commit: false }, snapshot())).toBe("written");
});

test("a failing git never throws into the snapshot path, and off does nothing", async () => {
  let ran = 0;
  setGitRunner(async () => {
    ran += 1;
    throw new Error("fatal: not a git repository");
  });
  noteSnapshot(snapshot());
  await gitMirrorIdle();
  expect(ran).toBe(0);

  configureGitMirror({ dir: mkdtempSync(join(tmpdir(), "git-mirror-")) });
  expect(() => noteSnapshot(snapshot())).not.toThrow();
  await gitMirrorIdle();
  expect(ran).toBe(1);
});
