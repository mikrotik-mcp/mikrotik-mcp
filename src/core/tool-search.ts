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
  /** The first word of every tool name: `list`, `add`, `enable`, `audit`… */
  verbs: Set<string>;
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
  analyze: ["audit", "inspect", "report", "calculate", "summarize"],
};

/**
 * Words people use for a RouterOS thing that the tools name differently. A
 * request for "nameservers" must reach the DNS tools, and "restart" the reboot
 * tool. One direction only (the user's word to the catalog's word), and only
 * where the catalog word is unambiguous.
 */
const DOMAIN_WORDS: Record<string, string[]> = {
  fw: ["firewall", "filter"],
  openvpn: ["ovpn"],
  ovpn: ["openvpn"],
  bandwidth: ["usage", "traffic", "bytes"],
  consumption: ["usage", "traffic", "bytes"],
  consumed: ["usage", "traffic", "bytes"],
  accounting: ["usage", "session", "sessions"],
  analytics: ["analyze", "usage"],
  statistics: ["analyze", "usage", "stats"],
  stats: ["analyze", "usage"],
  daily: ["usage", "analyze", "days"],
  history: ["usage", "analyze", "sessions"],
  historical: ["usage", "analyze", "sessions"],
  nameserver: ["dns"],
  nameservers: ["dns"],
  resolver: ["dns"],
  resolution: ["dns"],
  restart: ["reboot"],
  rename: ["identity"],
  hostname: ["identity"],
  masquerade: ["nat"],
  hide: ["nat", "masquerade"],
  kick: ["disconnect"],
  laptop: ["device"],
  phone: ["device"],
  pc: ["device"],
  computer: ["device"],
  machine: ["device"],
  machines: ["devices", "connected"],
  attached: ["connected"],
  storage: ["disk"],
  undo: ["rollback"],
  revert: ["rollback"],
  attacking: ["attacks", "attack"],
  hacked: ["attacks", "attack"],
  firmware: ["update", "upgrade"],
  holes: ["vulnerabilities", "advisories"],
  vulnerable: ["vulnerabilities", "advisories"],
  tunnel: ["wireguard", "vpn"],
  employee: ["user", "vpn"],
  remote: ["vpn"],
  slow: ["diagnose", "speed"],
  fixed: ["static"],
  forever: ["static"],
  gadgets: ["segment", "vlan"],
  iot: ["segment", "vlan"],
  separate: ["segment", "vlan", "zone"],
  timezone: ["clock"],
  time: ["clock"],
  ranges: ["address", "list"],
  happened: ["logs", "events"],
  channel: ["wifi", "channels"],
  radio: ["wifi", "wireless"],
  copy: ["backup", "snapshot"],
  answers: ["ping"],
  reachable: ["ping"],
  path: ["traceroute"],
  wireshark: ["capture", "sniffer"],
  nightly: ["scheduler", "schedule"],
  night: ["scheduler", "schedule"],
  job: ["scheduler", "schedule"],
  inside: ["forward", "nat"],
  codes: ["vouchers"],
  guests: ["hotspot", "vouchers"],
};

/** A table lookup that only own keys answer: a user can type "constructor". */
const own = (table: Record<string, string[]>, key: string): string[] =>
  Object.hasOwn(table, key) ? table[key]! : [];

/** Expand query tokens with verb synonyms and with the catalog's word for a user's word. */
function expandQuery(tokens: string[]): Set<string> {
  const out = new Set(tokens);
  for (const t of tokens) {
    for (const s of own(SYNONYMS, t)) out.add(s);
    for (const s of own(DOMAIN_WORDS, t)) out.add(s);
  }
  return out;
}

/**
 * Words that say nothing about which tool is meant. "router" is one of them:
 * every tool is about the router, and the word would only match the modules
 * that have it in their name.
 */
const FILLER = new Set(
  (
    "a an the my me i we you your our it its is are was be of for by with and or that this these " +
    "those there please can could would should will want like need do does did go ahead thank " +
    "thanks very much every single how what which who why when where whether if then so just " +
    "also currently now have has had router routers mikrotik routeros"
  ).split(" "),
);

/** More words than this in one request are not read. */
const MAX_QUERY_WORDS = 64;

/** True when `a` becomes `b` with one letter changed, added, removed, or two neighbours swapped. */
function oneEditApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const rest = (x: number, y: number): boolean => a.slice(i + x) === b.slice(i + y);
  return (
    rest(1, 1) || rest(1, 0) || rest(0, 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && rest(2, 2))
  );
}

/**
 * A word the catalog does not have, as the catalog's word or words: another
 * form of it ("removed", "neighbours"), two words written as one ("ipaddress"),
 * or a typing mistake ("wiregaurd"). The word itself when nothing fits.
 */
