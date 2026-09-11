import { createContext } from "../core/context";
import { roundTripTools } from "../tools/round-trip";
import { readOperationBody, DashboardInputError } from "./bounded-request";
import { DEFAULT_SNAPSHOT_DB } from "../config";
import { openSnapshotStore } from "../snapshots/store";
import { listDevices, resolveDeviceName } from "../core/runtime";
import { assertDeviceAccess } from "../core/scoped-access";
import { buildModel } from "../sim/model";

export async function roundTripRoutes(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/round-trip/options") {
    if (req.method !== "GET") return Response.json({ error: "Use GET" }, { status: 405 });
    try {
      const requested = url.searchParams.get("device");
      const names = requested ? [resolveDeviceName(requested)] : listDevices().names;
      const allowed = names.filter((name) => {
        try {
          assertDeviceAccess([name], "trace_round_trip", "READ");
          return true;
        } catch {
          return false;
        }
      });
      if (requested && !allowed.length)
        return Response.json({ error: "Device access denied" }, { status: 403 });
      const store = await openSnapshotStore(DEFAULT_SNAPSHOT_DB);
      try {
        const id = url.searchParams.get("id");
        if (id) {
          if (!requested) return Response.json({ error: "Select a router first" }, { status: 400 });
          const s = store.get(id);
          if (!s || s.device !== allowed[0] || new TextEncoder().encode(s.body).length > 512 * 1024)
            return Response.json(
              { error: "Snapshot unavailable for this router" },
              { status: 404 },
            );
          const interfaces = buildModel(s.body).interfaces;
          assertDeviceAccess(allowed, "trace_round_trip", "READ");
          return Response.json({ interfaces }, { headers: { "cache-control": "no-store" } });
        }
        const devices = allowed.slice(0, 128).map((device) => ({
          device,
          snapshots: store
            .list(device, 20, false)
            .map((s) => ({ id: s.id, device: s.device, ts: s.ts, label: s.label })),
        }));
        assertDeviceAccess(
          devices.map((d) => d.device),
          "trace_round_trip",
          "READ",
        );
        return Response.json({ devices }, { headers: { "cache-control": "no-store" } });
      } finally {
        store.close();
      }
    } catch {
      return Response.json(
        {
          error:
            "Saved configuration choices could not be loaded. Check device access and snapshot storage.",
        },
        { status: 400 },
      );
    }
  }
  if (url.pathname !== "/api/round-trip") return null;
  if (req.method !== "POST") return Response.json({ error: "Use POST" }, { status: 405 });
  try {
    const input = JSON.parse(await readOperationBody(req));
    const result = await roundTripTools[0].handler(
      input,
      createContext(undefined, url.searchParams.get("device") ?? undefined),
    );
    return new Response(result as string, {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof DashboardInputError)
      return Response.json({ error: error.message }, { status: error.status });
    return Response.json(
      {
        error:
          "Path analysis failed. Check topology, device access, snapshot ownership, age and capture skew.",
      },
      { status: 400 },
    );
  }
}
