/**
 * Knowledge graph memory — shared type definitions.
 *
 * These are pure interfaces consumed by the store, the MCP tools and the
 * dashboard routes. Nothing here imports `bun:sqlite` (even as a type), so the
 * module is safe for the Node/Vitest import graph.
 */

/** A named node in the knowledge graph. */
export interface Entity {
  memoryScope?: "device" | "group" | "shared";
  name: string;
  entityType: string;
  observations: string[];
  createdAt: number;
  updatedAt: number;
}

/** A directed, typed edge between two entities. */
export interface Relation {
  from: string;
  to: string;
  relationType: string;
  createdAt: number;
}

/** The full knowledge graph: all entities (with observations) and relations. */
export interface KnowledgeGraph {
  entities: Entity[];
  relations: Relation[];
}

/** One entry in the mutation activity log. */
export interface MemoryActivity {
  id: number;
  ts: number;
  action: string;
  subject: string;
  detail?: string;
}

/** Aggregate statistics for the dashboard. */
export interface MemoryStats {
  entities: number;
  relations: number;
  observations: number;
  entityTypes: { type: string; count: number }[];
  relationTypes: { type: string; count: number }[];
  recentActivity: MemoryActivity[];
}
