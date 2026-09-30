/** Manual UI QA: real memory API, synthetic SQLite data, no routers or on-disk writes. */
import { file, serve } from "bun";
import { MikrotikConfigSchema } from "../src/config";
import { setConfig } from "../src/core/runtime";
import { installMemoryStore } from "../src/memory/accessor";
import { openMemoryStore } from "../src/memory/store";
import { RememberSchema, ScopeSchema } from "../src/memory/knowledge";
import { memoryRoutes } from "../src/observability/memory-routes";

setConfig(
  MikrotikConfigSchema.parse({
    devices: { "demo-home": { host: "192.0.2.1" } },
    defaultDevice: "demo-home",
    memory: { enabled: true, dbPath: ":memory:" },
  }),
);
const store = await openMemoryStore(":memory:");
installMemoryStore(store);
store.createEntities([
  { name: "demo-home", entityType: "router" },
  { name: "demo-exit", entityType: "router" },
  { name: "change-policy", entityType: "policy" },
  { name: "vpn-policy", entityType: "policy" },
]);
store.setScope(
  ScopeSchema.parse({
    entityName: "change-policy",
    scope: "shared",
    expectedRevision: 0,
    confirmSharing: true,
  }),
);
store.setScope(
  ScopeSchema.parse({
    entityName: "vpn-policy",
    scope: "group",
    members: ["demo-home", "demo-exit"],
    expectedRevision: 0,
    confirmSharing: true,
  }),
);
store.createRelations([
  { from: "demo-home", to: "demo-exit", relationType: "routes_via" },
  { from: "demo-home", to: "change-policy", relationType: "governed_by" },
]);
const samples = [
  {
    entityName: "vpn-policy",
    kind: "constraint",
    key: "path.mtu",
    content: "Use measured path MTU 1400 for the VPN group.",
  },
  {
    entityName: "demo-home",
    kind: "fact",
    key: "path.mtu",
    content: "Last measured path MTU was 1380. Recheck before changing.",
  },
  {
    entityName: "demo-home",
    kind: "constraint",
    content: "Create a recoverable backup before changing VPN or firewall configuration.",
    pinned: true,
    key: "changes.backup",
  },
  {
    entityName: "demo-home",
    kind: "lesson",
    content:
      "Measure path MTU from the active client. A router-only ping does not prove end-to-end delivery.",
  },
  {
    entityName: "demo-home",
    kind: "fact",
    content: "WireGuard uses the exit router for internet traffic.",
    key: "vpn.egress",
  },
  {
    entityName: "demo-home",
    kind: "preference",
    content: "Prefer a short explanation of measured results, with uncertainty made explicit.",
  },
  {
    entityName: "demo-exit",
    kind: "procedure",
    content:
      "Compare direct and tunnel latency before choosing a route. Preserve the management path.",
  },
  {
    entityName: "demo-exit",
    kind: "fact",
    content: "A temporary maintenance window was scheduled for the exit router.",
    expiresAt: Date.now() - 1000,
  },
  {
    entityName: "change-policy",
    kind: "constraint",
    content: "Memory describes past observations; it never authorizes a router mutation.",
    pinned: true,
  },
];
for (const [i, sample] of samples.entries()) {
  const fact = store.remember(
    RememberSchema.parse({ ...sample, source: "Synthetic offline QA evidence", confidence: 0.8 }),
  );
  if (i % 2 === 0) store.revise({ id: fact.id, expectedRevision: fact.revision, verified: true });
}
const retired = store.remember(
  RememberSchema.parse({
    entityName: "demo-home",
    content: "Retired tunnel configuration. Kept only for audit.",
  }),
);
store.revise({ id: retired.id, expectedRevision: retired.revision, status: "archived" });
const server = serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url),
      path = url.pathname;
    if (path === "/") return new Response(file("dist/ui/observability.html"));
    // Configuration persistence is deliberately unavailable in this isolated fixture.
    if (path === "/api/memory/config" && req.method !== "GET")
      return Response.json(
        { error: "Offline fixture: configuration persistence is disabled." },
        { status: 409 },
      );
    const memory = await memoryRoutes(req, url);
    if (memory) return memory;
    if (path === "/api/meta")
      return Response.json({
        version: "MEMORY QA",
        tools: [],
        devices: ["demo-home"],
        risks: [],
        total: 0,
        liveClients: 0,
        transport: "offline fixture",
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
    if (path === "/api/devices") return Response.json({ devices: [], defaultDevice: "demo-home" });
    return Response.json({});
  },
});
console.warn(`Offline memory dashboard: http://127.0.0.1:${server.port}/#memory`);
