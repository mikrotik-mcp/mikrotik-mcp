/** Files browser helpers that need no DOM. */
import { expect, test, vi } from "vite-plus/test";

vi.stubGlobal("location", { search: "" });
const lib = await import("../../ui/observability/files-lib");

const file = (name: string, size: number, mtime = 100) => ({ name, size, mtime, dir: false });

test("two folders are compared by name and size, without their folders", () => {
  const rows = lib.compareFolders(
    [
      file("a.rsc", 10),
      file("b.backup", 20, 300),
      file("same.txt", 5),
      { ...file("skins", 0), dir: true },
    ],
    [file("b.backup", 25, 200), file("c.npk", 30), file("same.txt", 5)],
  );
  expect(rows.map((row) => [row.name, row.state, row.newer])).toEqual([
    ["a.rsc", "left", undefined],
    ["b.backup", "different", "left"],
    ["c.npk", "right", undefined],
    ["same.txt", "same", undefined],
  ]);
});

test("a file kind comes from its name", () => {
  expect(lib.kindOf({ name: "x.backup", dir: false })).toBe("backup");
  expect(lib.kindOf({ name: "routeros-7.16-arm64.npk", dir: false })).toBe("package");
  expect(lib.kindOf({ name: "x.backup", dir: true })).toBe("folder");
  expect(lib.conflicts([file("a", 1)], ["a", "b"])).toEqual(["a"]);
});

test("a package is checked against the router before it is uploaded", () => {
  const arm = { arch: "arm64", version: "7.16.1" };
  expect(lib.npkInfo("routeros-7.16.1-arm64.npk")).toEqual({
    pkg: "routeros",
    version: "7.16.1",
    arch: "arm64",
  });
  expect(lib.npkInfo("notes.txt")).toBeNull();
  expect(lib.packageWarnings("routeros-7.17-arm64.npk", arm)).toEqual([]);
  expect(lib.packageWarnings("wireless-7.16.1-arm64.npk", arm)).toEqual([]);
  expect(lib.packageWarnings("routeros-7.16.1-mipsbe.npk", arm)[0]).toContain("is for mipsbe");
  expect(lib.packageWarnings("routeros-7.16.1.npk", arm)[0]).toContain("is for x86");
  expect(lib.packageWarnings("routeros-7.16.1.npk", { arch: "x86_64", version: "7.16.1" })).toEqual(
    [],
  );
  expect(lib.packageWarnings("wireless-7.15-arm64.npk", arm)[0]).toContain("version 7.15");
  expect(lib.packageWarnings("routeros-7.16.1-arm.npk", {})).toEqual([]);
});

test("the storage report groups by top folder and suggests what to remove", () => {
  const day = 24 * 60 * 60;
  const now = 100 * day;
  const at = (path: string, size: number, ageDays = 0) => ({
    path,
    size,
    mtime: now - ageDays * day,
  });
  const report = lib.analyzeDisk(
    [
      at("/autosupout.rif", 500),
      at("/usb1/b1.backup", 100, 1),
      at("/usb1/b2.backup", 100, 2),
      at("/usb1/b3.backup", 100, 40),
      at("/usb1/b4.backup", 100, 50),
      at("/usb1/b5.backup", 100, 60),
      at("/big.npk.part", 50),
      at("/notes.txt", 5),
    ],
    now,
  );
  expect(report.total).toBe(1055);
  expect(report.groups).toEqual([
    { name: "files in /", bytes: 555, count: 3 },
    { name: "/usb1", bytes: 500, count: 5 },
  ]);
  expect(report.largest[0]?.path).toBe("/autosupout.rif");
  expect(
    report.suggestions.map((item) => [item.title, item.files.map((file) => file.path)]),
  ).toEqual([
    ["Support output files", ["/autosupout.rif"]],
    ["Old backups", ["/usb1/b4.backup", "/usb1/b5.backup"]],
    ["Unfinished copies", ["/big.npk.part"]],
  ]);
});
