import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../src/config";
import type { ToolContext } from "../src/core/context";
import { getConfig, setConfig } from "../src/core/runtime";
import { resolveTargets, rolloutTools } from "../src/tools/rollout";

const ctx: ToolContext = { device: "home", info: vi.fn(), error: vi.fn() };
const original = getConfig();
function tool(name: string) {
  const found = rolloutTools.find((entry) => entry.name === name);
  if (!found) throw new Error(`Unknown rollout tool ${name}`);
  return found;
}

beforeEach(() =>
  setConfig(
    MikrotikConfigSchema.parse({
      devices: {
        home: { host: "192.0.2.1", port: 22, tags: ["lab", "home"] },
        edge: { host: "192.0.2.2", port: 22, tags: ["lab"] },
        retired: { host: "192.0.2.3", port: 22, disabled: true, tags: ["lab"] },
      },
      defaultDevice: "home",
    }),
  ),
);
afterEach(() => setConfig(original));

test("explicit selection rejects unknown targets rather than silently using the default", () => {
  expect(resolveTargets(["ghost"])).toMatchObject({
    devices: [],
    error: "unknown device(s): ghost",
  });
  expect(resolveTargets(["edge", "home"]).devices).toEqual(["edge", "home"]);
});

test("selector intersects tags and exclusion while ignoring disabled routers", () => {
  expect(resolveTargets({ all: true }).devices).toEqual(["home", "edge"]);
  expect(resolveTargets({ tags: ["lab", "home"] }).devices).toEqual(["home"]);
  expect(resolveTargets({ all: true, exclude: ["edge"] }).devices).toEqual(["home"]);
  expect(resolveTargets({})).toMatchObject({
    devices: [],
    error: expect.stringContaining("selector must set"),
  });
});

test("version selector omits devices without cached capability evidence", () => {
  const result = resolveTargets({ versionBelow: "7.20" });
  expect(result.devices).toEqual([]);
  expect(result.notes.join(" ")).toContain("no cached RouterOS version");
});

test("plan previews ordered waves and normalized commands without contacting routers", async () => {
  const result = await tool("plan_rollout").handler(
    {
      commands: "# reason\n/ip dns print\n\n /system resource print",
      targets: ["edge", "home"],
      strategy: { canary: 1, soakSeconds: 5 },
      label: "read-only preview",
    },
    ctx,
  );
  expect(result).toContain("ROLLOUT PLAN — read-only preview");
  expect(result).toContain("Wave 1 (canary): 1 device(s) — edge");
  expect(result).toContain("Wave 2: 1 device(s) — home");
  expect(result).toContain("Commands applied to every device (2)");
  expect(result).toContain("Nothing has been changed");
});

test("plan and start reject empty commands or no matching devices", async () => {
  expect(await tool("plan_rollout").handler({ commands: [], targets: ["home"] }, ctx)).toBe(
    "No commands to apply.",
  );
  expect(
    await tool("plan_rollout").handler(
      { commands: ["/system resource print"], targets: { tags: ["absent"] } },
      ctx,
    ),
  ).toContain("No devices matched");
  expect(
    await tool("start_rollout").handler(
      { commands: ["/system resource print"], targets: ["ghost"], confirm: false },
      ctx,
    ),
  ).toContain("Cannot start rollout");
});

test("unconfirmed start and status/abort lookup remain local and non-mutating", async () => {
  const start = await tool("start_rollout").handler(
    { commands: ["/system resource print"], targets: ["home", "edge"], confirm: false },
    ctx,
  );
  expect(start).toContain("NOT STARTED — confirm=false");
  expect(start).toContain("Re-run with confirm=true");
  expect(await tool("rollout_status").handler({}, ctx)).toBe("No rollouts are in flight.");
  expect(await tool("rollout_status").handler({ rollout_id: "missing" }, ctx)).toContain(
    "No active rollout",
  );
  expect(await tool("abort_rollout").handler({ rollout_id: "missing" }, ctx)).toContain(
    "No active rollout",
  );
});
