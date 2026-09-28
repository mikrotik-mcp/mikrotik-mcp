import { beforeEach, expect, test, vi } from "vite-plus/test";
import {
  previewMigration,
  applyMigration,
  undoMigration,
  verifyMigrationItem,
} from "../../src/migration/service";
import { MikrotikConfigSchema } from "../../src/config";
import { setConfig } from "../../src/core/runtime";

const fake = vi.hoisted(() => ({
  records: new Map<string, any>(),
  trace: [] as string[],
  active: false,
  added: false,
  commitOk: true,
  failWrite: false,
  changed: false,
  backupFail: false,
  claimConflict: false,
  flagOutput: "",
}));
vi.mock("../../src/workspaces/store", () => ({
  workspaceStore: async () => ({
    save: (_k: string, p: any) => fake.records.set(p.id, structuredClone(p)),
    get: (_k: string, id: string, d: string) => {
      const p = fake.records.get(id);
      return p?.device === d ? structuredClone(p) : undefined;
    },
    claim: (_k: string, p: any, status: string) => {
      if (fake.claimConflict) {
        fake.records.set(p.id, { ...structuredClone(p), error: "owned by another process" });
        throw new Error("Already claimed by another process");
      }
      expect(fake.records.get(p.id).status).toBe(status);
      fake.records.set(p.id, structuredClone(p));
      fake.trace.push("claim");
    },
  }),
}));
vi.mock("../../src/snapshots/capture", () => ({
  captureSnapshot: async (ctx: any) => {
    fake.trace.push(`backup:${ctx.device}`);
    if (fake.backupFail) throw new Error("backup failed");
    return `snapshot-${ctx.device}`;
  },
}));
vi.mock("../../src/ssh/safe-mode", () => ({
  getSafeModeManager: () => ({
    get isActive() {
      return fake.active;
    },
    enable: async () => {
      fake.trace.push("enable");
      fake.active = true;
      return "Safe mode ENABLED";
    },
    rollback: async () => {
      fake.trace.push("rollback");
      fake.active = false;
      fake.added = false;
      return "rolled back";
    },
    commit: async () => {
      fake.trace.push("commit");
      fake.active = false;
      return { ok: fake.commitOk };
    },
  }),
}));
vi.mock("../../src/home/read", () => ({
  rows: async (path: string, _fields: string, ctx: any) =>
    path === "/system package"
      ? [{ name: "routeros", version: "7.20" }]
      : ctx.device === "old"
        ? [{ name: "ether1", type: "ether", "mac-address": "00:11:22:33:44:01" }]
        : [
            { name: "ether8", type: "ether", "mac-address": "00:11:22:33:44:08" },
            { name: "ether9", type: "ether", "mac-address": "00:11:22:33:44:09" },
          ],
  checkedRead: async (command: string, ctx: any) => {
    if (command === "/system resource print")
      return "version: 7.20\nboard-name: CHR\narchitecture-name: x86_64";
    if (command === "/export terse")
      return ctx.device === "old"
        ? "/interface bridge\nadd name=lan"
        : `/system identity\nset name=target${
            fake.changed ? "-edited" : ""
          }${fake.added ? "\n/interface bridge\nadd name=lan" : ""}`;
    if (command.includes(" add ")) {
      fake.trace.push("write");
      if (fake.failWrite) throw new Error("ambiguous SSH timeout");
      fake.added = true;
      return "";
    }
    if (command.includes("print detail")) {
      if (fake.flagOutput) return fake.flagOutput;
      const p = [...fake.records.values()].at(-1);
      const item = p.items[0];
      return `0 name=lan disabled=yes comment=${item.tag}`;
    }
    if (command.includes(" remove ")) {
      fake.trace.push("remove");
      fake.added = false;
      return "";
    }
    return "name: target";
  },
}));
vi.mock("../../src/snapshots/store", () => ({
  openSnapshotStore: async () => ({
    get: () => ({ body: "/system identity\nset name=target" }),
    close: () => {},
  }),
}));

