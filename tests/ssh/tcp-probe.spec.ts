/// <reference types="bun" />
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { expect, test } from "vite-plus/test";
import { tcpProbe } from "../../src/observability/packet-loss";

test("a TCP probe answers for an open port and gives null for a closed one", async () => {
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  expect(await tcpProbe("127.0.0.1", port, 1000)).toBeGreaterThanOrEqual(0);
  await new Promise((resolve) => server.close(resolve));
  expect(await tcpProbe("127.0.0.1", port, 1000)).toBeNull();
});
