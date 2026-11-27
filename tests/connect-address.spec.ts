import { afterEach, expect, test, vi } from "vite-plus/test";
import { ADDRESS_HEAD_START_MS, connectAddress } from "../src/core/connect-address";

afterEach(() => vi.useRealTimers());

test("an immediate refusal starts the next address without waiting and cancels the stagger", async () => {
  vi.useFakeTimers();
  const connect = vi.fn(async (host: string) => {
    if (host === "first") throw new Error("refused");
    return host;
  });
  const attempt = vi.fn();
  await expect(
    connectAddress(["first", "second", "third"], 22, connect, () => false, attempt),
  ).resolves.toEqual({ host: "second", value: "second" });
  expect(attempt.mock.calls).toEqual([["first", "refused"], ["second"]]);
  expect(connect).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

test("a terminal authentication error cancels outstanding handshakes and pending addresses", async () => {
  vi.useFakeTimers();
  const aborted = vi.fn();
  const attempt = vi.fn();
  const result = connectAddress(
    ["slow", "denied", "unused"],
    22,
    async (host, signal) => {
      if (host === "slow") {
        return new Promise<void>((_, reject) =>
          signal.addEventListener("abort", () => {
            aborted(host);
            reject(signal.reason);
          }),
        );
      }
      throw new Error("authentication failed");
    },
    (error) => error.includes("authentication"),
    attempt,
  );
  const check = expect(result).rejects.toThrow("denied:22: authentication failed");
  await vi.advanceTimersByTimeAsync(ADDRESS_HEAD_START_MS);
  await check;
  expect(aborted).toHaveBeenCalledWith("slow");
  expect(attempt.mock.calls).toEqual([["denied", "authentication failed"]]);
  expect(vi.getTimerCount()).toBe(0);
});