beforeEach(() => {
  fake.records.clear();
  fake.trace = [];
  Object.assign(fake, {
    active: false,
    added: false,
    commitOk: true,
    failWrite: false,
    changed: false,
    backupFail: false,
    claimConflict: false,
    flagOutput: "",
  });
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { old: { host: "192.0.2.1" }, new: { host: "192.0.2.2" } },
      defaultDevice: "old",
    }),
  );
});
const preview = () =>
  previewMigration(
    {
      source: "old",
      target: "new",
      managementInterface: "ether9",
      mapping: { ether1: "ether8" },
      sections: ["/interface/bridge"],
    },
    "new",
  );

test("preview is read-only; rehearsal backs up both routers before Safe Mode and verifies rollback", async () => {
  const p = await preview();
  expect(p.blockers).toEqual([]);
  expect(fake.trace).toEqual([]);
  const result = await applyMigration(p.id, "rehearse", true, true, "new");
  expect(result.status).toBe("rehearsed");
  expect(fake.trace).toEqual(["backup:old", "backup:new", "claim", "enable", "write", "rollback"]);
  expect(fake.added).toBe(false);
});
test("staging and undo use guarded ownership; no blind second application", async () => {
  const p = await preview();
  expect((await applyMigration(p.id, "stage", true, true, "new")).status).toBe("staged");
  await expect(applyMigration(p.id, "stage", true, true, "new")).rejects.toThrow("fresh");
  expect((await undoMigration(p.id, true, "new")).status).toBe("undone");
  expect(fake.trace).toContain("backup:new");
  expect(fake.trace.filter((t) => t === "commit")).toHaveLength(2);
});
test("a losing atomic claim never overwrites the winning migration or starts Safe Mode", async () => {
  const p = await preview();
  fake.claimConflict = true;
  await expect(applyMigration(p.id, "stage", true, true, "new")).rejects.toThrow("claimed");
  expect(fake.records.get(p.id).status).toBe("applying");
  expect(fake.records.get(p.id).error).toBe("owned by another process");
  expect(fake.trace).not.toContain("enable");
  expect(fake.trace).not.toContain("write");
});
test("read-back understands RouterOS disabled flags but rejects an activated object", async () => {
  const p = await preview();
  const item = p.items[0];
  fake.flagOutput = `Flags: X - disabled, R - running\n0 X ;;; ${item.tag}\n name=lan`;
  await expect(verifyMigrationItem(item, "new")).resolves.toBeUndefined();
  fake.flagOutput = `Flags: X - disabled, R - running\n0 R ;;; ${item.tag}\n name=lan`;
  await expect(verifyMigrationItem(item, "new")).rejects.toThrow("not verified");
});
test.each(["approval", "stale", "backup", "existingSafeMode"])(
  "%s prevents router writes",
  async (reason) => {
    const p = await preview();
    if (reason === "stale") fake.changed = true;
    if (reason === "backup") fake.backupFail = true;
    if (reason === "existingSafeMode") fake.active = true;
    await expect(
      applyMigration(p.id, "stage", reason !== "approval", true, "new"),
    ).rejects.toThrow();
    expect(fake.trace).not.toContain("write");
    expect(fake.trace).not.toContain("rollback");
  },
);
test("ambiguous write rolls back once and remains uncertain; ambiguous commit is never retried or rolled back", async () => {
  const p = await preview();
  fake.failWrite = true;
  await expect(applyMigration(p.id, "stage", true, true, "new")).rejects.toThrow("timeout");
  expect(fake.records.get(p.id).status).toBe("uncertain");
  expect(fake.trace.filter((t) => t === "write")).toHaveLength(1);
  expect(fake.trace).toContain("rollback");
  fake.failWrite = false;
  fake.trace = [];
  const other = await preview();
  fake.commitOk = false;
  await expect(applyMigration(other.id, "stage", true, true, "new")).rejects.toThrow("uncertain");
  expect(fake.trace).not.toContain("rollback");
  expect(fake.records.get(other.id).status).toBe("uncertain");
});
