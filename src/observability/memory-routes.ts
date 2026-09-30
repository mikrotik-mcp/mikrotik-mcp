/** Knowledge memory API. Shared validation and store logic also serve the MCP tools. */
import { z } from "zod";
import { getConfig, setConfig } from "../core/runtime";
import { getConfigSource } from "../config";
import { atomicWrite, serializeConfig } from "../config-write";
import { closeMemoryStore, getMemoryStore, installMemoryStore } from "../memory/accessor";
import { openMemoryStore } from "../memory/store";
import { BrowseSchema, RecallSchema, RememberSchema, ReviseSchema } from "../memory/knowledge";
export { closeMemoryStore };

const name = z.string().trim().min(1).max(200);
const content = z.string().trim().min(1).max(8000);
const relation = z.object({ from: name, to: name, relationType: name }).strict();
const list = <T extends z.ZodType>(schema: T) => z.array(schema).min(1).max(100);
const count = (value: string | null, fallback: number, max: number) =>
  z.coerce
    .number()
    .int()
    .min(0)
    .max(max)
    .parse(value ?? fallback);
let configuring = false;
function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}
async function body(req: Request): Promise<unknown> {
  const raw = await req.text();
  if (raw.length > 256_000) throw new Error("Memory request is too large");
  return JSON.parse(raw);
}

