/// <reference types="node" />
import process from "node:process";
import { notifyStrict } from "../raycast/src/lib/notify";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  bandwidthNotificationNamespace,
  pollBandwidthNotifications,
} from "../raycast/src/lib/bandwidth-notifications";
import type { CompletionPage } from "../raycast/src/lib/bandwidth-notifications";
import type { BandwidthRun } from "../src/bandwidth/types";

const native = vi.hoisted(() => ({
  prepare: vi.fn(async () => []),
  dispatch: vi.fn(async () => ({})),
}));
vi.mock("../raycast/node_modules/raycast-notifier", () => ({
  preparePrebuilds: native.prepare,
  notificationCenter: native.dispatch,
}));

function fixture() {
  const store = new Map<string, string>();
  let storeId = "one";
  const events = [1, 2, 3].map((sequence) => ({
    sequence,
    run: {
      id: `run-${sequence}`,
      job: { name: "Tunnel", source: "a", destination: "b" },
      startedAt: 4 - sequence,
      status: sequence === 2 ? "failed" : sequence === 3 ? "interrupted" : "ok",
      trigger: "schedule",
      txBps: 1000000,
      rxBps: null,
      message: "result",
    } as BandwidthRun,
  }));
  const deps = {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: string) => {
      store.set(key, value);
    },
    fetch: vi.fn(async (after: number, limit: number): Promise<CompletionPage> => ({
      storeId,
      events: events.filter((e) => e.sequence > after).slice(0, limit),
      nextCursor: 3,
      hasMore: false,
    })),
    notify: vi.fn(async (_title: string, _message: string, _group: string) => {}),
  };
  return {
    deps,
    store,
    reset: () => {
      storeId = "two";
    },
  };
}

describe("bandwidth native completion consumption", () => {
  it("replays initial backlog in completion order including failed/interrupted scheduled runs; does not repeat", async () => {
    const { deps } = fixture();
    expect((await pollBandwidthNotifications("test", deps)).dispatched).toBe(3);
    expect(deps.notify.mock.calls.map((c) => c[0])).toEqual([
      "Bandwidth test ok: Tunnel",
      "Bandwidth test failed: Tunnel",
      "Bandwidth test interrupted: Tunnel",
    ]);
    expect(deps.notify.mock.calls[0][1]).toContain("schedule");
    expect((await pollBandwidthNotifications("test", deps)).dispatched).toBe(0);
  });
  it("retries a failed dispatch without skipping, with a stable group", async () => {
    const { deps, store } = fixture();
    deps.notify.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("denied"));
    await expect(pollBandwidthNotifications("test", deps)).rejects.toThrow("denied");
    expect(store.get("test:one:cursor")).toBe("1");
    const group = deps.notify.mock.calls[1][2];
    await pollBandwidthNotifications("test", deps);
    expect(deps.notify.mock.calls[2][2]).toBe(group);
    expect(store.get("test:one:cursor")).toBe("3");
  });
  it("replays a reset store from zero and namespaces dashboards without plaintext credentials", async () => {
    const { deps, reset } = fixture();
    await pollBandwidthNotifications("test", deps);
    reset();
    expect((await pollBandwidthNotifications("test", deps)).dispatched).toBe(3);
    const key = bandwidthNotificationNamespace("https://secret@example.test");
    expect(key).not.toContain("secret");
    expect(key).not.toBe(bandwidthNotificationNamespace("https://other.test"));
  });
  it("rejects oversized or invalid pages before dispatch", async () => {
    const { deps } = fixture();
    const page = await deps.fetch(0, 50);
    deps.fetch.mockResolvedValue({
      ...page,
      events: Array.from({ length: 51 }, (_, i) => ({
        sequence: i + 1,
        run: { ...page.events[0].run, id: String(i) },
      })),
    });
    await expect(pollBandwidthNotifications("test", deps)).rejects.toThrow(
      "Invalid completion page cursor",
    );
    expect(deps.notify).not.toHaveBeenCalled();
  });
  it("propagates native dispatch failures and retries failed prebuild preparation", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    try {
      native.prepare.mockRejectedValueOnce(new Error("prebuild missing"));
      await expect(notifyStrict("test", "test", "group")).rejects.toThrow("prebuild missing");
      native.dispatch.mockRejectedValueOnce(new Error("permission denied"));
      await expect(notifyStrict("test", "test", "group")).rejects.toThrow("permission denied");
      expect(native.prepare).toHaveBeenCalledTimes(2);
      expect(native.dispatch).toHaveBeenCalledWith({
        title: "test",
        message: "test",
        timeout: false,
        group: "group",
      });
      native.dispatch.mockClear();
    } finally {
      platform.mockRestore();
    }
  });
  it("rejects unsupported platforms without calling the native notifier", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    try {
      await expect(notifyStrict("test", "test")).rejects.toThrow("macOS");
      expect(native.dispatch).not.toHaveBeenCalled();
    } finally {
      platform.mockRestore();
    }
  });
});

it("advances past an access-filtered empty page without starving permitted completions", async () => {
  const { deps, store } = fixture();
  const original = await deps.fetch(0, 50);
  deps.fetch.mockImplementation(async (after) =>
    after < 50
      ? { storeId: "one", events: [], nextCursor: 50, hasMore: true }
      : {
          storeId: "one",
          events: [{ ...original.events[0], sequence: 51 }],
          nextCursor: 51,
          hasMore: false,
        },
  );
  expect(await pollBandwidthNotifications("test", deps)).toEqual({ dispatched: 0, hasMore: true });
  expect(store.get("test:one:cursor")).toBe("50");
  expect((await pollBandwidthNotifications("test", deps)).dispatched).toBe(1);
  expect(store.get("test:one:cursor")).toBe("51");
});
