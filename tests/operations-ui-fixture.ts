/** Manual visual QA: synthetic data only; no router connections, database or config writes. */
import { file, serve } from "bun";
import { blankFlight, freezeFlight } from "../src/flight-recorder/model";
const now = Date.now();
const flight = blankFlight("demo-home", now);
flight.enabled = true;
flight.samples = Array.from({ length: 30 }, (_, i) => ({
  at: now - (29 - i) * 60000,
  finishedAt: now - (29 - i) * 60000,
  reachable: i !== 19 && i !== 20,
  cpu: i === 19 || i === 20 ? undefined : 12 + (i % 7) * 6,
  interfaces: [],
  gaps: i === 19 || i === 20 ? ["Management read failed; network outage is not established."] : [],
}));
flight.events = [
  {
    id: "example",
    at: now - 10 * 60000,
    source: "mcp",
    title: "update_route",
    risk: "WRITE",
    failed: false,
  },
];
freezeFlight(flight, "Management read interruption", "management", now - 8 * 60000).complete = true;
const policy = {
  id: "00000000-0000-4000-8000-000000000001",
  device: "demo-home",
  name: "Workspace services",
  host: "example.com",
  target: "workspace",
  family: "ipv4",
  sources: ["10.10.10.0/24"],
  tables: ["main", "warp"],
  primary: "main",
  activeTable: "main",
  state: "active",
  updatedAt: now,
  failuresBeforeSwitch: 3,
  cooldownSeconds: 300,
  samples: [
    {
      table: "main",
      state: "pass",
      at: now,
      elapsedMs: 186,
      detail:
        "HTTPS HEAD completed via VRF main; elapsed includes SSH overhead. Not a client-path or throughput test.",
    },
    {
      table: "warp",
      state: "unknown",
      at: now,
      detail: "This routing table is not a VRF. A table-only HTTPS path cannot be proved by fetch.",
    },
  ],
  history: [
    {
      at: now,
      message: "Routing read-back verified: main. Client delivery still requires a client check.",
    },
    { at: now - 60000, message: "Draft saved. No router changes or probes yet." },
  ],
};
const server = serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/") return new Response(file("dist/ui/observability.html"));
    if (req.method !== "GET")
      return Response.json(
        { error: "Offline visual fixture; mutations are disabled." },
        { status: 409 },
      );
    if (path === "/api/service-routing") return Response.json({ policies: [policy] });
    if (path === "/api/flight-recorder")
      return Response.json({ recorder: flight, toolEventsAvailable: true });
    if (path === "/api/service-routing/inventory")
      return Response.json({
        tables: ["main", "warp"],
        targets: [{ alias: "workspace", host: "example.com" }],
      });
    if (path === "/api/meta")
      return Response.json({
        version: "OFFLINE QA",
        tools: [],
        devices: ["demo-home"],
        risks: [],
        total: 0,
        liveClients: 0,
        transport: "synthetic fixture",
      });
    if (path === "/api/devices")
      return Response.json({
        devices: [
          {
            name: "demo-home",
            host: "192.0.2.1",
            port: 22,
            enabled: true,
            status: { checkedAt: now, state: "online", ok: true },
          },
        ],
        defaultDevice: "demo-home",
      });
    if (path === "/api/events") return Response.json({ events: [] });
    if (path === "/api/stats")
      return Response.json({
        total: 0,
        errors: 0,
        errorRate: 0,
        callsPerMin: 0,
        outputBytes: 0,
        latency: { avg: 0, p50: 0, p95: 0, p99: 0, max: 0 },
        byTool: [],
        byRisk: {},
        byDevice: [],
        byStatus: { ok: 0, error: 0 },
        series: [],
        recentErrors: [],
        distinctTools: 0,
        distinctDevices: 0,
        windowMs: 3600000,
      });
    return Response.json({});
  },
});
console.warn(`Offline operations dashboard: http://127.0.0.1:${server.port}/#service-routing`);
