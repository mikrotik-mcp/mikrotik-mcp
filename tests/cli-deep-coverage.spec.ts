import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  setConfig: vi.fn(),
  connect: vi.fn(),
  run: vi.fn(),
  disconnect: vi.fn(),
  describe: vi.fn((d: { host?: string; mac?: string }) => d.mac ?? d.host ?? "unknown"),
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  banner: vi.fn(),
  stdio: vi.fn(),
  http: vi.fn(),
  dashboard: vi.fn(),
  routingStart: vi.fn(),
  routingStop: vi.fn(),
  flightStart: vi.fn(),
  flightStop: vi.fn(),
  poolClose: vi.fn(),
  memoryClose: vi.fn(),
  schedulerStart: vi.fn(),
  schedulerStop: vi.fn(),
  attackStart: vi.fn(),
  attackStop: vi.fn(),
  samplerStart: vi.fn(),
  samplerStop: vi.fn(),
  parseRules: vi.fn(),
  setEngine: vi.fn(),
  exists: vi.fn(),
}));

vi.mock("../src/config", () => ({ loadConfig: mocks.config }));
vi.mock("../src/core/runtime", () => ({ setConfig: mocks.setConfig }));
vi.mock("../src/core/transport", () => ({
  createDeviceClient: () => ({
    connect: mocks.connect,
    run: mocks.run,
    disconnect: mocks.disconnect,
    get lastError() {
      return "offline";
    },
  }),
  describeTransport: mocks.describe,
}));
vi.mock("../src/logger", () => ({
  logger: { info: mocks.info, error: mocks.error, warn: mocks.warn },
}));
vi.mock("../src/cli-logo", () => ({ printBanner: mocks.banner }));
vi.mock("../src/transport/stdio", () => ({ runStdio: mocks.stdio }));
vi.mock("../src/transport/http", () => ({ runHttp: mocks.http }));
vi.mock("../src/observability/dashboard", () => ({ runDashboard: mocks.dashboard }));
vi.mock("../src/service-routing/service", () => ({
  startRoutingMonitor: mocks.routingStart,
  stopRoutingMonitor: mocks.routingStop,
}));
vi.mock("../src/flight-recorder/service", () => ({
  startFlightRecorder: mocks.flightStart,
  stopFlightRecorder: mocks.flightStop,
}));
vi.mock("../src/core/connection-pool", () => ({ closeAll: mocks.poolClose }));
vi.mock("../src/memory/accessor", () => ({ closeMemoryStore: mocks.memoryClose }));
vi.mock("../src/schedule/session", () => ({
  startScheduler: mocks.schedulerStart,
  stopScheduler: mocks.schedulerStop,
}));
vi.mock("../src/attack/session", () => ({
  startAttackDetection: mocks.attackStart,
  stopAttackDetection: mocks.attackStop,
}));
vi.mock("../src/alerts/sampler", () => ({
  startAlertSampler: mocks.samplerStart,
  stopAlertSampler: mocks.samplerStop,
}));
vi.mock("../src/alerts/model", () => ({ parseRules: mocks.parseRules }));
vi.mock("../src/alerts/engine", () => ({
  AlertEngine: class {
    constructor(public options: unknown) {}
  },
  setAlertEngine: mocks.setEngine,
}));
vi.mock("../src/tools", () => ({
  allToolModules: [
    [
      { name: "read", title: "Read", annotations: { readOnlyHint: true } },
      { name: "remove", title: "Remove", annotations: { destructiveHint: true } },
      { name: "write", title: "Write", annotations: {} },
    ],
  ],
}));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  existsSync: (path: string) => (path === "/.dockerenv" ? mocks.exists() : false),
}));

const device = (extra: Record<string, unknown> = {}) => ({
  host: "192.0.2.1",
  username: "admin",
  password: "secret",
  ...extra,
});
const config = (extra: Record<string, unknown> = {}) => ({
  devices: { lab: device() },
  defaultDevice: "lab",
  mcp: { transport: "stdio" },
  ssh: { keepAlive: true },
  dashboard: { enabled: false, dbPath: ":memory:" },
  ...extra,
});
let output: string[];
let argv: string[];
let title: string;
let exitSpy: ReturnType<typeof vi.spyOn>;

