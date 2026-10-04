import { beforeEach, expect, test, vi } from "vite-plus/test";
import { createContext } from "../src/core/context";
import { quoteValue } from "../src/core/routeros";
import { updateAaaEntity } from "../src/tools/aaa-data";

const run = vi.hoisted(() => vi.fn());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: run }));
const ctx = createContext(undefined, "home-test");
const row = (id: string, profile: string, state = "running", user = "alice") => ({
  ".id": id,
  user,
  profile,
  state,
});
const old = row("*1", "Old", "running-active");
const target = row("*2", "10M-Standard");
const json = (...rows: ReturnType<typeof row>[]) => JSON.stringify(rows);
const commands = () => run.mock.calls.map(([command]) => command as string);
const writes = () =>
  commands().filter((command) => / (add|set|remove|activate-user-profile) /.test(command));
const edit = (fields: Record<string, string> = { profile: "10M-Standard" }) =>
  updateAaaEntity(ctx, "um-users", "alice", fields);
beforeEach(() => run.mockReset());

test("ordinary edits and blank profile preserve existing assignments", async () => {
  run.mockResolvedValue("");
  expect(
    (await updateAaaEntity(ctx, "um-users", "alice", { comment: "Updated", profile: "" })).ok,
  ).toBe(true);
  expect(run).toHaveBeenCalledExactlyOnceWith(
    "/user-manager user set [find name=alice] comment=Updated",
    ctx,
  );
});

test("profile-only edit reuses and activates an eligible assignment without deleting history", async () => {
  run
    .mockResolvedValueOnce("1")
    .mockResolvedValueOnce("1")
    .mockResolvedValueOnce(json(old, target))
    .mockResolvedValueOnce(json(old, target))
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce(json(row("*1", "Old"), { ...target, state: "running-active" }));
  expect(await edit()).toMatchObject({ ok: true });
  expect(writes()).toEqual([
    "/user-manager user-profile activate-user-profile [find where .id=*2 user=alice profile=10M-Standard]",
  ]);
  expect(run.mock.calls.every(([, context]) => context === ctx)).toBe(true);
});

test("creates once, verifies its stable id, activates it and verifies active state", async () => {
  run
    .mockResolvedValueOnce("1")
    .mockResolvedValueOnce("1")
    .mockResolvedValueOnce(json(old))
    .mockResolvedValueOnce(json(old))
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce(json(old, target))
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce(json(row("*1", "Old"), { ...target, state: "running active" }));
  expect((await edit()).ok).toBe(true);
  expect(writes()).toEqual([
    "/user-manager user-profile add user=alice profile=10M-Standard",
    "/user-manager user-profile activate-user-profile [find where .id=*2 user=alice profile=10M-Standard]",
  ]);
});

test("selecting the already active profile does not add, activate or restart validity", async () => {
  run
    .mockResolvedValueOnce("1")
    .mockResolvedValueOnce("1")
    .mockResolvedValue(json({ ...target, state: "running-active" }));
  expect((await edit()).ok).toBe(true);
  expect(writes()).toEqual([]);
});

test.each(["0", "2", "failure: access denied", "unknown"])(
  "unverified target (%s) blocks user-field writes too",
  async (count) => {
    run.mockResolvedValueOnce("1").mockResolvedValueOnce(count);
    expect((await edit({ profile: "10M-Standard", comment: "Changed" })).ok).toBe(false);
    expect(writes()).toEqual([]);
  },
);

test("missing users and malformed profile values fail closed", async () => {
  run.mockResolvedValue("0");
  expect((await edit()).ok).toBe(false);
  expect(writes()).toEqual([]);
  run.mockReset();
  expect((await edit({ profile: 5 as unknown as string })).ok).toBe(false);
  expect((await edit({ profile: "   " })).ok).toBe(false);
  expect(run).not.toHaveBeenCalled();
});

test.each([
  "not json",
  "{}",
  json({ ...target, user: "someone-else" }),
  json({ ...target, ".id": "0" }),
  json(target, target),
  json(old, { ...target, state: "running-active" }),
  json(target, row("*3", "10M-Standard")),
])("rejects incomplete, wrong-user or ambiguous snapshots before writes: %s", async (snapshot) => {
  run.mockResolvedValueOnce("1").mockResolvedValueOnce("1").mockResolvedValue(snapshot);
  expect((await edit()).ok).toBe(false);
  expect(writes()).toEqual([]);
});

test("expired assignments are retained but not reactivated", async () => {
  const expired = row("*9", "10M-Standard", "used");
  run
    .mockResolvedValueOnce("1")
    .mockResolvedValueOnce("1")
    .mockResolvedValueOnce(json(old, expired))
    .mockResolvedValueOnce(json(old, expired))
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce(json(old, expired, target))
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce(json(expired, { ...target, state: "running-active" }));
  expect((await edit()).ok).toBe(true);
  expect(writes()).toHaveLength(2);
  expect(writes().some((cmd) => cmd.includes("*9") || cmd.includes("remove"))).toBe(false);
});

test("combined rename and profile change uses the new name and never sends profile to user set", async () => {
  const user = 'new; $name\n"';
  const profile = 'plan; /system reboot\n"';
  const pending = row("*2", profile);
  run
    .mockResolvedValueOnce("1")
    .mockResolvedValueOnce("1")
    .mockResolvedValueOnce(json(pending))
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce(json({ ...pending, user }))
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce(json({ ...pending, user, state: "running-active" }));
  expect(
    (await updateAaaEntity(ctx, "um-users", "alice", { name: user, profile, comment: "Updated" }))
      .ok,
  ).toBe(true);
  expect(writes()[0]).toBe(
    `/user-manager user set [find where name=alice] name=${quoteValue(user)} comment=Updated`,
  );
  expect(writes()[1]).toContain(`user=${quoteValue(user)} profile=${quoteValue(profile)}`);
  expect(commands().every((cmd) => !cmd.includes("\n"))).toBe(true);
});

test.each(["rejected", "timeout", "unverified"])(
  "uncertain activation (%s) is not retried or reported as success",
  async (failure) => {
    run
      .mockResolvedValueOnce("1")
      .mockResolvedValueOnce("1")
      .mockResolvedValueOnce(json(old, target))
      .mockResolvedValueOnce(json(old, target));
    if (failure === "timeout") run.mockRejectedValueOnce(new Error("timeout"));
    else if (failure === "rejected") run.mockResolvedValueOnce("failure: not enough permissions");
    else run.mockResolvedValueOnce("").mockResolvedValueOnce(json(old, target));
    expect(await edit()).toMatchObject({ ok: false, reviewRequired: true });
    expect(writes()).toHaveLength(1);
  },
);

test("a lost add response never causes a duplicate or unverified activation", async () => {
  run
    .mockResolvedValueOnce("1")
    .mockResolvedValueOnce("1")
    .mockResolvedValueOnce(json(old))
    .mockResolvedValueOnce(json(old))
    .mockRejectedValueOnce(new Error("timeout after write"));
  expect(await edit()).toMatchObject({ ok: false, reviewRequired: true });
  expect(writes()).toEqual(["/user-manager user-profile add user=alice profile=10M-Standard"]);
});

test("an assignment changed during preflight is not silently replaced or duplicated", async () => {
  run
    .mockResolvedValueOnce("1")
    .mockResolvedValueOnce("1")
    .mockResolvedValueOnce(json(old))
    .mockResolvedValueOnce(json(old, target));
  expect((await edit()).ok).toBe(false);
  expect(writes()).toEqual([]);
});
