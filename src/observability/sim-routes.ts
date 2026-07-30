/**
 * Dashboard sub-router for the Simulator page.
 *
 *   GET  /api/sim/suites        saved packet suites
 *   POST /api/sim/suites        save one
 *   POST /api/sim/packet        trace one packet
 *   POST /api/sim/change        trace before/after a proposed change
 *   POST /api/sim/suite/:id/run run a saved suite
 *   GET  /api/sim/reachability  which firewall rules can never match
 *
 * Everything reads a config and computes; nothing here writes to a device. The
 * `UNKNOWN` verdict is carried through verbatim — the page styles it as a
 * warning, never as success, because a prediction the model could not make must
 * not look like a prediction that succeeded.
 */
import { createContext } from "../core/context";
import { executeMikrotikCommand } from "../core/connector";
import { looksLikeError } from "../core/routeros";
import { getConfig } from "../core/runtime";
import { unreachableRules } from "../sim/firewall";
import type { SimPacket } from "../sim/firewall";
import { buildModel } from "../sim/model";
import { diffTraces, tracePacket } from "../sim/trace";
import { listSuites, saveSuite, getSuite } from "../sim/suites";
import { openSnapshotStore } from "../snapshots/store";
import { DEFAULT_SNAPSHOT_DB } from "../config";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

async function bodyJson<T>(req: Request): Promise<T> {
  return (await req.json().catch(() => ({}))) as T;
}

let storePromise: Promise<Awaited<ReturnType<typeof openSnapshotStore>>> | null = null;
function snapshots(): Promise<Awaited<ReturnType<typeof openSnapshotStore>>> {
  storePromise ??= openSnapshotStore(DEFAULT_SNAPSHOT_DB);
  return storePromise;
}

interface PacketBody {
  device?: string;
  snapshotId?: string;
  configText?: string;
  packet: SimPacket;
  changes?: string;
}

/** Resolve the config to model: snapshot, supplied text, or a live capture. */
async function configFor(
  body: PacketBody,
): Promise<{ text: string; source: string } | { error: string }> {
  if (body.configText) return { text: body.configText, source: "supplied text" };
  if (body.snapshotId) {
    const snapshot = (await snapshots()).get(body.snapshotId);
    if (!snapshot) return { error: `no snapshot '${body.snapshotId}'` };
    return { text: snapshot.body, source: `snapshot ${snapshot.id}` };
  }
  const device = body.device ?? getConfig().defaultDevice;
  const ctx = createContext(undefined, device);
  const text = await executeMikrotikCommand("/export terse", ctx);
  if (looksLikeError(text) || text.trim() === "") {
    return { error: `could not read the configuration of '${device}'` };
  }
  return { text, source: `live config of ${device}` };
}

export async function simRoutes(req: Request, url: URL): Promise<Response | null> {
  const p = url.pathname;
  if (!p.startsWith("/api/sim")) return null;

  if (p === "/api/sim/suites" && req.method === "GET") {
    return json({ suites: await listSuites() });
  }

  if (p === "/api/sim/suites" && req.method === "POST") {
    const body = await bodyJson<{ id?: string; name?: string; packets?: unknown[] }>(req);
    if (!body.name || !Array.isArray(body.packets) || body.packets.length === 0) {
      return json({ error: "name and a non-empty packets array are required" }, 400);
    }
    const saved = await saveSuite({
      id: body.id,
      name: body.name,
      packets: body.packets as never[],
    });
    return json({ suite: saved });
  }

  if (p === "/api/sim/packet" && req.method === "POST") {
    const body = await bodyJson<PacketBody>(req);
    const config = await configFor(body);
    if ("error" in config) return json(config, 400);
    const model = buildModel(config.text);
    const result = tracePacket({ model, packet: body.packet });
    return json({
      source: config.source,
      result,
      coverage: {
        unmodelled: model.unmodelled,
        unparsedLines: model.unparsedLines,
        dynamicRouteSources: model.dynamicRouteSources,
      },
    });
  }

  if (p === "/api/sim/change" && req.method === "POST") {
    const body = await bodyJson<PacketBody>(req);
    const config = await configFor(body);
    if ("error" in config) return json(config, 400);
    if (!body.changes || body.changes.trim() === "") {
      return json({ error: "changes are required" }, 400);
    }
    const before = tracePacket({ model: buildModel(config.text), packet: body.packet });
    const afterModel = buildModel(`${config.text}\n${body.changes}\n`);
    const after = tracePacket({ model: afterModel, packet: body.packet });
    return json({
      source: config.source,
      before,
      after,
      diff: diffTraces(before, after),
      coverage: { unmodelled: afterModel.unmodelled, unparsedLines: afterModel.unparsedLines },
    });
  }

  if (p === "/api/sim/reachability" && req.method === "GET") {
    const config = await configFor({
      device: url.searchParams.get("device") ?? undefined,
      snapshotId: url.searchParams.get("snapshot") ?? undefined,
      packet: {} as SimPacket,
    });
    if ("error" in config) return json(config, 400);
    const model = buildModel(config.text);
    const dead = unreachableRules(model.filter);
    return json({
      source: config.source,
      rules: model.filter.map((r) => ({
        chain: r.chain,
        index: r.index,
        action: r.action,
        line: r.line,
        raw: r.raw,
        disabled: r.disabled,
        unreachable: dead.some((d) => d.rule === r),
        shadowedBy: dead.find((d) => d.rule === r)?.shadowedBy.index,
        why: dead.find((d) => d.rule === r)?.why,
      })),
      unreachableCount: dead.length,
    });
  }

  const runMatch = p.startsWith("/api/sim/suite/") && p.endsWith("/run");
  if (runMatch && req.method === "POST") {
    const id = decodeURIComponent(p.slice("/api/sim/suite/".length, -"/run".length));
    const suite = await getSuite(id);
    if (!suite) return json({ error: `no suite '${id}'` }, 404);

    const body = await bodyJson<PacketBody>(req);
    const config = await configFor({ ...body, packet: {} as SimPacket });
    if ("error" in config) return json(config, 400);
    const model = buildModel(config.text);

    const results = suite.packets.map((entry) => {
      const result = tracePacket({ model, packet: entry.packet });
      return {
        name: entry.name,
        expect: entry.expect,
        verdict: result.verdict,
        // An UNKNOWN is a failure: a flow the model cannot decide is not verified.
        ok: result.verdict === entry.expect,
        summary: result.summary,
      };
    });
    return json({
      source: config.source,
      suite: { id: suite.id, name: suite.name },
      results,
      passed: results.filter((r) => r.ok).length,
      total: results.length,
    });
  }

  return json({ error: "not found" }, 404);
}
