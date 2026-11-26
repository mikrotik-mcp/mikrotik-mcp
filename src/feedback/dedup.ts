/**
 * Deterministic multi-stage deduplication engine for LLM tool feedback.
 *
 * Ensures that when multiple AI sessions hit the same bug, missing capability,
 * or schema confusion (even with different IP addresses, interface names, or
 * slightly different wording), the report maps onto the existing issue and
 * increments its `occurrences` counter instead of flooding the operator with
 * duplicate tickets.
 */
import { createHash } from "node:crypto";
import type { FeedbackImpact, FeedbackIssue, FeedbackKind } from "./types";

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "can",
  "cannot",
  "could",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "in",
  "into",
  "is",
  "it",
  "its",
  "not",
  "of",
  "on",
  "or",
  "should",
  "so",
  "such",
  "that",
  "the",
  "their",
  "then",
  "there",
  "these",
  "this",
  "to",
  "tool",
  "tools",
  "was",
  "were",
  "when",
  "which",
  "while",
  "with",
  "would",
  "mikrotik",
  "router",
  "routeros",
  "mcp",
  "server",
]);

/**
 * Normalize an operation name (MCP tool name or RouterOS CLI path):
 * - Strips MCP host prefixes such as `mcp__mikrotik-mcp__` or `mikrotik:`.
 * - Converts RouterOS space-separated paths (`/ip firewall filter`) to `/ip/firewall/filter`.
 * - Lowercases and trims.
 */
export function normalizeOperation(op: string | null | undefined): string {
  if (!op) return "";
  let s = op.trim().toLowerCase();
  if (!s) return "";
  // Strip mcp__<server>__<tool> or <server>:<tool>
  s = s.replace(/^mcp__[a-z0-9_-]+__/i, "");
  s = s.replace(/^[a-z0-9_-]+:(?=[a-z0-9_]+)/i, "");
  // Normalize RouterOS CLI path if it starts with /
  if (s.startsWith("/")) {
    s = s
      .replace(/\s+(print|add|set|remove|enable|disable|find|export|get)\b.*$/i, "")
      .replace(/\s+/g, "/")
      .replace(/\/+/g, "/")
      .replace(/\/$/, "");
  }
  return s;
}

/**
 * Strip volatile runtime tokens (IPv4/IPv6 addresses, CIDRs, MACs, RouterOS `*1A` IDs,
 * UUIDs, hex hashes, line/column numbers, timestamps, and interface indices) so errors
 * and titles from different devices normalize to the same skeleton.
 */
export function stripVolatileTokens(text: string | null | undefined): string {
  if (!text) return "";
  return (
    text
      .normalize("NFKC")
      .toLowerCase()
      // UUIDs
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
      // MAC addresses
      .replace(/\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi, "<mac>")
      // IPv4 + optional CIDR or port
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2}|:\d{1,5})?\b/g, "<ip>")
      // IPv6 (with at least two colons and hex segments)
      .replace(/\b(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?:\/\d{1,3})?\b/gi, "<ip6>")
      // RouterOS internal IDs like *1, *1a, *ffffffff
      .replace(/(?:^|[\s=()[\],])\*[0-9a-f]{1,8}\b/gi, " <id>")
      // Line and column numbers in RouterOS parser errors: (line 1 column 24)
      .replace(/\(line\s+\d+\s+column\s+\d+\)/gi, "(line <n> column <n>)")
      .replace(/\bline\s+\d+\b/gi, "line <n>")
      .replace(/\bcolumn\s+\d+\b/gi, "column <n>")
      // Quoted RouterOS interface/device literals like ether1, vlan100, wg0, bridge1
      .replace(
        /\b(ether|sfp|sfp-sfpplus|wlan|wifi|vlan|bridge|wg|wireguard|ovpn|pppoe|eoip|gre|l2tp|sstp)\d+\b/gi,
        "$1<n>",
      )
      // Standalone numbers
      .replace(/\b\d+\b/g, "<n>")
      // Collapse punctuation & whitespace
      .replace(/[^\p{L}\p{N}<>_/-]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Extract canonical stem tokens for set-based and TF similarity.
 * Also splits `snake_case` and `kebab-case` identifiers so `create_wireguard_peer`
 * and `"WireGuard peer creation"` share their underlying domain words.
 */
export function tokenizeCanonical(text: string | null | undefined): string[] {
  const stripped = stripVolatileTokens(text).replace(/<(?:ip|ip6|mac|uuid|id|n)>/g, " ");
  const raw = stripped.match(/[\p{L}\p{N}_/-]{2,}/gu) ?? [];
  const out: string[] = [];
  const pushWord = (w: string) => {
    const clean = w.replace(/^[-_/]+|[-_/]+$/g, "");
    if (clean.length < 2 || STOP_WORDS.has(clean)) return;
    out.push(simpleStem(clean));
  };
  for (const word of raw) {
    pushWord(word);
    if (/[-_/]/.test(word)) {
      for (const part of word.split(/[-_/]+/)) {
        if (part !== word) pushWord(part);
      }
    }
  }
  return out;
}

function simpleStem(word: string): string {
  if (word.length <= 4) return word;
  if (word.endsWith("ation") && word.length > 6) return word.slice(0, -5);
  if (word.endsWith("tion") && word.length > 6) return word.slice(0, -3);
  if (word.endsWith("ies") && word.length > 5) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3);
  if (word.endsWith("ed") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("es") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 4) return word.slice(0, -1);
  if (word.endsWith("e") && word.length > 4) return word.slice(0, -1);
  return word;
}

