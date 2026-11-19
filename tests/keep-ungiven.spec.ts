/**
 * A tool that changes an item must keep every setting the caller did not give.
 * The catalog-wide rule is in command-injection-catalog.spec.ts; these are the
 * cases it cannot see: a setting that shares one RouterOS field with another,
 * and a setting saved on the host.
 */
import { beforeEach, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../src/config";
import type { ToolContext } from "../src/core/context";
import { setConfig } from "../src/core/runtime";

const router = vi.hoisted(() => ({
  queues: 1,
  detail: "0 name=client-10.0.0.7 target=10.0.0.7/32 max-limit=2M/10M",
  sent: [] as string[],
}));
vi.mock("../src/core/connector", () => ({
  executeMikrotikCommand: async (command: string) => {
    router.sent.push(command);
    if (command.includes("count-only")) return String(router.queues);
    if (command.includes("print detail")) return router.detail;
    return "";
  },
}));

const home = vi.hoisted(() => ({ saved: [] as Record<string, unknown>[] }));
vi.mock("../src/home/store", () => ({
  homeStore: async () => ({
    clients: () => [
      { mac: "AA:BB:CC:DD:EE:FF", name: "Phone", person: "Sara", acknowledged: false },
    ],
    saveClient: (_device: string, client: Record<string, unknown>) => home.saved.push(client),
  }),
}));

const { setDeviceLimits } = await import("../src/tools/connected-devices");
const { homeInternetTools } = await import("../src/tools/home-internet");

const ctx: ToolContext = { device: "lab", info: vi.fn(), error: vi.fn() };
const writes = () => router.sent.filter((command) => / (?:set|add) /.test(command));

beforeEach(() => {
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { lab: { host: "192.0.2.1", port: 22 } },
      defaultDevice: "lab",
    }),
  );
  router.queues = 1;
  router.detail = "0 name=client-10.0.0.7 target=10.0.0.7/32 max-limit=2M/10M";
  router.sent = [];
  home.saved = [];
});

test("a rate limit that is not given keeps its value", async () => {
  // RouterOS max-limit is upload/download.
  expect((await setDeviceLimits(ctx, "10.0.0.7", { download: "20M" })).ok).toBe(true);
  expect(writes()).toEqual(['/queue simple set [find target~"10.0.0.7"] max-limit=2M/20M']);

  router.sent = [];
  await setDeviceLimits(ctx, "10.0.0.7", { upload: "5M" });
  expect(writes()[0]).toContain("max-limit=5M/10M");

  // The dashboard sends an empty string for "no limit": that still removes the limit.
  router.sent = [];
  await setDeviceLimits(ctx, "10.0.0.7", { download: "", upload: "" });
  expect(writes()[0]).toContain("max-limit=0/0");
});

test("a rate limit call that gives nothing, or cannot read the queue, writes nothing", async () => {
  const none = await setDeviceLimits(ctx, "10.0.0.7", {});
  expect(none.message).toContain("not changed");
  expect(writes()).toEqual([]);

  router.detail = "";
  const unread = await setDeviceLimits(ctx, "10.0.0.7", { download: "20M" });
  expect(unread.ok).toBe(false);
  expect(unread.message).toContain("nothing was changed");
  expect(writes()).toEqual([]);
});

test("a new queue has no limit to keep: the side that is not given is unlimited", async () => {
  router.queues = 0;
  await setDeviceLimits(ctx, "10.0.0.7", { download: "20M" });
  expect(writes()[0]).toContain("/queue simple add");
  expect(writes()[0]).toContain("max-limit=0/20M");
});

test("naming a household device keeps its person unless one is given", async () => {
  const tool = homeInternetTools.find((entry) => entry.name === "name_home_device")!;
  const run = (args: Record<string, unknown>) =>
    tool.handler({ mac: "AA:BB:CC:DD:EE:FF", ...args } as never, ctx);

  await run({ name: "Sara's phone" });
  expect(home.saved.at(-1)).toMatchObject({ name: "Sara's phone", person: "Sara" });

  await run({ name: "Phone", person: "Ali" });
  expect(home.saved.at(-1)).toMatchObject({ person: "Ali" });

  await run({ name: "Phone", person: "" });
  expect(home.saved.at(-1)).toMatchObject({ person: "" });
});
