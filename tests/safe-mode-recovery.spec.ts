/**
 * End-to-end recovery of a failed Safe Mode session, against a fake router.
 *
 * Regression for the incident where one stalled command left a device's Safe
 * Mode session "uncertain": every later tool on that device failed (reads
 * included) until the MCP server was restarted. Nothing here opens a network
 * connection — the SSH shell, the one-shot client and the snapshot store are
 * all replaced by fakes.
 *
 * The real `SafeModeManager`, connector routing and `apply_plan` handler run
 * unmodified, so these tests cover the path a client actually takes.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { EventEmitter } from "node:events";
import { MikrotikConfigSchema } from "../src/config";
import { executeMikrotikCommand } from "../src/core/connector";
import { createContext } from "../src/core/context";
import type { ToolContext } from "../src/core/context";
import { getConfig, setConfig } from "../src/core/runtime";
import { getSafeModeManager } from "../src/ssh/safe-mode";
import { changePlanTools } from "../src/tools/change-plan";

type Hang = "none" | "step" | "commit-taken" | "commit-lost";

/** A router with a running config, a one-shot connection, and a Safe Mode shell. */
class FakeRouter {
  config = [
    "/ip firewall filter add chain=input comment=ci dst-address=192.168.100.8 dst-port=8080",
    "/ip firewall filter add chain=input action=drop",
  ];
  hang: Hang = "none";
  /** Everything typed into the interactive Safe Mode shell. */
  shellWrites: string[] = [];
  /** Every command run on a separate one-shot connection. */
  oneShots: string[] = [];
  channel: (EventEmitter & { write(input: string): void; end(): void }) | null = null;
  /** Config at Safe Mode entry; non-null while Safe Mode holds changes. */
  private held: string[] | null = null;
  private dead = false;

  oneShot(command: string): string {
    this.oneShots.push(command);
    if (command === "/export terse") return this.config.join("\n");
    if (/\sprint(\s|$)/.test(command)) return "name: fake";
    return this.apply(command);
  }

  private apply(command: string): string {
    if (command.includes("!dst-address")) {
      this.config = this.config.map((line) =>
        line.includes("comment=ci") ? line.replace(" dst-address=192.168.100.8", "") : line,
      );
    } else {
      this.config.push(command);
    }
    return "";
  }

  openShell(): NonNullable<FakeRouter["channel"]> {
    this.dead = false;
    const channel = Object.assign(new EventEmitter(), {
      write: (input: string) => {
        this.shellWrites.push(input);
        setTimeout(() => this.onInput(input), 0);
      },
      // Closing the session is what makes RouterOS revert uncommitted changes.
      end: () => {
        if (this.held) this.config = this.held;
        this.held = null;
        channel.emit("close");
      },
    });
    this.channel = channel;
    setTimeout(() => channel.emit("data", Buffer.from("[admin@fake] > ")), 0);
    return channel;
  }

  private onInput(input: string): void {
    const say = (text: string): void => void this.channel?.emit("data", Buffer.from(text));
    const prompt = (): string => (this.held ? "[admin@fake] <SAFE> " : "[admin@fake] > ");
    if (input === "\x18") {
      if (!this.held) {
        this.held = [...this.config]; // enter Safe Mode
        say(prompt());
        return;
      }
      if (this.hang === "commit-lost") {
        this.dead = true; // keystroke never processed; shell stops answering
        return;
      }
      this.held = null; // committed
      if (this.hang === "commit-taken") this.dead = true; // …but no confirmation arrives
      return;
    }
    if (this.dead) return;
    const command = input.replace(/\r$/, "");
    const probe = command.match(/^:put "(.*)"$/);
    if (probe) {
      say(`${command}\r\n${probe[1]}\r\n${prompt()}`);
      return;
    }
    if (this.hang === "step") {
      this.apply(command); // executed, then the shell goes silent
      this.dead = true;
      return;
    }
    say(`${command}\r\n${this.apply(command)}\r\n${prompt()}`);
  }
}