/**
 * Compute the deterministic Stage-1 SHA-256 fingerprint from `(kind, normalizedOperation, canonicalSignature)`.
 */
export function computeFeedbackFingerprint(input: {
  kind: FeedbackKind;
  operation?: string | null;
  title: string;
  actualError?: string | null;
}): string {
  const op = normalizeOperation(input.operation) || "global";
  const errSkeleton = stripVolatileTokens(input.actualError);
  const titleTokens = [...new Set(tokenizeCanonical(input.title))].sort().join(" ");
  const basis = errSkeleton
    ? `${input.kind}|${op}|err:${errSkeleton}|${titleTokens}`
    : `${input.kind}|${op}|title:${titleTokens}`;
  return createHash("sha256").update(basis).digest("hex").slice(0, 32);
}

/** Jaccard + Dice hybrid token overlap in [0, 1]. */
export function tokenSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  if (intersection === 0) return 0;
  const union = setA.size + setB.size - intersection;
  const jaccard = intersection / union;
  const dice = (2 * intersection) / (setA.size + setB.size);
  return jaccard * 0.5 + dice * 0.5;
}

/** Character 3-gram Dice similarity for catching typos or hyphenation differences. */
export function trigramSimilarity(a: string, b: string): number {
  const s1 = a.trim().toLowerCase();
  const s2 = b.trim().toLowerCase();
  if (!s1 && !s2) return 1;
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;
  if (s1.length < 3 || s2.length < 3) return s1 === s2 ? 1 : 0;
  const grams = (s: string): Set<string> => {
    const out = new Set<string>();
    for (let i = 0; i <= s.length - 3; i++) out.add(s.slice(i, i + 3));
    return out;
  };
  const g1 = grams(s1);
  const g2 = grams(s2);
  let inter = 0;
  for (const g of g1) if (g2.has(g)) inter++;
  return (2 * inter) / (g1.size + g2.size);
}

export interface DedupCandidateMatch {
  issue: FeedbackIssue;
  stage: "exact_fingerprint" | "fuzzy_similarity";
  similarity: number;
}

/**
 * Score how closely an incoming feedback report matches an existing stored issue.
 * Returns a score in `[0, 1]` and whether it meets the automatic merge threshold.
 */
export function scoreFeedbackSimilarity(
  incoming: {
    kind: FeedbackKind;
    operation?: string | null;
    title: string;
    detail: string;
    actualError?: string | null;
  },
  existing: Pick<FeedbackIssue, "kind" | "operation" | "title" | "detail" | "actualError">,
): { score: number; matches: boolean } {
  const opA = normalizeOperation(incoming.operation);
  const opB = normalizeOperation(existing.operation);
  const sameOp = Boolean(opA && opB && opA === opB);
  const differentExplicitOp = Boolean(opA && opB && opA !== opB);

  // Two reports targeting explicitly different tools are almost never duplicates
  // unless one is a direct prefix/alias of the other.
  if (differentExplicitOp) {
    return { score: 0, matches: false };
  }

  const errA = stripVolatileTokens(incoming.actualError);
  const errB = stripVolatileTokens(existing.actualError);
  const bothHaveErr = Boolean(errA && errB);
  const errSim = bothHaveErr
    ? Math.max(
        tokenSimilarity(tokenizeCanonical(errA), tokenizeCanonical(errB)),
        trigramSimilarity(errA, errB),
      )
    : 0;

  // Fast-path: same operation and near-identical normalized error skeleton.
  if (sameOp && bothHaveErr && errSim >= 0.85) {
    return { score: Math.min(1, 0.88 + errSim * 0.12), matches: true };
  }

  const titleTokensA = tokenizeCanonical(incoming.title);
  const titleTokensB = tokenizeCanonical(existing.title);
  const titleTokenSim = tokenSimilarity(titleTokensA, titleTokensB);
  const titleGramSim = trigramSimilarity(
    stripVolatileTokens(incoming.title),
    stripVolatileTokens(existing.title),
  );
  const titleSim = Math.max(titleTokenSim, titleGramSim * 0.9);

  const bodyTokensA = tokenizeCanonical(`${incoming.title} ${incoming.detail}`);
  const bodyTokensB = tokenizeCanonical(`${existing.title} ${existing.detail}`);
  const bodySim = tokenSimilarity(bodyTokensA, bodyTokensB);

  const kindBonus = incoming.kind === existing.kind ? 1 : 0;
  const opScore = sameOp ? 1 : !opA && !opB ? 0.5 : 0.25;

  let score: number;
  if (bothHaveErr) {
    score = opScore * 0.25 + errSim * 0.35 + titleSim * 0.22 + bodySim * 0.1 + kindBonus * 0.08;
  } else {
    score = opScore * 0.25 + titleSim * 0.42 + bodySim * 0.23 + kindBonus * 0.1;
  }

  // Require stronger text overlap when no operation is specified.
  const threshold = sameOp && bothHaveErr && errSim >= 0.65 ? 0.55 : sameOp ? 0.64 : 0.72;
  const matches = score >= threshold && (titleSim >= 0.42 || bodySim >= 0.48 || errSim >= 0.75);

  return { score: Number(score.toFixed(4)), matches };
}

const IMPACT_RANK: Record<FeedbackImpact, number> = {
  suggestion: 1,
  friction: 2,
  degraded: 3,
  blocker: 4,
};

/** Return the higher of two impact severities when merging a duplicate occurrence. */
export function higherImpact(a: FeedbackImpact, b: FeedbackImpact): FeedbackImpact {
  return IMPACT_RANK[b] > IMPACT_RANK[a] ? b : a;
}
