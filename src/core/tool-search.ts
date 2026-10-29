/**
 * Lexical tool search — the retrieval half of the tool gateway.
 *
 * An MCP client embeds every tool's name+description and feeds the model only
 * the top-N most similar to the request; past ~100 tools the right one routinely
 * falls below the cut. This module replaces that generic, opaque ranking with a
 * deterministic, tunable one over OUR index: tokens are weighted by the field
 * they hit (name ≫ title ≫ module ≫ description), rare tokens count for more
 * (IDF), exact tool-name and phrase matches are boosted, and an opposed-domain
 * penalty resolves the IPv4-vs-IPv6 ambiguity that makes a generic name like
 * `create_filter_rule` lose to its `*_ipv6_*` twin.
 *
 * Pure and offline — no model, no network, no extra deps — so it is fast,
 * unit-testable, and fits the Bun-native "no surprise dependencies" ethos. The
 * gateway (`src/tools/tool-gateway.ts`) builds the index from the live catalog
 * and calls {@link searchToolIndex}; this file knows nothing about the catalog.
 */

/** The minimal per-tool record the index needs (decoupled from the registry). */
export interface ToolForIndex {
  name: string;
  title: string;
  description: string;
  /** Owning module slug (e.g. `firewall-filter`). */
  module: string;
  /** Owning module group (e.g. `Addressing & Routing`). */
  group: string;
  /** Input parameter names (for the model to shape an invoke_tool call). */
  params: string[];
}

interface IndexedEntry extends ToolForIndex {
  nameTokens: Set<string>;
  titleTokens: Set<string>;
  moduleTokens: Set<string>;
  descTokens: Set<string>;
  allTokens: Set<string>;
}

export interface ToolSearchIndex {
  entries: IndexedEntry[];
  /** Document frequency per token (how many tools contain it). */
  df: Map<string, number>;
  /** Total number of indexed tools. */
  n: number;
}

export interface ScoredTool extends ToolForIndex {
  /** Relevance score (higher is better); only positive scores are returned. */
  score: number;
}

/** Lowercase + split on any non-alphanumeric run (so snake_case splits cleanly). */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const tokenSet = (text: string): Set<string> => new Set(tokenize(text));

/**
 * CRUD-verb synonyms. RouterOS tools name the same operation inconsistently
 * (`create_filter_rule` vs `add_dhcp_lease`), so a user who says "add a filter
 * rule" must still match the `create_*` tool. Query tokens are expanded with
 * their synonym class before scoring; kept to verbs only to avoid false matches.
 */
const SYNONYMS: Record<string, string[]> = {
  add: ["create", "new"],
  create: ["add", "new"],
  new: ["add", "create"],
  remove: ["delete", "del", "drop"],
  delete: ["remove", "del", "drop"],
  del: ["remove", "delete"],
  drop: ["remove", "delete"],
  list: ["show", "print"],
  show: ["list", "print", "get"],
  print: ["list", "show"],
  get: ["show", "fetch"],
  read: ["get", "list", "show"],
  fetch: ["get"],
  update: ["set", "modify", "change", "edit"],
  set: ["update", "modify", "change"],
  modify: ["update", "set", "change"],
  change: ["update", "set", "modify"],
  edit: ["update", "set", "modify"],
};

/** Expand query tokens with their CRUD-verb synonyms (union, deduped). */
function expandQuery(tokens: string[]): Set<string> {
  const out = new Set(tokens);
  for (const t of tokens) for (const s of SYNONYMS[t] ?? []) out.add(s);
  return out;
}

/** Build a search index from the flattened tool list. Pure; O(total tokens). */
export function buildToolIndex(tools: ToolForIndex[]): ToolSearchIndex {
  const entries: IndexedEntry[] = tools.map((t) => {
    const nameTokens = tokenSet(t.name);
    const titleTokens = tokenSet(t.title);
    const moduleTokens = new Set([...tokenize(t.module), ...tokenize(t.group)]);
    const descTokens = tokenSet(t.description);
    const allTokens = new Set([...nameTokens, ...titleTokens, ...moduleTokens, ...descTokens]);
    return { ...t, nameTokens, titleTokens, moduleTokens, descTokens, allTokens };
  });

  const df = new Map<string, number>();
  for (const e of entries) {
    for (const tok of e.allTokens) df.set(tok, (df.get(tok) ?? 0) + 1);
  }
  return { entries, df, n: entries.length };
}

