import { expect, test } from "bun:test";
import { serve } from "bun";
import { dashboardSocketLifecycle } from "../src/observability/websocket-lifecycle";

test("Bun routes handler failures to the affected socket and releases its subscription", async () => {
  let releases = 0;
  const server = serve<{ unsub?: () => void }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      if (
        server.upgrade(req, {
          data: {
            unsub: () => {
              releases++;
            },
          },
        })
      )
        return;
      return new Response("Upgrade required", { status: 426 });
    },
    websocket: {
      ...dashboardSocketLifecycle,
      message() {
        throw new Error("simulated handler failure");
      },
    },
  });
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
  try {
    const code = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WebSocket close timed out")), 2000);
      ws.onopen = () => ws.send("test");
      ws.onclose = (event) => {
        clearTimeout(timer);
        resolve(event.code);
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("WebSocket failed"));
      };
    });
    expect(code).toBe(1011);
    expect(releases).toBe(1);
  } finally {
    ws.close();
    await server.stop(true);
  }
});
