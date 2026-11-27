/**
 * Server update awareness — shared release-check logic for both the
 * observability dashboard and the LLM-facing "pulse" tool.
 *
 * Two cache tiers prevent redundant GitHub API calls:
 *   1. In-memory cache (15-minute TTL) — hot path for the same process.
 *   2. File-based cache at `~/.mikrotik-mcp/update-check.json` (6-hour TTL)
 *      — survives restarts so the next boot gets an instant answer.
 *
 * All functions are non-throwing: network or filesystem errors degrade
 * gracefully and never crash the server.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { VERSION } from "../version";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ReleasePayload {
  version: string;
  name: string;
  body: string;
  publishedAt: string;
  url: string;
  /** The latest published release is newer than the running version. */
  isNewer: boolean;
  /** The running version is ahead of the latest published release (dev/pre-release). */
  isAhead: boolean;
  currentVersion: string;
}

export interface UpdateCheckResult {
  release: ReleasePayload | null;
  checkedAt: number;
  fromCache: boolean;
  error?: string;
}

export type Freshness = "fresh" | "aging" | "stale" | "ancient";

// ── Constants ────────────────────────────────────────────────────────────────

const RELEASES_URL = "https://api.github.com/repos/mikrotik-mcp/mikrotik-mcp/releases";
const GITHUB_API = `${RELEASES_URL}/latest`;
const MEMORY_CACHE_TTL = 15 * 60 * 1000; // 15 minutes
const FILE_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours
const CACHE_PATH = join(homedir(), ".mikrotik-mcp", "update-check.json");

// ── Version comparison ───────────────────────────────────────────────────────

/** Semver-ish comparison: returns < 0 / 0 / > 0 (like `a - b`). */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ── In-memory cache ──────────────────────────────────────────────────────────

let memoryCache: { data: ReleasePayload; fetchedAt: number } | null = null;

// ── File-based persistent cache ──────────────────────────────────────────────

interface FileCache {
  data: ReleasePayload;
  fetchedAt: number;
}

