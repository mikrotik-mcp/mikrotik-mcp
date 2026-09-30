/**
 * Unit tests for the Config Studio safe-apply state machine. All I/O is faked —
 * no real filesystem, clock, or timers.
 */
import { describe, expect, test } from "vite-plus/test";
import { MikrotikConfigSchema } from "../../src/config";
import type { ConfigSource, MikrotikConfig } from "../../src/config";
import { createConfigAdmin, validateConfig } from "../../src/observability/config-admin";
import type { AdminDeps } from "../../src/observability/config-admin";

const cfg = (over: Record<string, unknown>): MikrotikConfig => MikrotikConfigSchema.parse(over);

/** A fake environment: in-memory files, a swappable config, and a manual timer. */
function harness(initial: MikrotikConfig, source: ConfigSource) {
  const files = new Map<string, string>();
  let current = initial;
  let pendingTimer: { fn: () => void; cancelled: boolean } | null = null;
  const deps: AdminDeps = {
    getConfig: () => current,
    setConfig: (c) => {
      current = c;
    },
    source: () => source,
    readFile: (p) => files.get(p) ?? null,
    writeText: (p, t) => void files.set(p, t),
    now: () => 1000,
    schedule: (fn) => {
      pendingTimer = { fn, cancelled: false };
      return pendingTimer;
    },
    cancel: (h) => {
      if (h) (h as { cancelled: boolean }).cancelled = true;
    },
  };
  return {
    deps,
    files,
    config: () => current,
    fireTimer: () => {
      if (pendingTimer && !pendingTimer.cancelled) pendingTimer.fn();
    },
    timerCancelled: () => pendingTimer?.cancelled ?? true,
  };
}

const SRC: ConfigSource = { path: "/cfg.json", fromFile: true };
const A = cfg({ defaultDevice: "a", devices: { a: { host: "1.1.1.1" } } });
const B = cfg({ defaultDevice: "b", devices: { b: { host: "2.2.2.2" } } });

describe("validateConfig", () => {
  test("accepts a config the schema accepts (defaults applied)", () => {
    const r = validateConfig({ devices: { a: { host: "1.1.1.1" } }, defaultDevice: "a" });
    expect(r.ok).toBe(true);
    expect(r.value?.defaultDevice).toBe("a");
  });

  test("rejects an invalid value with a dotted path", () => {
    const r = validateConfig({ mcp: { transport: "bogus" } });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.path.includes("transport"))).toBe(true);
  });
});

describe("createConfigAdmin", () => {
  test("applyConfig backs up the old file, writes the new one, and hot-swaps", () => {
    const h = harness(A, SRC);
    h.files.set("/cfg.json", "OLD FILE CONTENTS");
    const admin = createConfigAdmin(h.deps);

    const res = admin.applyConfig(B, 30_000);

    expect(res.pendingId).toBe("cfg_1000");
    expect(h.files.get("/cfg.json.bak-1000")).toBe("OLD FILE CONTENTS"); // backup of prior file
    expect(h.files.get("/cfg.json")).toContain('"defaultDevice": "b"'); // new config written
    expect(h.config().defaultDevice).toBe("b"); // hot-swapped in memory
    expect(admin.pendingId()).toBe("cfg_1000");
  });

  test("keepConfig confirms the change and cancels the rollback timer", () => {
    const h = harness(A, SRC);
    const admin = createConfigAdmin(h.deps);
    const { pendingId } = admin.applyConfig(B, 30_000);

    expect(admin.keepConfig(pendingId)).toBe(true);
    expect(admin.pendingId()).toBeNull();
    expect(h.timerCancelled()).toBe(true);
    // Firing a cancelled timer is a no-op: config stays B.
    h.fireTimer();
    expect(h.config().defaultDevice).toBe("b");
  });

  test("rollback restores the previous in-memory config and the backup file", () => {
    const h = harness(A, SRC);
    h.files.set("/cfg.json", "ORIGINAL");
    const admin = createConfigAdmin(h.deps);
    const { pendingId } = admin.applyConfig(B, 30_000);

    expect(admin.rollback(pendingId)).toBe(true);
    expect(h.config().defaultDevice).toBe("a"); // reverted in memory
    expect(h.files.get("/cfg.json")).toBe("ORIGINAL"); // backup restored to disk
    expect(admin.pendingId()).toBeNull();
  });

  test("the rollback timer auto-reverts when never confirmed", () => {
    const h = harness(A, SRC);
    h.files.set("/cfg.json", "ORIGINAL");
    const admin = createConfigAdmin(h.deps);
    admin.applyConfig(B, 30_000);

    h.fireTimer(); // simulate the countdown expiring with no "keep"
    expect(h.config().defaultDevice).toBe("a");
    expect(h.files.get("/cfg.json")).toBe("ORIGINAL");
    expect(admin.pendingId()).toBeNull();
  });

  test("rollbackMs=0 applies immediately with no armed timer", () => {
    const h = harness(A, SRC);
    const admin = createConfigAdmin(h.deps);
    admin.applyConfig(B, 0);
    expect(h.config().defaultDevice).toBe("b");
    h.fireTimer(); // nothing scheduled → no-op
    expect(h.config().defaultDevice).toBe("b");
    expect(admin.pendingId()).toBeNull();
    // Immediate dashboard preferences do not leave an invisible lock behind.
    const immediate = admin.applyConfig(A, 0);
    expect(admin.rollback(immediate.pendingId)).toBe(true);
    expect(h.config().defaultDevice).toBe("b");
    admin.applyConfig(A, 30_000);
    expect(() => admin.applyConfig(B, 0)).toThrow("awaits confirmation");
  });
});
