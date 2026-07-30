/**
 * Dashboard sub-router for the config narrative.
 *
 *   GET  /api/explain/:device                 analyse the live device
 *   GET  /api/explain/:device/section/:name   one section of it
 *   POST /api/explain/diff                    two configurations → consequences
 *
 * `?snapshot=<id>` on either GET analyses a stored snapshot instead of the live
 * device, which is how the compare mode explains the router as it was three
 * weeks ago.
 *
 * Every route returns the structured narrative alongside the Markdown. The page
 * needs the structure to draw the topology and highlight the exposure panel;
 * the Markdown is what people copy into a wiki.
 */
import { DEFAULT_SNAPSHOT_DB } from "../config";
import { executeMikrotikCommand } from "../core/connector";
import { createContext } from "../core/context";
import { looksLikeError } from "../core/routeros";
import { resolveDeviceName } from "../core/runtime";
import { analyzeDevice } from "../narrative/analyze";
import type { DeviceNarrative } from "../narrative/analyze";
import { diffNarratives, renderDiff } from "../narrative/diff";
import { topologyMermaid } from "../narrative/mermaid";
import { NARRATIVE_SECTIONS, renderNarrative } from "../narrative/render";
import type { NarrativeSection } from "../narrative/render";
import { openSnapshotStore } from "../snapshots/store";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

let storePromise: Promise<Awaited<ReturnType<typeof openSnapshotStore>>> | null = null;
function snapshots(): Promise<Awaited<ReturnType<typeof openSnapshotStore>>> {
  storePromise ??= openSnapshotStore(DEFAULT_SNAPSHOT_DB);
  return storePromise;
}

/** Config text from a snapshot id, or from the live device. */
async function configFor(
  device: string,
  snapshotId: string | null,
): Promise<{ text: string; device: string; source: string } | { error: string; status: number }> {
  if (snapshotId) {
    const snapshot = (await snapshots()).get(snapshotId);
    if (!snapshot) return { error: `no snapshot '${snapshotId}'`, status: 404 };
    return {
      text: snapshot.body,
      device: snapshot.device ?? device,
      source: `snapshot ${snapshotId}`,
    };
  }
  const name = resolveDeviceName(device);
  // `/export` is a read-only print — it writes no file and changes nothing.
  const body = await executeMikrotikCommand("/export", createContext(undefined, name));
  if (looksLikeError(body) || body.trim() === "") {
    return { error: body.trim() || "the device returned an empty export", status: 502 };
  }
  return { text: body, device: name, source: "live device" };
}

function payload(narrative: DeviceNarrative, source: string, markdown: string): unknown {
  return {
    narrative,
    markdown,
    // The Mermaid source travels with the response even though the page draws
    // its own SVG: it is what people paste into a wiki, and generating it here
    // keeps one implementation rather than two that can disagree.
    mermaid: topologyMermaid(narrative),
    source,
  };
}

export async function explainRoutes(req: Request, url: URL): Promise<Response | null> {
  const p = url.pathname;
  if (!p.startsWith("/api/explain")) return null;

  if (p === "/api/explain/diff" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as {
      device?: string;
      before?: string;
      after?: string;
      beforeText?: string;
      afterText?: string;
    } | null;
    if (!body) return json({ error: "invalid JSON body" }, 400);
    if (!body.before && !body.beforeText) {
      return json(
        { error: "a diff needs a baseline: pass `before` (a snapshot id) or `beforeText`" },
        400,
      );
    }

    const device = body.device ?? "";
    const before = body.beforeText
      ? { text: body.beforeText, device, source: "supplied text" }
      : await configFor(device, body.before ?? null);
    if ("error" in before) return json({ error: `before: ${before.error}` }, before.status);

    // No `after` means "compare against the device as it is now", which is how
    // people ask what has changed since they documented it.
    const after = body.afterText
      ? { text: body.afterText, device, source: "supplied text" }
      : await configFor(device, body.after ?? null);
    if ("error" in after) return json({ error: `after: ${after.error}` }, after.status);

    const diff = diffNarratives(
      analyzeDevice(before.text, before.device),
      analyzeDevice(after.text, after.device),
    );
    return json({ diff, markdown: renderDiff(diff), before: before.source, after: after.source });
  }

  const rest = p.slice("/api/explain/".length).split("/").filter(Boolean);
  if (rest.length === 0) return json({ error: "not found" }, 404);
  if (req.method !== "GET") return json({ error: "not found" }, 404);

  const device = decodeURIComponent(rest[0]);
  const snapshotId = url.searchParams.get("snapshot");

  let config;
  try {
    config = await configFor(device, snapshotId);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
  if ("error" in config) return json({ error: config.error }, config.status);

  const narrative = { ...analyzeDevice(config.text, config.device), generatedAt: Date.now() };

  if (rest.length === 1) {
    return json(payload(narrative, config.source, renderNarrative(narrative)));
  }
  if (rest[1] === "section" && rest[2]) {
    const section = decodeURIComponent(rest[2]) as NarrativeSection;
    if (!NARRATIVE_SECTIONS.includes(section)) {
      return json(
        { error: `unknown section '${section}'. Known: ${NARRATIVE_SECTIONS.join(", ")}` },
        400,
      );
    }
    return json(
      payload(narrative, config.source, renderNarrative(narrative, { sections: [section] })),
    );
  }
  return json({ error: "not found" }, 404);
}
