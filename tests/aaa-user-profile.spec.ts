import { beforeEach, expect, test, vi } from "vite-plus/test";
import { createContext } from "../src/core/context";
import { addAaaEntity } from "../src/tools/aaa-data";
import { quoteValue } from "../src/core/routeros";

const run = vi.hoisted(() => vi.fn());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: run }));
const ctx = createContext(undefined, "profile-test");
beforeEach(() => run.mockReset());

test("creates an ordinary user unchanged when no initial profile is selected", async () => {
  run.mockResolvedValue("");
  expect(
    await addAaaEntity(ctx, "um-users", { name: "alice", password: "test", profile: "" }),
  ).toEqual({ ok: true, message: "Created." });
  expect(run).toHaveBeenCalledExactlyOnceWith(
    "/user-manager user add name=alice password=test",
    ctx,
  );
});

test("validates the profile first, creates once, assigns and verifies on the same device", async () => {
  run
    .mockResolvedValueOnce("1")
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce("1");
  const result = await addAaaEntity(ctx, "um-users", {
    name: "alice",
    password: "test",
    profile: "Monthly plan",
  });
  expect(result).toEqual({ ok: true, message: "User created and profile assigned." });
  expect(run.mock.calls).toEqual([
    ['/user-manager profile print count-only where name="Monthly plan"', ctx],
    ["/user-manager user add name=alice password=test", ctx],
    ['/user-manager user-profile add user=alice profile="Monthly plan"', ctx],
    ['/user-manager user-profile print count-only where user=alice profile="Monthly plan"', ctx],
  ]);
});

test.each(["0", "2", "failure: not enough permissions", "not a count"])(
  "refuses creation when the profile cannot be verified: %s",
  async (count) => {
    run.mockResolvedValue(count);
    const result = await addAaaEntity(ctx, "um-users", { name: "alice", profile: "monthly" });
    expect(result.ok).toBe(false);
    expect(result.created).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
  },
);

test("does not assign anything when creation fails or the user already exists", async () => {
  run.mockResolvedValueOnce("1").mockResolvedValueOnce("failure: user already exists");
  const result = await addAaaEntity(ctx, "um-users", { name: "alice", profile: "monthly" });
  expect(result.ok).toBe(false);
  expect(result.created).toBeUndefined();
  expect(run).toHaveBeenCalledTimes(2);
});

test.each(["rejected", "timeout", "unverified"])(
  "reports the created user without replay or removal if assignment is %s",
  async (failure) => {
    run.mockResolvedValueOnce("1").mockResolvedValueOnce("");
    if (failure === "timeout") run.mockRejectedValueOnce(new Error("timeout"));
    else if (failure === "rejected") run.mockResolvedValueOnce("failure: not enough permissions");
    else run.mockResolvedValueOnce("").mockResolvedValueOnce("0");
    const result = await addAaaEntity(ctx, "um-users", { name: "alice", profile: "monthly" });
    expect(result).toMatchObject({ ok: false, created: true });
    expect(result.message).toContain("do not recreate");
    expect(run.mock.calls.filter(([cmd]) => cmd.startsWith("/user-manager user add"))).toHaveLength(
      1,
    );
    expect(run.mock.calls.some(([cmd]) => cmd.includes(" remove "))).toBe(false);
  },
);

test("quotes user and profile names in every command and never passes profile to user add", async () => {
  const name = 'alice; $test\n"';
  const profile = 'plan; /system reboot\n"';
  run
    .mockResolvedValueOnce("1")
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce("1");
  expect((await addAaaEntity(ctx, "um-users", { name, profile })).ok).toBe(true);
  const commands = run.mock.calls.map(([cmd]) => cmd as string);
  expect(commands[0]).toBe(
    `/user-manager profile print count-only where name=${quoteValue(profile)}`,
  );
  expect(commands[1]).toBe(`/user-manager user add name=${quoteValue(name)}`);
  expect(commands[2]).toBe(
    `/user-manager user-profile add user=${quoteValue(name)} profile=${quoteValue(profile)}`,
  );
  expect(commands.every((cmd) => !cmd.includes("\n"))).toBe(true);
});

test("rejects malformed profile/name values before device I/O", async () => {
  expect((await addAaaEntity(ctx, "um-users", { profile: "monthly" })).ok).toBe(false);
  expect(
    (await addAaaEntity(ctx, "um-users", { name: "alice", profile: 5 as unknown as string })).ok,
  ).toBe(false);
  expect(run).not.toHaveBeenCalled();
});
