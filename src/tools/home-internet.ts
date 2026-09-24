import { z } from "zod";
import { defineTool, READ, WRITE } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { resolveDeviceName } from "../core/runtime";
import { assertDeviceAccess } from "../core/scoped-access";
import { diagnosisInput, compareInput, policyInput, macInput, enabled } from "../home/model";
import { diagnoseInternet, comparePaths, rows } from "../home/read";
import { previewPolicy, applyPolicy, undoPolicy } from "../home/policies";
import { homeStore } from "../home/store";

export const homeInternetTools: ToolModule = [
  defineTool({
    name: "diagnose_home_internet",
    title: "Why Is My Internet Slow?",
    annotations: READ,
    description:
      "Start here when a household client reports slow internet. Read router CPU/memory, client Wi-Fi signal, DNS, exact-IP queues and five bounded router ICMP probes. Return plain-language observed facts, suspected causes and unknowns with next steps. Never changes MTU/config, enables accounting or claims client application success. No throughput test is run.",
    inputSchema: diagnosisInput.shape,
    handler: async (a, ctx) => JSON.stringify(await diagnoseInternet(a, ctx)),
  }),
  defineTool({
    name: "compare_home_paths",
    title: "Compare Internet Paths",
    annotations: READ,
    description:
      "Compare up to three existing enabled FIB routing tables with five ICMP probes each to one explicit IPv4 target. For calls/gaming suggest the lowest-loss/latency candidate; download throughput is unmeasured, so no fastest-download recommendation. Router output mangle may affect probes. Selection is separate: preview_home_policy, then explicit user approval and apply_home_policy. Never switches routes automatically.",
    inputSchema: compareInput.shape,
    handler: async (a, ctx) => JSON.stringify(await comparePaths(a, ctx)),
  }),
  defineTool({
    name: "get_home_internet",
    title: "Read Household Internet Workspace",
    annotations: READ,
    description:
      "Read locally saved household device names, people, newly discovered devices and temporary policy history for this router. Historical policy status is not current router proof. No router queries; refresh_home_devices explicitly collects current DHCP records and available routing tables.",
    inputSchema: {},
    async handler(_a, ctx) {
      const device = resolveDeviceName(ctx.device);
      assertDeviceAccess([device], "get_home_internet", "READ");
      const store = await homeStore();
      return JSON.stringify({
        device,
        clients: store.clients(device),
        policies: store.plans(device),
        statusNote:
          "Saved status only. A passed expiry time is not a verified cleanup result; Undo can reconcile owned objects.",
      });
    },
  }),
  defineTool({
    name: "refresh_home_devices",
    title: "Discover Household Devices",
    annotations: WRITE,
    description:
      "Read DHCP clients and routing tables, saving a local first/last-seen household inventory. First scan establishes a baseline; later new MACs appear as unacknowledged notices. No router writes or background scans. WRITE reflects local persistence. Randomized MACs may look like new devices; absence does not prove offline.",
    inputSchema: {},
    async handler(_a, ctx) {
      const device = resolveDeviceName(ctx.device);
      assertDeviceAccess([device], "refresh_home_devices", "WRITE");
      const leases = await rows(
        "/ip dhcp-server lease",
        "address,mac-address,host-name,status",
        ctx,
      );
      const tables = await rows("/routing table", "name,fib,disabled", ctx);
      const store = await homeStore(),
        old = store.clients(device),
        now = Date.now();
      const seen = new Set<string>();
      for (const r of leases) {
        const parsed = macInput.safeParse(r["mac-address"]);
        if (!parsed.success) continue;
        const mac = parsed.data.toUpperCase(),
          prior = old.find((c) => c.mac === mac);
        seen.add(mac);
        store.saveClient(device, {
          mac,
          ip: r.address ?? "",
          hostname: r["host-name"] ?? "",
          name: prior?.name ?? "",
          person: prior?.person ?? "",
          firstSeen: prior?.firstSeen ?? now,
          lastSeen: now,
          acknowledged: prior?.acknowledged ?? old.length === 0,
          present: r.status === "bound",
        });
      }
      for (const client of old)
        if (!seen.has(client.mac)) store.saveClient(device, { ...client, present: false });
      return JSON.stringify({
        device,
        clients: store.clients(device),
        tables: tables
          .filter((t) => enabled(t) && ["yes", "true"].includes(t.fib))
          .map((t) => t.name),
      });
    },
  }),
  defineTool({
    name: "name_home_device",
    title: "Name a Household Device",
    annotations: WRITE,
    description:
      "Save a friendly device name and person locally and acknowledge its new-device notice. Does not modify router DHCP, reserve an IP or change access.",
    inputSchema: {
      mac: macInput,
      name: z.string().trim().max(80),
      person: z.string().trim().max(80).default(""),
    },
    async handler(a, ctx) {
      const device = resolveDeviceName(ctx.device);
      assertDeviceAccess([device], "name_home_device", "WRITE");
      const store = await homeStore(),
        client = store.clients(device).find((c) => c.mac === a.mac.toUpperCase());
      if (!client) throw new Error("Refresh household devices first.");
      const result = { ...client, name: a.name, person: a.person, acknowledged: true };
      store.saveClient(device, result);
      return JSON.stringify(result);
    },
  }),
  defineTool({
    name: "preview_home_policy",
    title: "Preview a Temporary Household Policy",
    annotations: WRITE,
    description:
      "Prepare a device-bound five-minute consent preview for a reserved IPv4 DHCP client: pause routed access, raise an existing child queue to meeting priority, or select an existing route table. Duration 5–120 minutes; optional start delay up to 24h. Local preview only, no router changes. Fails closed on FastTrack, ambiguous leases, conflicting route marks or missing QoS. Pause refuses IPv6 forwarding. Review exact commands, limitations and expiry with the user before applying.",
    inputSchema: policyInput.shape,
    handler: async (a, ctx) => JSON.stringify(await previewPolicy(a, ctx)),
  }),
  defineTool({
    name: "apply_home_policy",
    title: "Apply an Approved Household Policy",
    annotations: WRITE,
    description:
      "Only after explicit user approval of preview_home_policy: consume its one-use ID, recheck unchanged router state, save a local snapshot, apply in a NEW Safe Mode session, install router-side expiry and commit. No direct-write fallback. Scheduled policies expire even if MCP stops; priority restoration requires scheduler permission. Existing sessions may disconnect. Uncertain results must be inspected/undone, never blindly retried.",
    inputSchema: { id: z.uuid(), confirm: z.boolean().default(false) },
    handler: async (a, ctx) => JSON.stringify(await applyPolicy(a.id, a.confirm, ctx)),
  }),
  defineTool({
    name: "undo_home_policy",
    title: "Undo a Household Policy",
    annotations: WRITE,
    description:
      "With user confirmation remove only this policy's tagged rules/timers and restore its previous queue priority when the queue still matches. Works from durable history after an MCP restart. Does not restore an entire config or touch unrelated rules. Use to reconcile expired or uncertain policies too.",
    inputSchema: { id: z.uuid(), confirm: z.boolean().default(false) },
    handler: async (a, ctx) => JSON.stringify(await undoPolicy(a.id, a.confirm, ctx)),
  }),
];
