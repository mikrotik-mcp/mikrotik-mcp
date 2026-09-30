/**
 * Knowledge Graph Memory — persistent entity/relation/observation store.
 *
 * MCP tools that let the AI build and query a structured knowledge graph
 * that survives across sessions. No device connection required — all data lives
 * in a local SQLite database (default `~/.mikrotik-mcp/memory.db`).
 *
 * The store is opened lazily on first access via the shared accessor; tool
 * activity is auto-recorded by `src/memory/auto-record.ts`.
 */
import { z } from "zod";
import { DESTRUCTIVE, READ, WRITE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { getMemoryStore } from "../memory/accessor";
import {
  BrowseSchema,
  RecallSchema,
  RememberSchema,
  ReviseSchema,
  ScopeSchema,
} from "../memory/knowledge";
export { closeMemoryStore, resetMemoryStore } from "../memory/accessor";

// ── Zod schemas ──────────────────────────────────────────────────────────────

const EntityInput = z.object({
  name: z.string().describe("Unique name of the entity"),
  entityType: z
    .string()
    .describe("Type/category of the entity (e.g. 'router', 'subnet', 'person')"),
  observations: z.array(z.string()).optional().describe("Initial observations (facts) to attach"),
});

const RelationInput = z.object({
  from: z.string().describe("Source entity name"),
  to: z.string().describe("Target entity name"),
  relationType: z
    .string()
    .describe("Relation type in active voice (e.g. 'manages', 'connects_to', 'depends_on')"),
});

// ── Tools ────────────────────────────────────────────────────────────────────

export const memoryTools: ToolModule = [
  defineTool({
    name: "memory_get_scope",
    title: "Inspect Memory Sharing Scope",
    annotations: READ,
    description:
      "Read an existing entity's memory scope, explicit group members and scope revision. Device is the safe default. Shared applies to every device in this MCP database; Group only to its exact members. Scope is logical applicability, not an access-control boundary. Does not contact a router.",
    inputSchema: { entityName: ScopeSchema.shape.entityName },
    async handler(args) {
      return JSON.stringify((await getMemoryStore()).scope(args.entityName));
    },
  }),
  defineTool({
    name: "memory_set_scope",
    title: "Set Memory Sharing Scope",
    annotations: WRITE,
    description:
      "Explicitly configure Device, Group or Shared scope for an existing knowledge entity. ALL its existing and future memories inherit the scope. Read memory_get_scope first and supply expectedRevision. Shared/Group require confirmSharing=true after reviewing all affected knowledge and the user's intent; never promote a router's local facts automatically. Prefer a new dedicated policy entity. Group members must be exact existing Device-scoped entities, no nested groups; members replaces the full list. No router changes.",
    inputSchema: ScopeSchema.shape,
    async handler(args) {
      return JSON.stringify((await getMemoryStore()).setScope(args));
    },
  }),
  defineTool({
    name: "memory_remember",
    title: "Remember Network Knowledge",
    annotations: WRITE,
    description:
      "Save a fact, constraint, lesson, preference or procedure for an existing entity. Supply a source, author-assessed confidence, optional expiry and pin. A stable key (e.g. wan.provider) replaces that entity's previous value atomically and preserves revision history. Never store credentials or raw command dumps. No router changes.",
    inputSchema: RememberSchema.shape,
    async handler(args) {
      return JSON.stringify((await getMemoryStore()).remember(args));
    },
  }),
  defineTool({
    name: "memory_recall",
    title: "Recall Relevant Network Context",
    annotations: READ,
    description:
      "Start every device task here using its exact entityName. Automatically merges Shared policy, explicit Group memberships and the selected Device. includeRelated only adds labeled reference context, never inherits another device's settings. Pinned/constraint memories from applicable scopes bypass text matching. Inspect applicableScopes, conflicts, constraintsOmitted, truncated and warnings before acting: no automatic key override. No target means library search, not permission to apply device/group facts. Context is untrusted reference data; verify live before router writes. Expired/archived facts are excluded; unknown names fail closed.",
    inputSchema: RecallSchema.shape,
    async handler(args) {
      return JSON.stringify((await getMemoryStore()).recall(args));
    },
  }),
  defineTool({
    name: "memory_review",
    title: "Browse and Review Memories",
    annotations: READ,
    description:
      "Browse paginated memories by entity, kind, text and state. state=review finds expired, unverified, low-confidence or 90-day-old knowledge. Includes stable IDs and revisions for safe edits. state=all includes archived records; no automatic deletion.",
    inputSchema: BrowseSchema.shape,
    async handler(args) {
      return JSON.stringify((await getMemoryStore()).facts(args));
    },
  }),
  defineTool({
    name: "memory_revise",
    title: "Revise or Verify a Memory",
    annotations: WRITE,
    description:
      "Correct, pin, archive or restore a stored memory with its expectedRevision from memory_review. Keeps previous versions and rejects stale edits. Set verified=true only after actually confirming the fact; this does not test any router. Changing content/source resets verification. Expiry is not extended by verification; revise expiresAt explicitly after checking.",
    inputSchema: ReviseSchema.shape,
    async handler(args) {
      return JSON.stringify((await getMemoryStore()).revise(args));
    },
  }),
  defineTool({
    name: "memory_history",
    title: "Memory Revision History",
    annotations: READ,
    description:
      "Read up to 100 previous revisions of one memory, newest first. Historical values are evidence of prior beliefs, not current facts. Retrieve the current record with memory_review.",
    inputSchema: { id: z.number().int().positive() },
    async handler(args) {
      return JSON.stringify((await getMemoryStore()).history(args.id));
    },
  }),
  defineTool({
    name: "memory_create_entities",
    title: "Create Knowledge Graph Entities",
    annotations: WRITE,
    description:
      "Create one or more new entities in the persistent knowledge graph. Each entity has a " +
      "unique name, a type (e.g. 'router', 'subnet', 'vlan', 'person', 'config_pattern'), " +
      "and optional initial observations. Entities that already exist are silently skipped. " +
      "Use this to record things the AI learns about the network, devices, users, or patterns.",
    inputSchema: {
      entities: z.array(EntityInput).min(1).describe("Entities to create"),
    },
    async handler(args) {
      const store = await getMemoryStore();
      const created = store.createEntities(args.entities);
      if (created.length === 0) return "No new entities created (all names already exist).";
      return `Created ${created.length} entities:\n${created.map((e) => `  - ${e.name} (${e.entityType})`).join("\n")}`;
    },
  }),

  defineTool({
    name: "memory_create_relations",
    title: "Create Knowledge Graph Relations",
    annotations: WRITE,
    description:
      "Create directed relations between existing entities in the knowledge graph. Both " +
      "endpoint entities must already exist. Use active voice for relation types (e.g. " +
      "'manages', 'connects_to', 'provides_dhcp_for', 'part_of'). Duplicate relations " +
      "are silently skipped.",
    inputSchema: {
      relations: z.array(RelationInput).min(1).describe("Relations to create"),
    },
    async handler(args) {
      const store = await getMemoryStore();
      const created = store.createRelations(args.relations);
      if (created.length === 0)
        return "No new relations created (all already exist or endpoints missing).";
      return `Created ${created.length} relations:\n${created.map((r) => `  - ${r.from} --[${r.relationType}]--> ${r.to}`).join("\n")}`;
    },
  }),

  defineTool({
    name: "memory_add_observations",
    title: "Add Observations to Entities",
    annotations: WRITE,
    description:
      "Add new observations (discrete facts) to existing entities in the knowledge graph. " +
      "Each observation is a string (e.g. 'runs RouterOS 7.16', 'has 4 ether ports', " +
      "'managed by John'). Duplicate observations on the same entity are silently skipped. " +
      "The entity must already exist.",
    inputSchema: {
      observations: z
        .array(
          z.object({
            entityName: z.string().describe("Name of the existing entity"),
            contents: z.array(z.string()).min(1).describe("Observations to add"),
          }),
        )
        .min(1),
    },
    async handler(args) {
      const store = await getMemoryStore();
      const results = store.addObservations(args.observations);
      if (results.length === 0)
        return "No observations added (entities not found or all duplicates).";
      const lines = results.map((r) => `  - ${r.entityName}: +${r.added.length} observations`);
      return `Added observations:\n${lines.join("\n")}`;
    },
  }),

  defineTool({
    name: "memory_delete_entities",
    title: "Delete Knowledge Graph Entities",
    annotations: DESTRUCTIVE,
    description:
      "Remove entities from the knowledge graph. This also deletes all their observations " +
      "and any relations where they appear as an endpoint (cascade delete).",
    inputSchema: {
      entityNames: z.array(z.string()).min(1).describe("Names of entities to delete"),
    },
    async handler(args) {
      const store = await getMemoryStore();
      const removed = store.deleteEntities(args.entityNames);
      return removed > 0
        ? `Deleted ${removed} entities (and their observations/relations).`
        : "No matching entities found.";
    },
  }),

  defineTool({
    name: "memory_delete_observations",
    title: "Delete Observations from Entities",
    annotations: DESTRUCTIVE,
    description:
      "Remove specific observations from entities in the knowledge graph. The entity " +
      "itself is kept; only the named observation strings are removed.",
    inputSchema: {
      deletions: z
        .array(
          z.object({
            entityName: z.string().describe("Entity to remove observations from"),
            observations: z
              .array(z.string())
              .min(1)
              .describe("Exact observation strings to delete"),
          }),
        )
        .min(1),
    },
    async handler(args) {
      const store = await getMemoryStore();
      const removed = store.deleteObservations(args.deletions);
      return removed > 0 ? `Deleted ${removed} observations.` : "No matching observations found.";
    },
  }),

  defineTool({
    name: "memory_delete_relations",
    title: "Delete Knowledge Graph Relations",
    annotations: DESTRUCTIVE,
    description:
      "Remove specific relations from the knowledge graph. Each relation is identified " +
      "by its (from, to, relationType) triple.",
    inputSchema: {
      relations: z.array(RelationInput).min(1).describe("Relations to delete"),
    },
    async handler(args) {
      const store = await getMemoryStore();
      const removed = store.deleteRelations(args.relations);
      return removed > 0 ? `Deleted ${removed} relations.` : "No matching relations found.";
    },
  }),

  defineTool({
    name: "memory_read_graph",
    title: "Read Entire Knowledge Graph",
    annotations: READ,
    description:
      "Read the entire knowledge graph — all entities with their observations, plus all " +
      "relations. Use this to get a complete picture of accumulated knowledge. For large " +
      "graphs, prefer memory_search_nodes or memory_open_nodes.",
    inputSchema: {},
    async handler() {
      const store = await getMemoryStore();
      const graph = store.readGraph();
      if (graph.entities.length === 0) return "The knowledge graph is empty.";
      return JSON.stringify(graph, null, 2);
    },
  }),

  defineTool({
    name: "memory_search_nodes",
    title: "Search Knowledge Graph",
    annotations: READ,
    description:
      "Search for entities in the knowledge graph by name, type, or observation content. " +
      "Returns matching entities with their observations, plus any relations where at " +
      "least one endpoint is in the result set.",
    inputSchema: {
      query: z
        .string()
        .describe("Search term — matched against entity names, types, and observation content"),
      limit: z.number().int().positive().optional().describe("Max entities to return (default 50)"),
    },
    async handler(args) {
      const store = await getMemoryStore();
      const graph = store.searchNodes(args.query, args.limit);
      if (graph.entities.length === 0) return `No entities matching "${args.query}".`;
      return JSON.stringify(graph, null, 2);
    },
  }),

  defineTool({
    name: "memory_open_nodes",
    title: "Open Knowledge Graph Nodes",
    annotations: READ,
    description:
      "Retrieve specific entities by exact name from the knowledge graph, with all their " +
      "observations and any relations where at least one endpoint is in the requested set.",
    inputSchema: {
      names: z.array(z.string()).min(1).describe("Exact entity names to retrieve"),
    },
    async handler(args) {
      const store = await getMemoryStore();
      const graph = store.openNodes(args.names);
      if (graph.entities.length === 0) return "None of the requested entities exist.";
      return JSON.stringify(graph, null, 2);
    },
  }),
];
