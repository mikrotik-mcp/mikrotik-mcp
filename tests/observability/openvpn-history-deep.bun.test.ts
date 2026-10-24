/// <reference types="bun" />
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenVpnSession } from "../../src/core/openvpn-sessions-model";
import { openOpenVpnHistory } from "../../src/observability/openvpn-history";

const session: OpenVpnSession = {
  id: "*1",
  sessionId: "s1",
  name: "alice",
  address: "ovpn1",
  callerId: "198.51.100.1",
  encoding: "AES",
  radius: false,
  uptime: "10s",
  uptimeSeconds: 10,
};

test("persistent history tracks gaps, failures, delayed geo and report filters", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovpn-deep-"));
  const path = join(dir, "nested", "history.db");
  let store: Awaited<ReturnType<typeof openOpenVpnHistory>> | undefined;
  const filter = { device: "edge", user: "", from: 0, to: 300_000, offset: 0 };
  const ingest = (at: number, sessions: OpenVpnSession[]) =>
    store!.ingest({ device: "edge", observedAt: at, sessions, canDisconnect: false });
  try {
    store = await openOpenVpnHistory(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    store.failure("edge");
    ingest(100_000, [session]);
    store.failure("edge");
    ingest(200_000, [{ ...session, uptimeSeconds: 110, uptime: "110s" }]);
    ingest(150_000, []); // Out-of-order snapshots cannot close a newer session.
    ingest(215_000, []);
    const before = store.report(filter, 300_000);
    expect(before.coverage).toMatchObject({ first: 100_000, last: 215_000, gaps: 1, failures: 1 });
    expect(before.sessions).toEqual([
      expect.objectContaining({ ended: 215_000, lastSeen: 200_000, uncertain: 1 }),
    ]);
    expect(store.report(filter, 300_001)).toBe(before); // Warm cache contract.
    store.enrich((ip) =>
      ip === session.callerId
        ? {
            status: "resolved",
            country: "France",
            countryCode: "fr",
            asn: "AS1",
            asnOrganization: "Example",
          }
        : undefined,
    );
    const after = store.report(filter, 330_001);
    expect(after.totals).toMatchObject({
      connections: 1,
      users: 1,
      ips: 1,
      countries: 1,
      networks: 1,
      seconds: 110,
    });
    expect(after.countries[0]).toMatchObject({ label: "France", count: 1 });
    expect(store.report({ ...filter, user: "nobody" }, 330_001).totals.connections).toBe(0);
    store.close();
    store = await openOpenVpnHistory(path);
    expect(store.report(filter, 400_000).sessions[0].countryCode).toBe("fr");
    expect(store.report({ ...filter, device: "other" }, 400_000).coverage).toBeNull();
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
