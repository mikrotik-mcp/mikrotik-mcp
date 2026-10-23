import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { logger } from "../../src/logger";
import { dashboardSocketLifecycle } from "../../src/observability/websocket-lifecycle";

afterEach(() => vi.restoreAllMocks());

describe("dashboard WebSocket lifecycle", () => {
  test.each([undefined, "home"])("cleans up %s stream once after error then close", (traffic) => {
    const unsub = vi.fn();
    const ws = { data: { unsub, traffic }, close: vi.fn() };
    const log = vi.spyOn(logger, "error").mockImplementation(() => {});
    dashboardSocketLifecycle.error(new Error("token=secret"), ws);
    dashboardSocketLifecycle.close(ws);
    expect(unsub).toHaveBeenCalledTimes(1);
    expect(ws.close).toHaveBeenCalledWith(1011, "Stream interrupted");
    expect(log).toHaveBeenCalledWith(
      `Dashboard WebSocket handler failed (${traffic === undefined ? "events" : "traffic"})`,
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
  });

  test("normal close is idempotent without closing the socket again", () => {
    const unsub = vi.fn();
    const ws = { data: { unsub }, close: vi.fn() };
    dashboardSocketLifecycle.close(ws);
    dashboardSocketLifecycle.close(ws);
    expect(unsub).toHaveBeenCalledTimes(1);
    expect(ws.close).not.toHaveBeenCalled();
  });

  test("still closes a failed socket when cleanup throws", () => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    const ws = {
      data: {
        unsub: vi.fn(() => {
          throw new Error("cleanup");
        }),
      },
      close: vi.fn(),
    };
    dashboardSocketLifecycle.error(new Error("handler"), ws);
    expect(ws.close).toHaveBeenCalledWith(1011, "Stream interrupted");
    expect(ws.data.unsub).toBeUndefined();
  });
});
