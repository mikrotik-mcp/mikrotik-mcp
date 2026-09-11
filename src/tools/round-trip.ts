import { defineTool, READ } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { resolveDeviceName } from "../core/runtime";
import { assertDeviceAccess } from "../core/scoped-access";
import { DEFAULT_SNAPSHOT_DB } from "../config";
import { openSnapshotStore } from "../snapshots/store";
import { roundTripInput, traceRoundTrip, validatePath } from "../paths/round-trip";

export const roundTripTools: ToolModule = [
  defineTool({
    name: "trace_round_trip",
    title: "Model a Multi-Router Round Trip",
    annotations: READ,
    description:
      "Trace an explicit IPv4 forward and reverse transit path across up to eight routers using exact saved snapshot IDs. Shows per-hop firewall/routing evidence, declared asymmetry and snapshot provenance. All devices are authorized before snapshot lookup. Static no-NAT scope: NAT, dynamic routing, incomplete evidence and unmodelled constructs stop with UNKNOWN. Freshness/skew checks are enforced. No network requests or router writes. MODELLED never means live connectivity; the return leg assumes established conntrack and a replying host.",
    inputSchema: roundTripInput.shape,
    async handler(a, ctx) {
      const input = roundTripInput.parse(a);
      const devices = validatePath(input);
      const selected = resolveDeviceName(ctx.device);
      if (input.forward[0].device !== selected)
        throw new Error("Selected device must be the first forward hop");
      assertDeviceAccess(devices, "trace_round_trip", "READ");
      const store = await openSnapshotStore(DEFAULT_SNAPSHOT_DB);
      try {
        const snapshots = input.snapshots.map((ref) => {
          const snapshot = store.get(ref.id);
          if (!snapshot || snapshot.device !== ref.device)
            throw new Error("Snapshot not found on declared device");
          return snapshot;
        });
        const result = traceRoundTrip(input, snapshots);
        assertDeviceAccess(devices, "trace_round_trip", "READ");
        return JSON.stringify(result);
      } finally {
        store.close();
      }
    },
  }),
];