function loadFileCache(maxAge = FILE_CACHE_TTL): ReleasePayload | null {
  try {
    const raw = readFileSync(CACHE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as FileCache;
    if (!parsed?.data?.version || typeof parsed.fetchedAt !== "number") return null;
    if (Date.now() - parsed.fetchedAt > maxAge) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

/**
 * Synchronous cache read for use in `createServer()` (instructions injection).
 * Returns the cached release if the file exists and is within the 6-hour TTL.
 */
export function loadFileCacheSync(): ReleasePayload | null {
  return loadFileCache();
}

function saveFileCache(data: ReleasePayload): void {
  try {
    const dir = dirname(CACHE_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify({ data, fetchedAt: Date.now() } satisfies FileCache));
  } catch {
    // Best-effort; never propagate.
  }
}

// ── GitHub API fetch ─────────────────────────────────────────────────────────

async function readRelease(res: Response): Promise<ReleasePayload> {
  const gh = (await res.json()) as {
    tag_name: string;
    name: string;
    body: string;
    published_at: string;
    html_url: string;
  };
  const latestVersion = gh.tag_name.replace(/^v/, "");
  const cmp = compareVersions(latestVersion, VERSION);
  return {
    version: latestVersion,
    name: gh.name || `v${latestVersion}`,
    body: gh.body || "",
    publishedAt: gh.published_at,
    url: gh.html_url,
    isNewer: cmp > 0,
    isAhead: cmp < 0,
    currentVersion: VERSION,
  };
}

let installedCache: { data: ReleasePayload; fetchedAt: number } | null = null;

/** An upgrade may leave a fresh latest-release cache referring to the previous install. */
export async function fetchReleaseForVersion(version: string): Promise<ReleasePayload | null> {
  for (const cache of [installedCache, memoryCache]) {
    if (cache?.data.version === version && Date.now() - cache.fetchedAt < MEMORY_CACHE_TTL)
      return withCurrentRelation(cache.data);
  }
  const saved = loadFileCache();
  if (saved?.version === version) return withCurrentRelation(saved);

  for (const tag of [version, `v${version}`]) {
    const res = await fetch(`${RELEASES_URL}/tags/${encodeURIComponent(tag)}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": `mikrotik-mcp/${VERSION}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const data = await readRelease(res);
    if (data.version !== version)
      throw new Error("Release tag does not match the requested version");
    installedCache = { data, fetchedAt: Date.now() };
    return data;
  }
  return null;
}

/**
 * Fetch the latest GitHub release. Uses the two-tier cache (memory → file →
 * network). The result is always saved to both caches on a successful fetch.
 */
export async function fetchLatestRelease(): Promise<ReleasePayload> {
  // Tier 1: in-memory cache
  if (memoryCache && Date.now() - memoryCache.fetchedAt < MEMORY_CACHE_TTL) {
    return withCurrentRelation(memoryCache.data);
  }

  // Tier 2: file-based cache (only when memory is cold)
  const fileCached = loadFileCache();
  if (fileCached) {
    // Warm the memory cache from disk so subsequent calls are instant.
    memoryCache = { data: fileCached, fetchedAt: Date.now() };
    return withCurrentRelation(fileCached);
  }

  // Tier 3: network
  const res = await fetch(GITHUB_API, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": `mikrotik-mcp/${VERSION}`,
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);

  const data = await readRelease(res);

  // Populate both caches
  memoryCache = { data, fetchedAt: Date.now() };
  saveFileCache(data);
  return withCurrentRelation(data);
}

/**
 * Re-derive the fields that are relative to the RUNNING version — `currentVersion`,
 * `isNewer`, `isAhead` — from `VERSION` at read time. A cached payload (memory or
 * the 6-hour file cache) bakes these in against whatever version wrote it, so after
 * the server is upgraded a stale cache would otherwise report the wrong "you're on
 * vX" and falsely flag an older release as newer. Only the raw release facts
 * (version/name/body/date/url) are trusted from cache.
 */
export function withCurrentRelation(r: ReleasePayload): ReleasePayload {
  const cmp = compareVersions(r.version, VERSION);
  return { ...r, currentVersion: VERSION, isNewer: cmp > 0, isAhead: cmp < 0 };
}

// ── Non-throwing wrapper (for background use) ────────────────────────────────

/**
 * Check for a newer server version. Never throws — network/filesystem errors
 * produce `{ release: null, error }` instead.
 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  try {
    const release = await fetchLatestRelease();
    return { release, checkedAt: Date.now(), fromCache: false };
  } catch (e) {
    // If network failed but we have a stale file cache, return it — with the
    // relation re-derived against the running version (the cache may predate an upgrade).
    const stale = loadFileCache(Infinity);
    if (stale) {
      return { release: withCurrentRelation(stale), checkedAt: Date.now(), fromCache: true };
    }
    return {
      release: null,
      checkedAt: Date.now(),
      fromCache: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ── Freshness assessment ─────────────────────────────────────────────────────

/**
 * How stale is the running version compared to the latest release?
 *
 * - `fresh`   — current or within one patch of latest
 * - `aging`   — one minor version behind
 * - `stale`   — more than one minor behind
 * - `ancient` — a major version behind
 */
export function assessFreshness(current: string, latest: string): Freshness {
  const ca = current.replace(/^v/, "").split(".").map(Number);
  const la = latest.replace(/^v/, "").split(".").map(Number);
  const majorDiff = (la[0] ?? 0) - (ca[0] ?? 0);
  const minorDiff = (la[1] ?? 0) - (ca[1] ?? 0);
  const patchDiff = (la[2] ?? 0) - (ca[2] ?? 0);

  if (majorDiff > 0) return "ancient";
  if (minorDiff > 1) return "stale";
  if (minorDiff === 1) return "aging";
  if (patchDiff > 1) return "aging";
  return "fresh";
}

// ── Compact summary for instructions injection ──────────────────────────────

/**
 * Returns a one-liner for injecting into the MCP instructions when a newer
 * version is available, or `null` when the running version is current.
 */
export function updateSummaryLine(release: ReleasePayload): string | null {
  if (!release.isNewer) return null;
  return (
    `Server update available: MikroTik MCP v${release.version} ` +
    `(you are running v${VERSION}). ` +
    `Call check_server_pulse for release notes and upgrade commands, ` +
    `or upgrade directly: bun i -g @usex/mikrotik-mcp@latest`
  );
}

// ── All releases (for the dashboard's Releases page) ─────────────────────────

/** One release in the full list, with its relation to the running version. */
export interface ReleaseListItem {
  version: string;
  name: string;
  body: string;
  publishedAt: string;
  url: string;
  prerelease: boolean;
  /** How this release compares to the running version. */
  relation: "current" | "newer" | "older";
}

export interface ReleasesPayload {
  currentVersion: string;
  /** Newest non-prerelease version, or null if none. */
  latestVersion: string | null;
  updateAvailable: boolean;
  /** Newest-first list of published releases. */
  releases: ReleaseListItem[];
  fetchedAt: number;
}

const RELEASES_API = "https://api.github.com/repos/mikrotik-mcp/mikrotik-mcp/releases?per_page=100";
let releasesCache: { data: ReleasesPayload; fetchedAt: number } | null = null;

/**
 * Fetch ALL published GitHub releases (newest first), each tagged with its
 * relation to the running version. Memory-cached for {@link MEMORY_CACHE_TTL}.
 */
export async function fetchAllReleases(): Promise<ReleasesPayload> {
  if (releasesCache && Date.now() - releasesCache.fetchedAt < MEMORY_CACHE_TTL) {
    return releasesCache.data;
  }

  const res = await fetch(RELEASES_API, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": `mikrotik-mcp/${VERSION}`,
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);

  const raw = (await res.json()) as {
    tag_name: string;
    name: string;
    body: string;
    published_at: string;
    html_url: string;
    prerelease: boolean;
    draft: boolean;
  }[];

  const releases: ReleaseListItem[] = raw
    .filter((r) => !r.draft)
    .map((r) => {
      const version = r.tag_name.replace(/^v/, "");
      const cmp = compareVersions(version, VERSION);
      return {
        version,
        name: r.name || `v${version}`,
        body: r.body || "",
        publishedAt: r.published_at,
        url: r.html_url,
        prerelease: r.prerelease,
        relation: cmp === 0 ? "current" : cmp > 0 ? "newer" : "older",
      } satisfies ReleaseListItem;
    })
    .sort((a, b) => compareVersions(b.version, a.version));

  const latest = releases.find((r) => !r.prerelease) ?? releases[0] ?? null;
  const data: ReleasesPayload = {
    currentVersion: VERSION,
    latestVersion: latest ? latest.version : null,
    updateAvailable: latest ? compareVersions(latest.version, VERSION) > 0 : false,
    releases,
    fetchedAt: Date.now(),
  };
  releasesCache = { data, fetchedAt: Date.now() };
  return data;
}
