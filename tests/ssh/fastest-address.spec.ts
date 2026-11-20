import { createServer } from "node:net";
import type { AddressInfo, Server } from "node:net";
import { afterEach, expect, test } from "vite-plus/test";
import { fastestFirst } from "../../src/ssh/fastest-address";

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** A local port that accepts TCP connections. */
async function listen(): Promise<number> {
  const server = createServer((socket) => socket.destroy());
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

test("one address is returned as it is, with no connection", async () => {
  expect(await fastestFirst(["192.0.2.1"], 22, 1000)).toEqual(["192.0.2.1"]);
});

test("the primary stays first when it answers", async () => {
  const port = await listen();
  expect(await fastestFirst(["127.0.0.1", "localhost"], port, 2000)).toEqual([
    "127.0.0.1",
    "localhost",
  ]);
});

test("an address that answers moves ahead of a primary that does not", async () => {
  const port = await listen();
  const started = Date.now();
  // `.invalid` never resolves, so the primary fails and the fallback wins.
  expect(await fastestFirst(["primary.invalid", "127.0.0.1"], port, 5000)).toEqual([
    "127.0.0.1",
    "primary.invalid",
  ]);
  expect(Date.now() - started).toBeLessThan(3000);
});

test("the order stays when no address answers", async () => {
  expect(await fastestFirst(["a.invalid", "b.invalid"], 22, 1500)).toEqual([
    "a.invalid",
    "b.invalid",
  ]);
});