const routers = vi.hoisted(() => new Map<string, unknown>());
const snapshot = vi.hoisted(() => vi.fn());
const router = (host: string): FakeRouter => routers.get(host) as FakeRouter;

vi.mock("../src/ssh/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ssh/client")>()),
  MikroTikSSHClient: class {
    constructor(private readonly options: { host: string }) {}
    connect = async (): Promise<boolean> => true;
    shell = async (): Promise<unknown> => router(this.options.host).openShell();
    disconnect(): void {}
  },
}));
vi.mock("../src/core/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/transport")>()),
  createDeviceClient: (dc: { host: string }) => ({
    connect: async () => true,
    run: async (command: string) => router(dc.host).oneShot(command),
    disconnect() {},
  }),
}));
vi.mock("../src/core/connection-pool", () => ({ isPoolEnabled: () => false, runPooled: vi.fn() }));
vi.mock("../src/snapshots/capture", () => ({ captureSnapshot: snapshot }));

const UNSET = "/ip firewall filter set [find comment=ci] !dst-address";
const applyPlan = changePlanTools.find((tool) => tool.name === "apply_plan")!;

function ctxFor(device: string, risk: ToolContext["risk"]): ToolContext {
  const ctx = createContext(undefined, device);
  ctx.risk = risk;
  return ctx;
}

/** Let every pending timer run (prompt replies, idle timeouts, settle delay). */
async function settle<T>(work: Promise<T>): Promise<T> {
  const outcome = work.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.advanceTimersByTimeAsync(400_000);
  const result = await outcome;
  if ("error" in result) throw result.error;
  return result.value;
}

const apply = (args: Record<string, unknown>): Promise<string> =>
  Promise.resolve(applyPlan.handler(args as never, ctxFor("home", "DANGEROUS"))).then(String);

let original: ReturnType<typeof getConfig>;
let home: FakeRouter;
let other: FakeRouter;
beforeEach(() => {
  vi.useFakeTimers();
  original = getConfig();
  home = new FakeRouter();
  other = new FakeRouter();
  routers.set("home.invalid", home);
  routers.set("other.invalid", other);
  snapshot.mockReset().mockResolvedValue("snap_test");
  setConfig(
    MikrotikConfigSchema.parse({
      devices: {
        home: { host: "home.invalid", username: "test" },
        other: { host: "other.invalid", username: "test" },
      },
      defaultDevice: "home",
    }),
  );
});
afterEach(async () => {
  await getSafeModeManager("home").rollback();
  setConfig(original);
  vi.useRealTimers();
});

describe("timeout during a step", () => {
  test("reads and other devices keep working while the step hangs", async () => {
    home.hang = "step";
    const pending = apply({ commands: [UNSET], confirm: true }).catch(String);
    await vi.advanceTimersByTimeAsync(1_000); // session open, step sent, no reply
    expect(getSafeModeManager("home").isActive).toBe(true);

    // A READ tool on the same device: separate connection, not the stuck shell.
    expect(await executeMikrotikCommand("/system identity print", ctxFor("home", "READ"))).toBe(
      "name: fake",
    );
    // A background sampler (no risk) reading counters: same.
    await executeMikrotikCommand("/queue simple print stats detail", ctxFor("home", undefined));
    expect(home.shellWrites.join("")).not.toContain("print");

    // A write on ANOTHER device is not affected at all.
    const write = "/ip address add address=10.0.0.1/24 interface=lo";
    await executeMikrotikCommand(write, ctxFor("other", "WRITE"));
    expect(other.oneShots).toContain(write);
    expect(getSafeModeManager("other").isActive).toBe(false);

    await vi.advanceTimersByTimeAsync(400_000);
    expect(await pending).toContain("did not return a recognized prompt");
  });

  test("recovers by itself, reports the real state, and the next write works", async () => {
    const before = [...home.config];
    home.hang = "step";
    const error = await settle(apply({ commands: [UNSET], confirm: true })).catch(String);

    expect(error).toContain("Safe Mode session was closed");
    // The step DID run on the router, then RouterOS reverted it on close — the
    // read-back proves which, instead of leaving the outcome unknown.
    expect(error).toContain("identical to the pre-change export");
    expect(home.config).toEqual(before);
    expect(error).not.toMatch(/rollback_safe_mode|commit_safe_mode|safe_mode_status/);

    const manager = getSafeModeManager("home");
    expect(manager.isActive).toBe(false);
    expect(manager.requiresRecovery).toBe(false);
    expect(manager.status()).toContain("closed automatically");

    // No restart: the same process applies the same plan successfully.
    home.hang = "none";
    const result = await settle(apply({ commands: [UNSET], confirm: true }));
    expect(result).toContain("COMMITTED: changes are now permanent");
    expect(home.config[0]).not.toContain("dst-address");
    expect(manager.isActive).toBe(false);
  });
});

