/** Shared contracts for evidence-aware memory. No device or database imports. */
import { z } from "zod";

export const memoryKinds = ["fact", "constraint", "lesson", "preference", "procedure"] as const;
const name = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1).max(8000);
export const memoryScopes = ["device", "group", "shared"] as const;
export type MemoryScopeKind = (typeof memoryScopes)[number];
export const ScopeSchema = z
  .object({
    entityName: name,
    scope: z.enum(memoryScopes),
    members: z.array(name).max(100).default([]),
    expectedRevision: z.number().int().min(0),
    confirmSharing: z.boolean().default(false),
  })
  .strict();
export type ScopeInput = z.infer<typeof ScopeSchema>;
export interface MemoryScope {
  entityName: string;
  scope: MemoryScopeKind;
  members: string[];
  revision: number;
}
export const RememberSchema = z
  .object({
    entityName: name,
    content: text,
    key: z.string().trim().min(1).max(120).nullable().optional(),
    kind: z.enum(memoryKinds).default("fact"),
    source: z.string().trim().min(1).max(500).default("unspecified"),
    confidence: z.number().min(0).max(1).default(0.5),
    pinned: z.boolean().default(false),
    expiresAt: z.number().int().positive().nullable().default(null),
  })
  .strict();
export const ReviseSchema = z
  .object({
    id: z.number().int().positive(),
    expectedRevision: z.number().int().positive(),
    content: text.optional(),
    kind: z.enum(memoryKinds).optional(),
    source: z.string().trim().min(1).max(500).optional(),
    confidence: z.number().min(0).max(1).optional(),
    pinned: z.boolean().optional(),
    expiresAt: z.number().int().positive().nullable().optional(),
    status: z.enum(["active", "archived"]).optional(),
    verified: z.literal(true).optional(),
  })
  .strict();
export const RecallSchema = z
  .object({
    query: z.string().trim().max(500).default(""),
    entityName: name.optional(),
    limit: z.number().int().min(1).max(50).default(12),
    maxChars: z.number().int().min(500).max(16000).default(6000),
    includeRelated: z.boolean().default(true),
  })
  .strict();
export const BrowseSchema = z
  .object({
    query: z.string().trim().max(500).default(""),
    entityName: name.optional(),
    scope: z.enum(memoryScopes).optional(),
    kind: z.enum(memoryKinds).optional(),
    state: z.enum(["active", "review", "pinned", "archived", "all"]).default("active"),
    limit: z.number().int().min(1).max(100).default(30),
    offset: z.number().int().min(0).max(1000000).default(0),
  })
  .strict();
export type RememberInput = z.infer<typeof RememberSchema>;
export type ReviseInput = z.infer<typeof ReviseSchema>;
export type RecallInput = z.infer<typeof RecallSchema>;
export type BrowseInput = z.infer<typeof BrowseSchema>;
export interface MemoryFact extends RememberInput {
  scope: MemoryScopeKind;
  id: number;
  key: string | null;
  status: "active" | "archived";
  createdAt: number;
  updatedAt: number;
  verifiedAt: number | null;
  revision: number;
}
export interface MemoryRevision {
  id: number;
  changedAt: number;
  action: string;
  fact: MemoryFact;
}
export interface MemoryPage {
  items: MemoryFact[];
  total: number;
  limit: number;
  offset: number;
}
export interface MemoryHealth {
  active: number;
  archived: number;
  expired: number;
  unverified: number;
  stale: number;
  pinned: number;
  review: number;
}
export interface MemoryRecall {
  items: (MemoryFact & {
    reasons: string[];
    applicability: "applicable" | "related" | "library";
  })[];
  context: string;
  truncated: boolean;
  warnings: string[];
  applicableScopes: MemoryScope[];
  conflicts: {
    key: string;
    memories: { id: number; entityName: string; scope: MemoryScopeKind }[];
  }[];
  constraintsOmitted: number;
}
export const STALE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;
export function reviewReasons(fact: MemoryFact, now = Date.now()): string[] {
  const reasons: string[] = [];
  if (fact.expiresAt !== null && fact.expiresAt <= now) reasons.push("Expired");
  if (fact.verifiedAt === null) reasons.push("Not verified");
  if (now - (fact.verifiedAt ?? fact.updatedAt) > STALE_AFTER_MS) reasons.push("Review overdue");
  if (fact.confidence < 0.5) reasons.push("Low confidence");
  return reasons;
}

/** Quote tokens, never interpret caller text as FTS query syntax. */
export function memoryMatch(query: string): string | null {
  const tokens =
    query
      .normalize("NFKC")
      .match(/[\p{L}\p{N}_]+/gu)
      ?.slice(0, 16) ?? [];
  return tokens.length ? tokens.map((word) => `"${word}"*`).join(" OR ") : null;
}

/** Memory is not a credential vault. Reject common pasted credential formats. */
export function assertMemorySafe(...values: string[]): void {
  const value = values.join("\n");
  if (
    /-----BEGIN[^\n]*PRIVATE KEY-----|\b(?:password|passwd|private[-_ ]?key|api[-_ ]?key|access[-_ ]?token|secret)\s*[:=]\s*["']?[^\s"']+|\bBearer\s+[A-Za-z0-9._~+/-]{12,}/i.test(
      value,
    )
  ) {
    throw new Error(
      "Memory is not a credential vault. Remove passwords, private keys and tokens before saving.",
    );
  }
}