// Field weights — a token in the tool NAME is the strongest signal of intent,
// then its display title, then the module/group it lives in, then prose.
const FIELD_WEIGHT = { name: 6, title: 3.5, module: 3, desc: 1.5 } as const;

/** Inverse document frequency — rare tokens (wireguard) outweigh common ones (list). */
function idf(df: Map<string, number>, n: number, token: string): number {
  return Math.log(1 + n / ((df.get(token) ?? 0) + 1));
}

/**
 * Resolve a tool's IP version from its NAME + MODULE only — these are
 * authoritative (`create_ipv6_filter_rule` in `ipv6-firewall-filter`). The
 * description is deliberately excluded: IPv6 tools often cross-reference "IPv4"
 * in prose, which would otherwise make a tool look like it serves both versions.
 */
function entryVersion(entry: IndexedEntry): { v4: boolean; v6: boolean } {
  const v4 = entry.nameTokens.has("ipv4") || entry.moduleTokens.has("ipv4");
  const v6 =
    entry.nameTokens.has("ipv6") ||
    entry.moduleTokens.has("ipv6") ||
    entry.nameTokens.has("v6") ||
    entry.moduleTokens.has("v6");
  return { v4, v6 };
}

/**
 * Bias a tool by how its IP version matches the query's:
 *   • Query asks IPv4 → crush IPv6-only twins (the documented shadowing fix).
 *   • Query asks IPv6 → crush IPv4-only twins.
 *   • Query is version-neutral → gently prefer the generic/IPv4 tool (IPv4 is
 *     the default a user means when they don't say), so an IPv6-only tool's
 *     extra rare `ipv6` token can't float it above its plain counterpart.
 */
function domainFactor(entry: IndexedEntry, qTokens: Set<string>): number {
  const qV4 = qTokens.has("ipv4") || qTokens.has("v4");
  const qV6 = qTokens.has("ipv6") || qTokens.has("v6");
  const { v4: eV4, v6: eV6 } = entryVersion(entry);
  if (qV4 && !qV6) return eV6 && !eV4 ? 0.15 : 1;
  if (qV6 && !qV4) return eV4 && !eV6 ? 0.15 : 1;
  return eV6 && !eV4 ? 0.85 : 1;
}

/**
 * Rank the index against `query`, returning the top `limit` tools by score.
 * Deterministic: equal scores keep catalog order. Tools scoring ≤0 are dropped.
 */
export function searchToolIndex(index: ToolSearchIndex, query: string, limit = 8): ScoredTool[] {
  const qRaw = query.trim().toLowerCase();
  const qList = tokenize(query);
  if (qList.length === 0) return [];
  const qOriginal = new Set(qList);
  const qTokens = expandQuery(qList);
  const qUnderscored = qRaw.replace(/\s+/g, "_");

  // A query token counts as "in name" if the name has it OR any of its synonyms.
  const nameHasIntent = (entry: IndexedEntry, t: string): boolean =>
    entry.nameTokens.has(t) || (SYNONYMS[t] ?? []).some((s) => entry.nameTokens.has(s));

  const scored = index.entries.map((entry, i) => {
    let s = 0;
    for (const t of qTokens) {
      const weight =
        (entry.nameTokens.has(t) ? FIELD_WEIGHT.name : 0) +
        (entry.titleTokens.has(t) ? FIELD_WEIGHT.title : 0) +
        (entry.moduleTokens.has(t) ? FIELD_WEIGHT.module : 0) +
        (entry.descTokens.has(t) ? FIELD_WEIGHT.desc : 0);
      if (weight > 0) s += idf(index.df, index.n, t) * weight;
    }

    // Coverage: reward a tool whose NAME contains all (original) query tokens.
    const inName = [...qOriginal].filter((t) => nameHasIntent(entry, t)).length;
    s += (inName / qOriginal.size) * 4;

    // Exact / near-exact tool-name match — the strongest possible signal.
    const name = entry.name.toLowerCase();
    if (qRaw === name || qUnderscored === name) s += 100;
    else if (name.includes(qUnderscored) || qUnderscored.includes(name)) s += 8;

    // Phrase match in the human title.
    if (qRaw.length > 2 && entry.title.toLowerCase().includes(qRaw)) s += 3;

    s *= domainFactor(entry, qTokens);
    return { entry, s, i };
  });

  return scored
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, Math.max(1, limit))
    .map((r) => ({
      name: r.entry.name,
      title: r.entry.title,
      description: r.entry.description,
      module: r.entry.module,
      group: r.entry.group,
      params: r.entry.params,
      score: Math.round(r.s * 100) / 100,
    }));
}
