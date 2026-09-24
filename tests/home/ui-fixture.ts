/** Offline dashboard QA. All responses are synthetic and all changes stay in memory. */
import type { HomeClient, PolicyPlan } from "../../src/home/model";
import { serve, file } from "bun";
const now = Date.now();
let clients: HomeClient[] = [];
const policies: PolicyPlan[] = [];
const json = (body: unknown, status = 200) => Response.json(body, { status });
const server = serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url),
      path = url.pathname;
    if (path === "/") return new Response(file("dist/ui/observability.html"));
    if (path === "/api/meta")
      return json({
        version: process.argv[2] ?? "OFFLINE FIXTURE",
        tools: [],
        devices: ["demo-home"],
        risks: [],
        total: 0,
        liveClients: 0,
        transport: "fixture",
      });
    if (path === "/api/events") return json({ events: [] });
    if (path === "/api/devices")
      return json({
        defaultDevice: "demo-home",
        server: "offline fixture",
        devices: [
          {
            name: "demo-home",
            host: "192.0.2.1",
            port: 22,
            username: "fixture",
            authMode: "fixture",
            isDefault: true,
            status: { reachable: null, checkedAt: null, latencyMs: null },
            activity: { calls: 0, errors: 0, lastSeen: 0, avgMs: 0 },
            pool: null,
          },
        ],
      });
    if (path === "/api/home-internet") return json({ clients, policies });
    if (path.startsWith("/api/home-internet/")) {
      const data = (await req.json()) as Record<string, any>;
      if (path.endsWith("/refresh")) {
        if (!clients.length)
          clients = [
            {
              mac: "AA:BB:CC:DD:EE:01",
              ip: "192.168.88.10",
              hostname: "work-laptop",
              name: "Work laptop",
              person: "Ali",
              firstSeen: now,
              lastSeen: now,
              acknowledged: true,
              present: true,
            },
            {
              mac: "AA:BB:CC:DD:EE:02",
              ip: "192.168.88.11",
              hostname: "living-room-tv",
              name: "Living room TV",
              person: "Household",
              firstSeen: now,
              lastSeen: now,
              acknowledged: false,
              present: true,
            },
          ];
        return json({ clients, tables: ["main", "fiber", "vpn-netherlands"] });
      }
      if (path.endsWith("/name")) {
        const client = clients.find((c) => c.mac === data.mac)!;
        Object.assign(client, { name: data.name, person: data.person, acknowledged: true });
        return json(client);
      }
      if (path.endsWith("/diagnose") && data.target === "error.invalid")
        return json({ error: "Fixture: router query failed. No measurement is available." }, 400);
      if (path.endsWith("/diagnose"))
        return json({
          device: "demo-home",
          client: data.client,
          target: data.target,
          at: Date.now(),
          applicationHealth: "unverified",
          findings: [
            {
              area: "Router",
              state: "observed",
              title: "Router has headroom",
              detail: "Fixture CPU sample: 24%.",
              next: "Compare during the slowdown.",
            },
            {
              area: "Wi-Fi",
              state: "suspected",
              title: "Wi-Fi signal may be limiting this device",
              detail: "Fixture signal: −78 dBm. A single sample is not a throughput test.",
              next: "Move closer and compare with a wired connection.",
            },
            {
              area: "Internet",
              state: "unknown",
              title: "Client application health is unverified",
              detail: "Router probes do not follow the client's full path.",
              next: "Test from the affected client before changing MTU.",
            },
          ],
        });
      if (path.endsWith("/compare"))
        return json({
          device: "demo-home",
          at: Date.now(),
          target: data.target,
          goal: data.goal,
          recommended: data.goal === "download" ? null : "fiber",
          explanation:
            "OFFLINE FIXTURE: ICMP comparison only; download throughput was not measured.",
          paths: data.tables.map((table: string, i: number) => ({
            table,
            state: "observed",
            loss: i ? 0 : 20,
            latency: i ? 18 : 85,
            spread: i ? 4 : 55,
            note: "Synthetic router ICMP sample, not client delivery proof.",
          })),
        });
      if (path.endsWith("/preview")) {
        const plan: PolicyPlan = {
          id: crypto.randomUUID(),
          device: "demo-home",
          input: data as any,
          ip: "192.168.88.10",
          createdAt: Date.now(),
          previewExpiresAt: Date.now() + 300000,
          status: "preview",
          fingerprint: "offline",
          commands: ["# Offline fixture only — no RouterOS commands run"],
          undo: ["# Undo synthetic state only"],
          warnings: [
            "OFFLINE FIXTURE. No router is connected.",
            "A real apply requires a bound static DHCP lease, scheduler support and no FastTrack conflict.",
          ],
        };
        policies.push(plan);
        return json(plan);
      }
      const p = policies.find((p) => p.id === data.id);
      if (p && data.confirm && path.endsWith("/apply")) {
        p.status = "active";
        p.snapshot = "offline-fixture-snapshot";
        p.startsAt = Date.now();
        p.endsAt = Date.now() + 1800000;
        return json(p);
      }
      if (p && data.confirm && path.endsWith("/undo")) {
        p.status = "undone";
        return json(p);
      }
      return json({ error: "Fixture: unsupported request" }, 400);
    }
    return json({ error: "Not implemented in offline fixture" }, 404);
  },
});
process.stdout.write(`Offline Home Internet fixture: ${server.url}#home-internet\n`);