async function invoke(...args: string[]): Promise<void> {
  process.argv = ["bun", "cli.ts", ...args];
  vi.resetModules();
  await import("../src/cli");
  // main is invoked without an exported promise; flush its awaited mocks.
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  output = [];
  argv = process.argv;
  title = process.title;
  mocks.config.mockReturnValue(config());
  mocks.connect.mockResolvedValue(true);
  mocks.run.mockResolvedValue("  name: lab  ");
  mocks.banner.mockResolvedValue(undefined);
  mocks.stdio.mockResolvedValue(undefined);
  mocks.http.mockResolvedValue(undefined);
  mocks.dashboard.mockResolvedValue(undefined);
  mocks.schedulerStart.mockResolvedValue(undefined);
  mocks.parseRules.mockReturnValue(["rule"]);
  mocks.exists.mockReturnValue(false);
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
});
afterEach(() => {
  process.argv = argv;
  process.title = title;
  delete process.env.MIKROTIK_RESTART_DELAY_MS;
  vi.restoreAllMocks();
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
});

test("help and version flags take priority without loading config or starting transport", async () => {
  await invoke("devices", "--help");
  expect(output.join("")).toContain("CONNECTION OPTIONS");
  expect(mocks.config).not.toHaveBeenCalled();
  output = [];
  await invoke("--version", "devices");
  expect(output.join("")).toMatch(/^\d+\.\d+\.\d+/);
  expect(mocks.config).not.toHaveBeenCalled();
  expect(mocks.stdio).not.toHaveBeenCalled();
});

test("tools reports each risk and the actual catalog count", async () => {
  await invoke("tools");
  expect(output.join("")).toMatch(/READ\s+read\s+Read/);
  expect(output.join("")).toMatch(/DESTRUCTIVE\s+remove\s+Remove/);
  expect(output.join("")).toMatch(/WRITE\s+write\s+Write/);
  expect(output.join("")).toContain("3 tools across 1 modules");
  expect(mocks.config).not.toHaveBeenCalled();
});

test("devices renders default, descriptions and every authentication mode", async () => {
  mocks.config.mockReturnValue(
    config({
      devices: {
        lab: device({ description: "Main" }),
        key: device({ password: undefined, keyFilename: "/tmp/key" }),
        inline: device({ password: undefined, privateKey: "pem" }),
        mac: device({ mac: "AA:BB:CC:DD:EE:FF" }),
        empty: device({ password: undefined }),
      },
    }),
  );
  await invoke("devices");
  const text = output.join("");
  expect(text).toContain("lab (default)\tadmin@192.0.2.1 [auth: password] — Main");
  expect(text).toContain("key\tadmin@192.0.2.1 [auth: key]");
  expect(text).toContain("inline\tadmin@192.0.2.1 [auth: key]");
  expect(text).toContain("mac\tadmin@AA:BB:CC:DD:EE:FF [auth: mac-telnet]");
  expect(text).toContain("empty\tadmin@192.0.2.1 [auth: none]");
  expect(text).toContain("5 device(s)");
  expect(mocks.connect).not.toHaveBeenCalled();
});

test("auth-check probes every configured device, trims identity and exits successfully", async () => {
  mocks.config.mockReturnValue(
    config({ devices: { lab: device(), key: device({ keyFilename: "key" }) } }),
  );
  await invoke("auth-check");
  expect(mocks.connect).toHaveBeenCalledTimes(2);
  expect(mocks.run).toHaveBeenCalledTimes(2);
  expect(mocks.run).toHaveBeenCalledWith("/system identity print");
  expect(mocks.disconnect).toHaveBeenCalledTimes(2);
  expect(output.join("")).toContain("[lab] Connection OK.\nname: lab");
  expect(output.join("")).toContain("2 device(s) checked");
  expect(exitSpy).toHaveBeenCalledWith(0);
  expect(mocks.stdio).toHaveBeenCalledTimes(1);
});

test("auth-check continues after a failed connection and reports failure", async () => {
  mocks.config.mockReturnValue(
    config({ devices: { lab: device(), key: device({ mac: "AA:BB:CC:DD:EE:FF" }) } }),
  );
  mocks.connect.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  await invoke("auth-check");
  expect(mocks.connect).toHaveBeenCalledTimes(2);
  expect(mocks.run).toHaveBeenCalledTimes(1);
  expect(mocks.disconnect).toHaveBeenCalledTimes(1);
  expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining("Connection FAILED. offline"));
  expect(mocks.info).toHaveBeenCalledWith(expect.stringContaining("auth: mac-telnet"));
  expect(exitSpy).toHaveBeenCalledWith(1);
});

