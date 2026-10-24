import { beforeEach, expect, test, vi } from "vite-plus/test";
import { aaaViewTools } from "../src/tools/aaa-view";

const mock = vi.hoisted(() => ({
  list: vi.fn(),
  add: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  toggle: vi.fn(),
  incoming: vi.fn(),
  um: vi.fn(),
  setIncoming: vi.fn(),
  setUm: vi.fn(),
  reset: vi.fn(),
}));
vi.mock("../src/tools/aaa-data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tools/aaa-data")>()),
  listAaaEntity: mock.list,
  addAaaEntity: mock.add,
  updateAaaEntity: mock.update,
  removeAaaEntity: mock.remove,
  toggleAaaEntity: mock.toggle,
  getRadiusIncoming: mock.incoming,
  getUmSettings: mock.um,
  setRadiusIncoming: mock.setIncoming,
  setUmSettings: mock.setUm,
  resetRadiusCounters: mock.reset,
}));

const ctx = { device: "lab", info: vi.fn() };
async function call(name: string, args: Record<string, unknown> = {}) {
  const tool = aaaViewTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`${name} missing`);
  return tool.handler(args as never, ctx as never) as Promise<{
    text: string;
    structuredContent: Record<string, unknown>;
  }>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.list.mockResolvedValue({ available: true, rows: [{ id: "*1", name: "ali" }] });
  mock.incoming.mockResolvedValue({ accept: "yes" });
  mock.um.mockResolvedValue({ available: true, settings: { enabled: "yes" } });
  for (const fn of [
    mock.add,
    mock.update,
    mock.remove,
    mock.toggle,
    mock.setIncoming,
    mock.setUm,
    mock.reset,
  ])
    fn.mockResolvedValue({ ok: true, message: "applied" });
});

test("opening AAA view defaults to radius and returns structured rows", async () => {
  const output = await call("manage_radius_user_manager");
  expect(mock.list).toHaveBeenCalledWith(ctx, "radius");
  expect(output.text).toContain("radius: 1 row(s)");
  expect(output.structuredContent).toEqual(
    expect.objectContaining({
      __mikrotikView: "aaa-section",
      slug: "radius",
      rows: [{ id: "*1", name: "ali" }],
    }),
  );
});

test("unavailable User Manager is explained rather than displayed as an empty list", async () => {
  mock.list.mockResolvedValue({ available: false, rows: [] });
  const output = await call("get_aaa_section", { slug: "um-users" });
  expect(output.text).toContain("not installed");
  expect(output.structuredContent.available).toBe(false);
});

test.each(["add", "update", "remove", "toggle"] as const)(
  "%s mutation refreshes the section",
  async (op) => {
    const output = await call("aaa_mutate", {
      op,
      slug: "um-users",
      id: "*1",
      enable: true,
      fields: { name: "ali" },
    });
    expect(output.text).toContain("OK: applied");
    expect(mock.list).toHaveBeenCalledWith(ctx, "um-users");
    expect(output.structuredContent.lastOp).toEqual({ ok: true, message: "applied" });
    expect(
      { add: mock.add, update: mock.update, remove: mock.remove, toggle: mock.toggle }[op],
    ).toHaveBeenCalledTimes(1);
  },
);

test("mutation requiring an id refuses an incomplete request without device write", async () => {
  const output = await call("aaa_mutate", { op: "remove", slug: "um-users" });
  expect(output.text).toContain("Failed: id required");
  expect(mock.remove).not.toHaveBeenCalled();
  expect(mock.list).toHaveBeenCalledTimes(1);
});

test("settings read and write return refreshed CoA and User Manager state", async () => {
  const read = await call("get_aaa_settings");
  expect(read.structuredContent).toEqual(
    expect.objectContaining({
      __mikrotikView: "aaa-settings",
      umAvailable: true,
      umSettings: { enabled: "yes" },
    }),
  );
  for (const target of ["radius-incoming", "um-settings", "radius-reset-counters"]) {
    const output = await call("set_aaa_settings", { target, fields: { accept: "yes" } });
    expect(output.text).toContain("OK: applied");
    expect(output.structuredContent.lastOp).toEqual({ ok: true, message: "applied" });
  }
  expect(mock.setIncoming).toHaveBeenCalledTimes(1);
  expect(mock.setUm).toHaveBeenCalledTimes(1);
  expect(mock.reset).toHaveBeenCalledTimes(1);
});
