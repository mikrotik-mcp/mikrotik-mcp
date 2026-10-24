import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../src/config";
import type { ToolContext } from "../src/core/context";
import { getConfig, setConfig } from "../src/core/runtime";
import { wireguardMeshTools } from "../src/tools/wireguard-mesh";

const mocks = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: mocks.command }));

const key = `${"A".repeat(43)}=`;
const ctx: ToolContext = { device: "alpha", info: vi.fn(), error: vi.fn() };
const original = getConfig();
const args = {
  devices: ["alpha", "beta"],
  address_prefix: "10.20.0.0/24",
  interface: "wg-mesh",
  listen_port: 13231,
  topology: "full-mesh",
  persistent_keepalive: "25s",
  apply: false,
};

async function call(override: Record<string, unknown> = {}) {
  return wireguardMeshTools[0].handler({ ...args, ...override } as never, ctx);
}

beforeEach(() => {
  vi.clearAllMocks();
  setConfig(
    MikrotikConfigSchema.parse({
      devices: {
        alpha: { host: "192.0.2.10", port: 22 },
        beta: { host: "192.0.2.11", port: 22 },
        gamma: { host: "192.0.2.12", port: 22 },
      },
      defaultDevice: "alpha",
    }),
  );
  mocks.command.mockImplementation(async (command: string) => {
    if (command.includes("count-only")) return "0";
    if (command.includes("print detail")) return `public-key=${key}`;
    return "";
  });
});
afterEach(() => setConfig(original));

test("dry run plans full mesh and hub-spoke links without touching a router", async () => {
  const full = await call({
    devices: ["alpha", "beta", "gamma"],
    allowed_lans: { beta: "10.2.0.0/24" },
  });
  expect(full).toContain("DRY RUN");
  expect(full).toContain("Peer links (6");
  expect(full).toContain("10.2.0.0/24");
  const star = await call({
    devices: ["alpha", "beta", "gamma"],
    topology: "hub-spoke",
    hub: "beta",
  });
  expect(star).toContain("Peer links (4");
  expect(star).toContain("beta ⇒ alpha");
  expect(mocks.command).not.toHaveBeenCalled();
});

test("unknown devices and missing hub fail before any device I/O", async () => {
  expect(await call({ devices: ["alpha", "ghost"], apply: true })).toContain(
    "Unknown device(s): ghost",
  );
  expect(await call({ topology: "hub-spoke", apply: true })).toContain("requires `hub`");
  expect(mocks.command).not.toHaveBeenCalled();
});

test("apply creates interfaces, assigns addresses, and adds directed peers", async () => {
  const result = await call({
    apply: true,
    endpoints: { beta: "beta.example.com" },
    allowed_lans: { beta: "10.2.0.0/24" },
  });
  expect(result).toContain("2 interfaces, 2 peers");
  const commands = mocks.command.mock.calls.map(([command]) => String(command));
  expect(commands.filter((command) => command.startsWith("/interface wireguard add"))).toHaveLength(
    2,
  );
  expect(commands.filter((command) => command.startsWith("/ip address add"))).toHaveLength(2);
  expect(
    commands.filter((command) => command.startsWith("/interface wireguard peers add")),
  ).toHaveLength(2);
  expect(commands.join("\n")).toContain("beta.example.com");
  expect(commands.join("\n")).toContain("10.2.0.0/24");
});

test("existing interface and address are kept instead of duplicated", async () => {
  mocks.command.mockImplementation(async (command: string) =>
    command.includes("count-only")
      ? "1"
      : command.includes("print detail")
        ? `public-key=${key}`
        : "",
  );
  expect(await call({ apply: true })).toContain("2 peers");
  expect(
    mocks.command.mock.calls
      .map(([command]) => String(command))
      .some((command) => command.startsWith("/ip address add")),
  ).toBe(false);
  expect(
    mocks.command.mock.calls
      .map(([command]) => String(command))
      .some((command) => command.startsWith("/interface wireguard add")),
  ).toBe(false);
});

test("interface creation, missing key, and peer errors halt the build", async () => {
  mocks.command
    .mockImplementationOnce(async () => "0")
    .mockImplementationOnce(async () => "failure: denied");
  expect(await call({ apply: true })).toContain("Failed to create interface on alpha");
  vi.clearAllMocks();
  mocks.command.mockImplementation(async (command: string) =>
    command.includes("count-only") ? "1" : command.includes("print detail") ? "no public key" : "",
  );
  expect(await call({ apply: true })).toContain("Could not read WireGuard public key on alpha");
  vi.clearAllMocks();
  mocks.command.mockImplementation(async (command: string) =>
    command.includes("count-only")
      ? "1"
      : command.includes("print detail")
        ? `public-key=${key}`
        : command.includes("peers add")
          ? "failure: denied"
          : "",
  );
  expect(await call({ apply: true })).toContain("FAILED adding peer alpha⇒beta (0 peers added)");
});
