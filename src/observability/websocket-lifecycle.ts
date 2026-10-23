import type { ServerWebSocket } from "bun";
import { logger } from "../logger";

type DashboardSocket = Pick<
  ServerWebSocket<{ unsub?: () => void; traffic?: string }>,
  "data" | "close"
>;

/** Release a disconnected viewer's subscriptions once, even after a handler error. */
function releaseSubscriptions(ws: DashboardSocket): void {
  const unsub = ws.data.unsub;
  delete ws.data.unsub;
  try {
    unsub?.();
  } catch {
    logger.error("Dashboard WebSocket subscription cleanup failed");
  }
}

export const dashboardSocketLifecycle = {
  /** Stop a failed stream without logging payloads, URLs or bearer tokens. */
  error(_error: Error, ws: DashboardSocket): void {
    const channel = ws.data.traffic === undefined ? "events" : "traffic";
    logger.error(`Dashboard WebSocket handler failed (${channel})`);
    releaseSubscriptions(ws);
    ws.close(1011, "Stream interrupted");
  },
  /** Release the viewer's resources when the connection closes normally. */
  close: releaseSubscriptions,
};