function repairWord(word: string, df: Map<string, number>): string[] {
  const forms = [
    word.replace(/ing$/, ""),
    word.replace(/ing$/, "e"),
    word.replace(/ed$/, ""),
    word.replace(/d$/, ""),
    word.replace(/ies$/, "y"),
    word.replace(/es$/, ""),
    word.replace(/s$/, ""),
    word.replace("our", "or"),
  ];
  const form = forms.find((f) => f !== word && df.has(f));
  if (form) return [form];
  if (word.length > 30) return [word];
  // The split with the longest shorter half: "ipaddress" is ip + address.
  for (let cut = Math.floor(word.length / 2), step = 0; step < word.length; step++) {
    const at = cut + (step % 2 === 0 ? step / 2 : -(step + 1) / 2);
    if (at < 2 || at > word.length - 2) continue;
    if (df.has(word.slice(0, at)) && df.has(word.slice(at)))
      return [word.slice(0, at), word.slice(at)];
  }
  if (word.length < 4 || /^\d+$/.test(word)) return [word];
  let best: string | undefined;
  for (const [known, count] of df) {
    if (known[0] !== word[0] || known.length < 4 || !oneEditApart(word, known)) continue;
    if (!best || count > df.get(best)!) best = known;
  }
  return [best ?? word];
}

/**
 * The words of a request as the index can match them: identifiers split
 * ("listIpAddresses"), "turn off" and "switch on" as the verbs the tools use,
 * unknown words repaired, and filler words left out.
 */
function queryWords(query: string, df: Map<string, number>): string[] {
  let words = query
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .slice(0, MAX_QUERY_WORDS)
    .flatMap((raw) => {
      const lower = raw.toLowerCase();
      if (df.has(lower)) return [lower];
      return raw
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(" ");
    });
  // "turn off" / "switch off" is disable, "turn on" is enable, "power off" is shutdown.
  const verb = ["turn", "power", "switch"].find((v) => words.includes(v));
  const state = ["off", "down", "on"].find((p) => words.includes(p));
  if (verb && state && (verb !== "power" || state !== "on")) {
    const meaning = verb === "power" ? "shutdown" : state === "on" ? "enable" : "disable";
    if (verb === "power" || state !== "down") {
      words = words.filter((w) => w !== state);
      words[words.indexOf(verb)] = meaning;
    }
  }
  // Two words that the catalog writes as one ("shut down", "wire guard"), before
  // a repair can read one half as a typing mistake.
  for (let i = 0; i < words.length - 1; i++) {
    const one = words[i]! + words[i + 1]!;
    if (!df.has(one) || (df.has(words[i]!) && df.has(words[i + 1]!))) continue;
    words.splice(i, 2, one);
  }
  const repaired = words.flatMap((w) =>
    df.has(w) || Object.hasOwn(SYNONYMS, w) || Object.hasOwn(DOMAIN_WORDS, w)
      ? [w]
      : repairWord(w, df),
  );
  const meaningful = repaired.filter((w) => !FILLER.has(w));
  return meaningful.length > 0 ? meaningful : repaired;
}

/** The other number or spelling of a word, when the catalog has it: "address" and "addresses". */
function otherNumber(word: string, df: Map<string, number>): string[] {
  return [
    `${word}s`,
    `${word}es`,
    word.replace(/es$/, ""),
    word.replace(/s$/, ""),
    word.replace("our", "or"),
  ].filter((f) => f !== word && df.has(f));
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
  const verbs = new Set(tools.map((t) => tokenize(t.name)[0] ?? ""));
  return { entries, df, n: entries.length, verbs };
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
  const qList = queryWords(query, index.df);
  if (qList.length === 0) return [];
  // Two words that the catalog writes as one ("shut down" for `shutdown`,
  // "wire guard" for `wireguard`) count as that one word too.
  const joined = qList
    .slice(1)
    .map((t, i) => qList[i]! + t)
    .filter((t) => index.df.has(t));
  const qOriginal = new Set([...qList, ...joined]);
  const qTokens = expandQuery([...qList, ...joined]);
  for (const t of qList) for (const f of otherNumber(t, index.df)) qTokens.add(f);
  const qUnderscored = qRaw.replace(/\s+/g, "_");

  // A query token counts as "in name" if the name has it OR any of its synonyms.
  const nameHasIntent = (entry: IndexedEntry, t: string): boolean =>
    entry.nameTokens.has(t) ||
    own(SYNONYMS, t).some((s) => entry.nameTokens.has(s)) ||
    otherNumber(t, index.df).some((s) => entry.nameTokens.has(s));

  // "removed route", "listing addresses": the verb a tool name starts with. Only
  // the first word: later in a sentence ("what changed since…") it is not an order.
  for (const t of qList.slice(0, 1)) {
    if (index.verbs.has(t)) continue;
    const verb = [
      t.replace(/ing$/, ""),
      t.replace(/ing$/, "e"),
      t.replace(/ed$/, ""),
      t.replace(/d$/, ""),
    ].find((f) => f !== t && index.verbs.has(f));
    if (verb) for (const v of expandQuery([verb])) qTokens.add(v);
  }
  const verbless =
    qList.length <= 3 &&
    ![...qTokens].some((t) => Object.hasOwn(SYNONYMS, t) || index.verbs.has(t));

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
    // A short request with no verb ("fw rules", "users") most often asks to see things.
    if (verbless && /^(?:list|show)_/.test(entry.name)) s *= 1.25;
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
