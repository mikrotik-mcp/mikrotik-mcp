import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { ToolContext } from "../src/core/context";
import {
  UM_NOT_AVAILABLE,
  addAaaEntity,
  getRadiusIncoming,
  getUmSettings,
  listAaaEntity,
  removeAaaEntity,
  resetRadiusCounters,
  setRadiusIncoming,
  setUmSettings,
  toggleAaaEntity,
  updateAaaEntity,
} from "../src/tools/aaa-data";

const command = vi.hoisted(() => vi.fn<(cmd: string, ctx: ToolContext) => Promise<string>>());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
const ctx: ToolContext = { device: "fixture", info: vi.fn(), error: vi.fn() };
beforeEach(() => {
  command.mockReset();
  command.mockResolvedValue("");
});

describe("AAA data operations", () => {
  test("list joins stable ids and redacts secrets", async () => {
    command
      .mockResolvedValueOnce('0 address=192.0.2.1 secret="my secret" disabled=no')
      .mockResolvedValueOnce("*A");
    const result = await listAaaEntity(ctx, "radius");
    expect(result.available).toBe(true);
    expect(result.rows[0]?.[".id"]).toBe("*A");
    expect(result.rows[0]?.secret).toBe("••••••");
    expect(command.mock.calls.map(([cmd]) => cmd)).toEqual([
      "/radius print detail",
      ":put [/radius find]",
    ]);
  });

  test("empty, unavailable and rejected reads are distinct", async () => {
    command.mockResolvedValueOnce("");
    expect(await listAaaEntity(ctx, "radius")).toEqual({ available: true, rows: [] });
    command.mockResolvedValueOnce("bad command name user-manager");
    expect((await listAaaEntity(ctx, "um-users")).available).toBe(false);
    command.mockResolvedValueOnce("failure: denied");
    await expect(listAaaEntity(ctx, "radius")).rejects.toThrow("Router rejected");
  });

  test("add whitelists fields and quotes RouterOS values", async () => {
    const result = await addAaaEntity(ctx, "radius", {
      address: "192.0.2.1",
      secret: "two words",
      rogue: "ignored",
      comment: "branch office",
    });
    expect(result).toEqual({ ok: true, message: "Created." });
    expect(command.mock.calls[0]?.[0]).toContain('secret="two words"');
    expect(command.mock.calls[0]?.[0]).toContain('comment="branch office"');
    expect(command.mock.calls[0]?.[0]).not.toContain("rogue");
  });

  test("read-only and empty mutations issue no commands", async () => {
    expect((await addAaaEntity(ctx, "um-sessions", { name: "x" })).ok).toBe(false);
    expect((await updateAaaEntity(ctx, "radius", "*A", { rogue: "x" })).ok).toBe(false);
    expect((await setUmSettings(ctx, { rogue: "x" })).ok).toBe(false);
    expect((await setRadiusIncoming(ctx, { rogue: "x" })).ok).toBe(false);
    expect(command).not.toHaveBeenCalled();
  });

  test("update selects by id and reports RouterOS errors", async () => {
    command.mockResolvedValueOnce("failure: denied");
    const result = await updateAaaEntity(ctx, "radius", "*A", { comment: "updated value" });
    expect(result).toEqual({ ok: false, message: "failure: denied" });
    expect(command.mock.calls[0]?.[0]).toContain(
      '/radius set [find .id=*A] comment="updated value"',
    );
  });

  test("remove existence check prevents absent writes and reports failures", async () => {
    command.mockResolvedValueOnce("0");
    expect((await removeAaaEntity(ctx, "radius", "*A")).message).toContain("not found");
    expect(command).toHaveBeenCalledTimes(1);
    command.mockReset();
    command.mockResolvedValueOnce("1").mockResolvedValueOnce("failure: denied");
    expect((await removeAaaEntity(ctx, "radius", "*A")).ok).toBe(false);
    expect(command.mock.calls[1]?.[0]).toBe("/radius remove [find .id=*A]");
    command.mockReset();
    command.mockResolvedValueOnce("1").mockResolvedValueOnce("");
    expect((await removeAaaEntity(ctx, "radius", "*A")).ok).toBe(true);
  });

  test("toggle expresses enable and disable through disabled flag", async () => {
    expect((await toggleAaaEntity(ctx, "radius", "*A", true)).message).toBe("Enabled.");
    expect(command.mock.calls[0]?.[0]).toBe("/radius set [find .id=*A] disabled=no");
    expect((await toggleAaaEntity(ctx, "radius", "*A", false)).message).toBe("Disabled.");
    expect(command.mock.calls[1]?.[0]).toBe("/radius set [find .id=*A] disabled=yes");
    expect((await toggleAaaEntity(ctx, "um-profiles", "x", true)).ok).toBe(false);
  });

  test("missing User Manager is surfaced on writes", async () => {
    command.mockResolvedValueOnce("bad command name user-manager");
    expect((await addAaaEntity(ctx, "um-profiles", { name: "gold" })).message).toBe(
      UM_NOT_AVAILABLE,
    );
  });

  test("user creation checks profile before writing and verifies assignment", async () => {
    command
      .mockResolvedValueOnce("1")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("1");
    const result = await addAaaEntity(ctx, "um-users", { name: "alice", profile: "gold" });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("profile assigned");
    expect(command.mock.calls.map(([cmd]) => cmd)).toEqual([
      "/user-manager profile print count-only where name=gold",
      "/user-manager user add name=alice",
      "/user-manager user-profile add user=alice profile=gold",
      "/user-manager user-profile print count-only where user=alice profile=gold",
    ]);
  });

  test("unverifiable profile blocks create; failed confirmation reports partial creation", async () => {
    command.mockResolvedValueOnce("0");
    expect((await addAaaEntity(ctx, "um-users", { name: "alice", profile: "gold" })).ok).toBe(
      false,
    );
    expect(command).toHaveBeenCalledTimes(1);
    command.mockReset();
    command
      .mockResolvedValueOnce("1")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("0");
    const partial = await addAaaEntity(ctx, "um-users", { name: "alice", profile: "gold" });
    expect(partial).toMatchObject({ ok: false, created: true });
  });

  test("singleton reads redact and settings writes whitelist fields", async () => {
    command.mockResolvedValueOnce("accept: yes\nport: 3799\nsecret: hidden");
    expect(await getRadiusIncoming(ctx)).toMatchObject({ secret: "••••••" });
    command.mockResolvedValueOnce("enabled: yes");
    expect((await getUmSettings(ctx)).available).toBe(true);
    expect((await setRadiusIncoming(ctx, { accept: "yes", port: "3799", rogue: "x" })).ok).toBe(
      true,
    );
    expect(command.mock.calls.at(-1)?.[0]).toBe("/radius incoming set accept=yes port=3799");
    expect((await setUmSettings(ctx, { enabled: "yes", rogue: "x" })).ok).toBe(true);
    expect(command.mock.calls.at(-1)?.[0]).toBe("/user-manager set enabled=yes");
    expect((await resetRadiusCounters(ctx)).ok).toBe(true);
    expect(command.mock.calls.at(-1)?.[0]).toBe("/radius reset-counters");
  });
});