export async function memoryRoutes(req: Request, url: URL): Promise<Response | null> {
  const p = url.pathname;
  if (!p.startsWith("/api/memory/")) return null;
  try {
    const cfg = getConfig();
    if (p === "/api/memory/config" && req.method === "GET") {
      // Keep settings reachable even when a configured database cannot be opened.
      let stats = null;
      if (cfg.memory.enabled) {
        try {
          stats = (await getMemoryStore()).stats();
        } catch {
          /* Summary reports storage errors. */
        }
      }
      return json({
        ...cfg.memory,
        stats,
      });
    }
    if (p === "/api/memory/config" && req.method === "POST") {
      if (configuring)
        return json({ error: "Memory configuration is being saved. Retry shortly." }, 409);
      const update = z
        .object({
          dbPath: z.string().trim().min(1).max(4096).optional(),
          enabled: z.boolean().optional(),
        })
        .strict()
        .parse(await body(req));
      configuring = true;
      try {
        const next = { ...cfg, memory: { ...cfg.memory, ...update } };
        if (next.memory.enabled === cfg.memory.enabled && next.memory.dbPath === cfg.memory.dbPath)
          return json({ ok: true, ...cfg.memory });
        const prepared = next.memory.enabled ? await openMemoryStore(next.memory.dbPath) : null;
        try {
          atomicWrite(getConfigSource().path, serializeConfig(next));
        } catch {
          prepared?.close();
          return json(
            {
              error:
                "Could not persist memory configuration; the previous configuration is still active.",
            },
            500,
          );
        }
        setConfig(next);
        if (prepared) installMemoryStore(prepared);
        else closeMemoryStore();
        return json({ ok: true, ...next.memory, stats: prepared?.stats() ?? null });
      } finally {
        configuring = false;
      }
    }
    if (!cfg.memory.enabled)
      return json({ error: "Knowledge memory is disabled. Enable it in Memory settings." }, 503);
    const store = await getMemoryStore();
    if (p === "/api/memory/summary" && req.method === "GET")
      return json({ stats: store.stats(), health: store.health() });
    if (p === "/api/memory/facts" && req.method === "GET") {
      const values = Object.fromEntries(url.searchParams);
      delete values.token;
      return json(
        store.facts(
          BrowseSchema.parse({
            ...values,
            limit: count(url.searchParams.get("limit"), 30, 100),
            offset: count(url.searchParams.get("offset"), 0, 1000000),
          }),
        ),
      );
    }
    if (p === "/api/memory/facts" && req.method === "POST")
      return json(store.remember(RememberSchema.parse(await body(req))));
    if (p === "/api/memory/facts/revise" && req.method === "POST")
      return json(store.revise(ReviseSchema.parse(await body(req))));
    if (p === "/api/memory/recall" && req.method === "POST")
      return json(store.recall(RecallSchema.parse(await body(req))));
    const history = p.match(/^\/api\/memory\/facts\/(\d+)\/history$/);
    if (history && req.method === "GET")
      return json(store.history(z.coerce.number().int().positive().parse(history[1])));
    if (p === "/api/memory/entities" && req.method === "GET")
      return json(
        store.listEntities(
          z
            .string()
            .max(500)
            .parse(url.searchParams.get("q") ?? ""),
          count(url.searchParams.get("limit"), 100, 100),
          count(url.searchParams.get("offset"), 0, 1000000),
        ),
      );
    // Compatibility endpoints for existing clients, including Raycast.
    if (p === "/api/memory/graph" && req.method === "GET") return json(store.readGraph());
    if (p === "/api/memory/stats" && req.method === "GET") return json(store.stats());
    if (p === "/api/memory/search" && req.method === "GET")
      return json(
        store.searchNodes(
          z
            .string()
            .max(500)
            .parse(url.searchParams.get("q") ?? ""),
          count(url.searchParams.get("limit"), 50, 100),
        ),
      );
    if (p === "/api/memory/activity" && req.method === "GET")
      return json(
        store.activity(
          count(url.searchParams.get("limit"), 50, 100),
          url.searchParams.has("since")
            ? count(url.searchParams.get("since"), 0, Number.MAX_SAFE_INTEGER)
            : undefined,
          url.searchParams.get("changesOnly") === "true",
        ),
      );
    const entity = p.match(/^\/api\/memory\/entity\/(.+)$/);
    if (entity && req.method === "GET") {
      const graph = store.openNodes([name.parse(decodeURIComponent(entity[1]))]);
      return graph.entities.length
        ? json({ entity: graph.entities[0], relations: graph.relations })
        : json({ error: "Entity not found" }, 404);
    }
    if (p === "/api/memory/entities" && req.method === "POST") {
      const data = z
        .object({
          entities: list(
            z
              .object({
                name,
                entityType: name,
                observations: z.array(content).max(100).optional(),
              })
              .strict(),
          ),
        })
        .strict()
        .parse(await body(req));
      const created = store.createEntities(data.entities);
      return json({ created, count: created.length });
    }
    if (p === "/api/memory/relations" && (req.method === "POST" || req.method === "DELETE")) {
      const data = z
        .object({ relations: list(relation) })
        .strict()
        .parse(await body(req));
      if (req.method === "DELETE") return json({ removed: store.deleteRelations(data.relations) });
      const created = store.createRelations(data.relations);
      return json({ created, count: created.length });
    }
    if (p === "/api/memory/observations" && req.method === "POST") {
      const data = z
        .object({
          observations: list(z.object({ entityName: name, contents: list(content) }).strict()),
        })
        .strict()
        .parse(await body(req));
      return json({ results: store.addObservations(data.observations) });
    }
    if (p === "/api/memory/entities" && req.method === "DELETE") {
      const data = z
        .object({ names: list(name) })
        .strict()
        .parse(await body(req));
      return json({ removed: store.deleteEntities(data.names) });
    }
    if (p === "/api/memory/observations" && req.method === "DELETE") {
      const data = z
        .object({
          deletions: list(z.object({ entityName: name, observations: list(content) }).strict()),
        })
        .strict()
        .parse(await body(req));
      return json({ removed: store.deleteObservations(data.deletions) });
    }
    return json({ error: "Unknown memory endpoint or method" }, 404);
  } catch (error) {
    if (error instanceof z.ZodError)
      return json(
        { error: error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") },
        400,
      );
    if (error instanceof SyntaxError || error instanceof URIError)
      return json({ error: "Invalid memory request" }, 400);
    const message = error instanceof Error ? error.message : "Memory operation failed";
    if (message.includes("UNIQUE constraint"))
      return json(
        { error: "This entity already has an identical memory. Edit the existing record." },
        409,
      );
    if (message.includes("changed since")) return json({ error: message }, 409);
    if (/not found|credential vault|already exists|too large/.test(message))
      return json({ error: message }, 400);
    return json(
      { error: "Memory storage is unavailable. Check its path and permissions, then retry." },
      503,
    );
  }
}
