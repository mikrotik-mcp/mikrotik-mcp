/// <reference types="bun" />
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSiteActivityStore } from "../../src/observability/site-activity";
import { siteActivityRoutes } from "../../src/observability/site-activity-routes";

test("site activity persists only exact client DNS matches and proxy hosts", async () => {
  const store = await openSiteActivityStore(":memory:");
  const now = Date.now();
  store.answer("10.0.0.2", "93.184.215.14", "example.com", now + 60000, now);
  store.identify([
    {
      client: "10.0.0.2",
      kind: "wifi",
      owner: "Living room phone",
      device: "home",
      mac: "AA:BB:CC:DD:EE:FF",
      observed: now,
    },
  ]);
  store.flows([
    {
      start: now + 1000,
      end: now + 2000,
      src: "10.0.0.2",
      dst: "93.184.215.14",
      srcPort: 50000,
      dstPort: 443,
      protocol: 6,
      bytes: 100,
      packets: 1,
      version: 9,
    },
    {
      start: now + 1000,
      end: now + 2000,
      src: "10.0.0.3",
      dst: "93.184.215.14",
      srcPort: 50001,
      dstPort: 443,
      protocol: 6,
      bytes: 200,
      packets: 1,
      version: 9,
    },
  ]);
  store.proxy("unique", "10.0.0.4", "example.org", now);
  store.proxy("unique", "10.0.0.4", "example.org", now);
  const filters = { from: now, to: now + 3000, client: "", search: "", kind: "", owner: "" };
  const rows = store.visits(filters, 0);
  expect(rows).toHaveLength(3);
  expect(rows.find((r) => r.client === "10.0.0.2")?.domain).toBe("example.com");
  expect(rows.find((r) => r.client === "10.0.0.2")?.owner).toBe("Living room phone");
  expect(store.summary({ ...filters, kind: "wifi" }).observations).toBe(1);
  expect(store.visits({ ...filters, owner: "Living room phone" }, 0)).toHaveLength(1);
  expect(store.visits({ ...filters, kind: "openvpn" }, 0)).toHaveLength(0);
  expect(store.summary({ ...filters, owner: "Living room phone" }).groups).toEqual([
    { label: "example.com", observations: 1, bytes: 100 },
  ]);
  expect(store.identities(now, now + 3000)[0]?.owner).toBe("Living room phone");
  expect(rows.find((r) => r.client === "10.0.0.3")?.domain).toBeNull();
  expect(rows.find((r) => r.client === "10.0.0.4")?.connections).toBe(1);
  store.flows([
    {
      start: now + 60_000_000,
      end: now + 60_000_100,
      src: "10.0.0.5",
      dst: "93.184.215.14",
      srcPort: 50002,
      dstPort: 443,
      protocol: 6,
      bytes: 1,
      packets: 1,
      version: 10,
    },
  ]);
  store.prune(now);
  expect(store.visits({ ...filters, to: now + 70_000_000, client: "10.0.0.5" }, 0)).toEqual([]);
  store.close();
});

test("collection policy gates new rows by identity and expiry without hiding history", async () => {
  const store = await openSiteActivityStore(":memory:");
  const now = Date.now();
  const flow = (client: string, start: number) => ({
    start,
    end: start + 1000,
    src: client,
    dst: "93.184.215.14",
    srcPort: 50000,
    dstPort: 443,
    protocol: 6,
    bytes: 100,
    packets: 1,
    version: 9,
  });
  const filters = {
    from: now - 1000,
    to: now + 10_000,
    client: "",
    search: "",
    kind: "",
    owner: "",
  };
  store.flows([flow("10.0.0.2", now)]);
  store.identify([
    {
      client: "10.0.0.2",
      kind: "wifi",
      owner: "Allowed phone",
      device: "home",
      mac: "AA",
      observed: now,
    },
    {
      client: "10.0.0.3",
      kind: "wifi",
      owner: "Other phone",
      device: "home",
      mac: "BB",
      observed: now,
    },
  ]);
  store.setPolicy({ enabled: true, owners: ["Allowed phone"], until: now + 5000 });
  store.flows([
    flow("10.0.0.2", now + 1000),
    flow("10.0.0.3", now + 1000),
    flow("10.0.0.4", now + 1000),
  ]);
  expect(store.summary(filters).observations).toBe(2);
  store.flows([flow("10.0.0.2", now + 6000)]);
  expect(store.summary(filters).observations).toBe(2);
  store.setPolicy({ enabled: false, owners: [], until: null });
  store.proxy("p1", "10.0.0.2", "example.org", now + 2000);
  expect(store.visits(filters, 0)).toHaveLength(1);
  expect(store.policy()).toEqual({ enabled: false, owners: [], until: null });
  store.close();
});

test("policy endpoint validates and returns collection settings", async () => {
  const store = await openSiteActivityStore(":memory:");
  const url = new URL("http://localhost/api/site-activity/policy");
  const invalid = await siteActivityRoutes(
    new Request(url, {
      method: "PUT",
      body: JSON.stringify({ enabled: true, owners: ["User"], until: 0 }),
    }),
    url,
    store,
  );
  expect(invalid?.status).toBe(400);
  const saved = await siteActivityRoutes(
    new Request(url, {
      method: "PUT",
      body: JSON.stringify({ enabled: false, owners: ["User"], until: null }),
    }),
    url,
    store,
  );
  expect(saved?.status).toBe(200);
  expect(await saved?.json()).toEqual({ enabled: false, owners: ["User"], until: null });
  expect(await (await siteActivityRoutes(new Request(url), url, store))?.json()).toEqual({
    enabled: false,
    owners: ["User"],
    until: null,
  });
  store.close();
});

test("collection policy survives reopening the local database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "site-policy-"));
  try {
    const path = join(dir, "activity.db");
    const first = await openSiteActivityStore(path);
    first.setPolicy({ enabled: false, owners: ["VPN user"], until: null });
    first.close();
    const reopened = await openSiteActivityStore(path);
    expect(reopened.policy()).toEqual({ enabled: false, owners: ["VPN user"], until: null });
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
