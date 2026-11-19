/**
 * Semantic search over the tool catalog.
 *
 * The lexical search finds a tool when the request uses the tool's own words.
 * A person, or a model that paraphrases, often does not: "change the
 * nameservers" shares no word with `set_dns_servers`. An embedding model places
 * both near each other, so the request finds the tool by meaning.
 *
 * The model is `@ternlight/base` (the quality tier): a 7 MB WebAssembly bundle
 * that runs on the
 * CPU of this host. Nothing is sent anywhere, and there is no API key.
 *
 * - The catalog is embedded once (about 9 ms for each tool) in the background,
 *   in small batches, so the server answers while it runs.
 * - The vectors are cached on disk, keyed by the text that was embedded. A
 *   restart with the same catalog loads them in milliseconds.
 * - Everything is optional. If the model cannot load, or is not ready yet, the
 *   caller gets `null` and uses the lexical search alone.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { logger } from "../logger";

export interface SemanticDoc {
  name: string;
  title: string;
  description: string;
}

type Embed = (text: string) => Float32Array;
const DIM = 384;
/** The model reads about 95 words; the title and the first sentence say what a tool is for. */
export function semanticText(doc: SemanticDoc): string {
  const first = doc.description.replace(/\s+/g, " ").split(/(?<=[.!?])\s/)[0] ?? "";
  return `${doc.title}. ${first.slice(0, 220)}`;
}

interface State {
  names: string[];
  /** One row of `DIM` numbers for each name. Rows are unit length. */
  vectors: Float32Array;
  embed: Embed;
}
let state: State | null = null;
let building: Promise<void> | null = null;

/** Where the vectors are kept: `MIKROTIK_TOOL_VECTORS`, or `~/.mikrotik-mcp/tool-vectors.bin`. */
const cacheFile = (): string =>
  process.env.MIKROTIK_TOOL_VECTORS || join(homedir(), ".mikrotik-mcp", "tool-vectors.bin");

function loadCache(key: string, count: number): Float32Array | null {
  try {
    const file = readFileSync(cacheFile());
    // 64 bytes of key (hex sha-256), then the vectors.
    if (file.subarray(0, 64).toString("ascii") !== key) return null;
    const body = file.subarray(64);
    if (body.byteLength !== count * DIM * 4) return null;
    return new Float32Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
  } catch {
    return null;
  }
}

function saveCache(key: string, vectors: Float32Array): void {
  try {
    mkdirSync(dirname(cacheFile()), { recursive: true });
    writeFileSync(
      cacheFile(),
      Buffer.concat([
        Buffer.from(key, "ascii"),
        Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength),
      ]),
    );
  } catch (error) {
    logger.debug(`[tool-search] vectors not cached: ${String(error)}`);
  }
}

/**
 * Build the index in the background. Safe to call more than once. `embed` is
 * for tests; by default the model is loaded here, and a failure to load it
 * leaves semantic search off.
 */
export function startSemanticIndex(docs: SemanticDoc[], embed?: Embed): Promise<void> {
  building ??= (async () => {
    try {
      let run = embed;
      if (!run) {
        // A dynamic import: the WebAssembly loads only when the feature is used.
        const model = (await import("@ternlight/base")) as { embed: Embed };
        run = model.embed;
      }
      const texts = docs.map(semanticText);
      const key = createHash("sha256")
        .update(`ternlight-base-1\n${texts.join("\n")}`)
        .digest("hex");
      let vectors = embed ? null : loadCache(key, docs.length);
      if (!vectors) {
        const started = Date.now();
        vectors = new Float32Array(docs.length * DIM);
        for (let i = 0; i < docs.length; i += 1) {
          vectors.set(run(texts[i]!), i * DIM);
          // Yield every few tools: the server keeps answering while this runs.
          if (i % 8 === 7) await new Promise((resolve) => setImmediate(resolve));
        }
        if (!embed) saveCache(key, vectors);
        logger.debug(`[tool-search] embedded ${docs.length} tools in ${Date.now() - started} ms`);
      }
      state = { names: docs.map((doc) => doc.name), vectors, embed: run };
    } catch (error) {
      logger.debug(`[tool-search] semantic search is off: ${String(error)}`);
    }
  })();
  return building;
}

/** Forget the index (tests only). */
export function resetSemanticIndex(): void {
  state = null;
  building = null;
}

export const semanticReady = (): boolean => state !== null;

/**
 * The tools nearest in meaning to `query`, best first, or `null` when the
 * index is not ready. The vectors are unit length, so the dot product is the
 * cosine similarity.
 */
export function semanticRank(query: string, limit: number): { name: string; sim: number }[] | null {
  if (!state) return null;
  let q: Float32Array;
  try {
    q = state.embed(query.slice(0, 600));
  } catch {
    return null;
  }
  const { names, vectors } = state;
  const scored: { name: string; sim: number }[] = [];
  for (let i = 0; i < names.length; i += 1) {
    let dot = 0;
    const base = i * DIM;
    for (let k = 0; k < DIM; k += 1) dot += q[k]! * vectors[base + k]!;
    scored.push({ name: names[i]!, sim: dot });
  }
  return scored.sort((a, b) => b.sim - a.sim).slice(0, limit);
}

/**
 * Merge two rankings by reciprocal rank: a tool that is high in both lists
 * wins over one that is first in only one. Returns names, best first.
 */
export function fuseRanks(lists: string[][], limit: number, k = 20): string[] {
  const score = new Map<string, number>();
  for (const list of lists)
    list.forEach((name, index) => score.set(name, (score.get(name) ?? 0) + 1 / (k + index)));
  return Array.from(score)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name]) => name);
}