describe("timeout during commit", () => {
  test("commit took but its confirmation was lost: verified as applied", async () => {
    home.hang = "commit-taken";
    const result = await settle(apply({ commands: [UNSET], confirm: true }));
    expect(result).toContain("COMMITTED: the commit confirmation was lost");
    expect(result).toContain("the change IS on the device");
    expect(home.config[0]).not.toContain("dst-address");

    const manager = getSafeModeManager("home");
    expect(manager.isActive).toBe(false);
    expect(manager.requiresRecovery).toBe(false);
  });

  test("commit never took: reported as reverted, then reads and writes work", async () => {
    const before = [...home.config];
    home.hang = "commit-lost";
    const error = await settle(apply({ commands: [UNSET], confirm: true })).catch(String);
    expect(error).toContain("COMMIT FAILED");
    expect(error).toContain("identical to the pre-change export");
    expect(home.config).toEqual(before);

    // Reads and writes on the device work straight away — no restart.
    home.hang = "none";
    expect(await executeMikrotikCommand("/system identity print", ctxFor("home", "READ"))).toBe(
      "name: fake",
    );
    const write = "/ip address add address=10.0.0.2/24 interface=lo";
    await executeMikrotikCommand(write, ctxFor("home", "WRITE"));
    expect(home.oneShots).toContain(write);
    const result = await settle(apply({ commands: [UNSET], confirm: true }));
    expect(result).toContain("COMMITTED");
  });
});

describe("session dropped while idle", () => {
  test("reads are never blocked; the next write is told once, then writes work", async () => {
    const manager = getSafeModeManager("home");
    expect(await settle(manager.enable())).toContain("ENABLED");
    home.channel!.emit("close"); // the shell died on its own
    expect(manager.isActive).toBe(false);
    expect(manager.requiresRecovery).toBe(true);

    expect(await executeMikrotikCommand("/system identity print", ctxFor("home", "READ"))).toBe(
      "name: fake",
    );
    const write = "/ip address add address=10.0.0.3/24 interface=lo";
    await expect(executeMikrotikCommand(write, ctxFor("home", "WRITE"))).rejects.toThrow(
      "NOT sent",
    );
    expect(home.oneShots).not.toContain(write);
    await executeMikrotikCommand(write, ctxFor("home", "WRITE"));
    expect(home.oneShots).toContain(write);
  });
});

describe("direct write without Safe Mode", () => {
  test("use_safe_mode=false snapshots, writes on a normal connection, and reads back", async () => {
    const result = await settle(apply({ commands: [UNSET], confirm: true, use_safe_mode: false }));
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(home.shellWrites).toEqual([]); // no Safe Mode shell at all
    expect(home.oneShots).toContain(UNSET);
    expect(home.config[0]).not.toContain("dst-address");
    expect(result).toContain("Restore point: snapshot snap_test");
    expect(result).toContain("differs from the pre-change export (+1/-1)");
    expect(result).toContain("APPLIED");
  });
});