test("default serve initializes stdio before dashboard and installs shutdown cleanup", async () => {
  mocks.config.mockReturnValue(config({ dashboard: { enabled: true, dbPath: ":memory:" } }));
  await invoke();
  expect(mocks.setConfig).toHaveBeenCalledWith(expect.objectContaining({ defaultDevice: "lab" }));
  expect(mocks.routingStart).toHaveBeenCalledTimes(1);
  expect(mocks.flightStart).toHaveBeenCalledTimes(1);
  expect(mocks.banner).toHaveBeenCalledTimes(1);
  expect(mocks.stdio).toHaveBeenCalledTimes(1);
  expect(mocks.dashboard).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }), "stdio");
  expect(mocks.http).not.toHaveBeenCalled();
  expect(mocks.info).toHaveBeenCalledWith(expect.stringContaining("ssh-pool=on"));
  expect(process.listenerCount("SIGINT")).toBeGreaterThan(0);
  process.emit("SIGINT");
  expect(mocks.poolClose).toHaveBeenCalledTimes(1);
  expect(mocks.memoryClose).toHaveBeenCalledTimes(1);
  expect(mocks.routingStop).toHaveBeenCalledTimes(1);
  expect(mocks.flightStop).toHaveBeenCalledTimes(1);
  expect(mocks.schedulerStop).toHaveBeenCalledTimes(1);
  expect(mocks.attackStop).toHaveBeenCalledTimes(1);
  expect(mocks.samplerStop).toHaveBeenCalledTimes(1);
  expect(exitSpy).toHaveBeenCalledWith(0);
});

test("HTTP serve starts optional alerting, logs recoverable failures and never starts a real server", async () => {
  mocks.config.mockReturnValue(
    config({
      mcp: { transport: "streamable-http" },
      ssh: { keepAlive: false },
      alerts: { rules: ["one"], channels: [], maxHistory: 20 },
      dashboard: { enabled: true, dbPath: ":memory:" },
    }),
  );
  mocks.dashboard.mockRejectedValue(new Error("port busy"));
  mocks.attackStart.mockImplementation(() => {
    throw new Error("bad attack config");
  });
  await invoke("serve");
  expect(mocks.parseRules).toHaveBeenCalledWith(["one"]);
  expect(mocks.setEngine).toHaveBeenCalledTimes(1);
  expect(mocks.samplerStart).toHaveBeenCalledTimes(1);
  expect(mocks.error).toHaveBeenCalledWith(
    expect.stringContaining("Attack detection disabled: bad attack config"),
  );
  expect(mocks.error).toHaveBeenCalledWith(
    expect.stringContaining("Failed to start observability dashboard: port busy"),
  );
  expect(mocks.http).toHaveBeenCalledWith({ transport: "streamable-http" });
  expect(mocks.stdio).not.toHaveBeenCalled();
  expect(mocks.info).toHaveBeenCalledWith(expect.stringContaining("ssh-pool=off"));
});

test("invalid alert rules are logged and serving continues; disabled rules are skipped", async () => {
  mocks.config.mockReturnValue(config({ alerts: { rules: ["bad"], channels: [] } }));
  mocks.parseRules.mockImplementation(() => {
    throw new Error("invalid rule");
  });
  await invoke("serve");
  expect(mocks.error).toHaveBeenCalledWith("Alerting disabled — invalid rules: invalid rule");
  expect(mocks.setEngine).not.toHaveBeenCalled();
  expect(mocks.stdio).toHaveBeenCalledTimes(1);
  mocks.parseRules.mockClear();
  mocks.config.mockReturnValue(config({ alerts: { enabled: false, rules: ["bad"] } }));
  await invoke("serve");
  expect(mocks.parseRules).not.toHaveBeenCalled();
});

test("container password warning and scheduler rejection are surfaced", async () => {
  mocks.exists.mockReturnValue(true);
  mocks.schedulerStart.mockRejectedValue(new Error("schedule invalid"));
  await invoke("serve");
  expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining("plaintext password"));
  expect(mocks.error).toHaveBeenCalledWith("Scheduled audits disabled: schedule invalid");
});
