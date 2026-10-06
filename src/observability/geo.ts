/**
 * IP geolocation for the dashboard — resolves each configured device's public IP
 * to a country (ISO code) so the UI can show a flag next to it.
 *
 * A device's `host` may be a public IP, a private/LAN IP, or a hostname. Only a
 * PUBLIC address geolocates meaningfully, so private/loopback/link-local ranges
 * (and MAC-Telnet devices, which have no IP) are skipped and yield no flag. The
 * lookup uses the free, key-less ipkit.ir API (falling back to ipquery.io if it
 * doesn't answer) and is cached for a day — a device's country effectively never
 * changes, so we never hammer the endpoint.
 *
 * Like the health probes, this only runs when the dashboard is enabled, so the
 * offline test runner never performs network I/O.
 */
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { getAsnOrganizationLabel } from "../core/asn-organization";
import { getConfig } from "../core/runtime";
import { logger } from "../logger";

const LOG_TAG = "mikrotik-mcp";

export interface DeviceGeo {
  /** ISO 3166-1 alpha-2 country code, lowercase (the circle-flags SVG filename). */
  countryCode: string;
  /** Full country name, e.g. "Germany". */
  country: string;
  /** City, when the provider reports one. */
  city?: string;
  /** Source-IP autonomous system number, normalized as AS<number>. */
  asn?: string;
  /** Compact network label (local ASN directory when known), not the user's identity. */
  asnOrganization?: string;
}

interface Cached {
  geo: DeviceGeo | null; // null = resolved, but no public geo (private IP / failed)
  at: number;
}

const cache = new Map<string, Cached>();
/** Re-resolve at most once a day — a device's country is effectively static. */
const REFRESH_MS = 24 * 60 * 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

/** The most recent geolocation for a device (null until resolved / when private). */
export function getDeviceGeo(name: string): DeviceGeo | null {
  return cache.get(name)?.geo ?? null;
}

// BlockList handles IPv6 spelling and IPv4-mapped IPv6 as well as native IPv4.
const nonPublic = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["100.64.0.0", 10],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  nonPublic.addSubnet(address, prefix, "ipv4");
nonPublic.addSubnet("::", 96, "ipv6");
nonPublic.addSubnet("fc00::", 7, "ipv6");
nonPublic.addSubnet("fe80::", 10, "ipv6");
nonPublic.addSubnet("ff00::", 8, "ipv6");

function isIpLiteral(host: string): boolean {
  return isIP(host) !== 0;
}

/**
 * True for a routable, geolocatable public IP literal. A non-IP host (hostname)
 * or a private/loopback/link-local/CGNAT address returns false — we never send
 * those to the geo provider, they can't be placed anyway.
 */
export function isPublicIpLiteral(host: string): boolean {
  const version = isIP(host);
  return version !== 0 && !nonPublic.check(host, version === 6 ? "ipv6" : "ipv4");
}

/** Resolve a host to a routable PUBLIC IP, or null when private/unresolvable. */
async function publicIpOf(host: string): Promise<string | null> {
  let ip = host;
  if (!isIpLiteral(host)) {
    try {
      ip = (await lookup(host)).address;
    } catch {
      return null; // unresolvable hostname → no geo
    }
  }
  return isPublicIpLiteral(ip) ? ip : null;
}

function toGeo(
  country: string | undefined,
  code: string | undefined,
  city: string | undefined,
  asn?: unknown,
  organization?: unknown,
): DeviceGeo | null {
  if (!code || !/^[a-z]{2}$/i.test(code)) return null;
  const geo: DeviceGeo = {
    countryCode: code.toLowerCase(),
    country: country ?? code,
    city: city || undefined,
  };
  const asnMatch =
    typeof asn === "string" || typeof asn === "number"
      ? /^(?:AS)?(\d+)$/i.exec(String(asn).trim())
      : null;
  const asnNumber = asnMatch ? Number(asnMatch[1]) : 0;
  if (Number.isSafeInteger(asnNumber) && asnNumber > 0 && asnNumber <= 0xffffffff)
    geo.asn = `AS${asnNumber}`;
  const label = getAsnOrganizationLabel(geo.asn, organization);
  if (label) geo.asnOrganization = label;
  return geo;
}

/** Primary provider: ipkit.ir. Content-negotiates, so ask for JSON explicitly. */
async function fetchIpkit(ip: string): Promise<DeviceGeo | null> {
  const res = await fetch(`https://ipkit.ir/${ip}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`ipkit HTTP ${res.status}`);
  const d = (await res.json()) as {
    country?: string;
    country_code?: string;
    city?: string;
    is_private?: boolean;
    asn?: unknown;
    asn_organization?: unknown;
  };
  if (d.is_private) return null; // provider flags a non-routable IP
  return toGeo(d.country, d.country_code, d.city, d.asn, d.asn_organization);
}

/** Fallback provider: ipquery.io (nested under `location`). */
async function fetchIpquery(ip: string): Promise<DeviceGeo | null> {
  const res = await fetch(`https://api.ipquery.io/${ip}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`ipquery HTTP ${res.status}`);
  const d = (await res.json()) as {
    location?: { country?: string; country_code?: string; city?: string };
    isp?: { asn?: unknown; org?: unknown };
  };
  return toGeo(
    d.location?.country,
    d.location?.country_code,
    d.location?.city,
    d.isp?.asn,
    d.isp?.org,
  );
}

/** Geolocate a public IP, trying ipkit.ir first and falling back to ipquery.io. */
async function fetchGeo(ip: string): Promise<DeviceGeo | null> {
  try {
    return await fetchIpkit(ip);
  } catch (e) {
    logger.warn(
      `[${LOG_TAG}] ipkit geo failed for ${ip}, trying ipquery: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  try {
    return await fetchIpquery(ip);
  } catch (e) {
    logger.warn(
      `[${LOG_TAG}] geo lookup failed for ${ip}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

export interface IpGeo {
  status: "pending" | "resolved" | "private" | "unavailable";
  countryCode?: string;
  country?: string;
  asn?: string;
  asnOrganization?: string;
}

interface IpGeoEntry {
  result: IpGeo;
  expires: number;
}
const ipCache = new Map<string, IpGeoEntry>();
const geoQueue: { ip: string; entry: IpGeoEntry }[] = [];
const IP_CACHE_LIMIT = 1024;
const GEO_CONCURRENCY = 4;
let activeLookups = 0;

/** Parse only literals (including IP:port); never resolve a caller ID as a hostname. */
export function sourceIpLiteral(address: string): string | null {
  const value = address.trim();
  if (isIpLiteral(value)) return value.toLowerCase();
  const endpoint = /^(?:\[([^\]]+)\]|(\d{1,3}(?:\.\d{1,3}){3}))(?::(\d{1,5}))?$/.exec(value);
  if (!endpoint || (endpoint[3] && +endpoint[3] > 65535)) return null;
  const ip = endpoint[1] ?? endpoint[2];
  return isIpLiteral(ip) ? ip.toLowerCase() : null;
}

/** Bounded background work: a slow GeoIP provider must never delay session reads. */
function drainGeoQueue(): void {
  while (activeLookups < GEO_CONCURRENCY && geoQueue.length) {
    const job = geoQueue.shift()!;
    activeLookups++;
    void fetchGeo(job.ip)
      .then((geo) => {
        if (geo) {
          const result: IpGeo = {
            status: "resolved",
            countryCode: geo.countryCode,
            country: geo.country,
          };
          if (geo.asn) result.asn = geo.asn;
          if (geo.asnOrganization) result.asnOrganization = geo.asnOrganization;
          job.entry.result = result;
        } else job.entry.result = { status: "unavailable" };
        job.entry.expires = Date.now() + (geo ? REFRESH_MS : 5 * 60_000);
      })
      .finally(() => {
        activeLookups--;
        drainGeoQueue();
      });
  }
}

/** Cached source-IP country, resolved asynchronously and shared across routers/sessions. */
export function getIpGeo(address: string): IpGeo {
  const ip = sourceIpLiteral(address);
  if (!ip) return { status: "unavailable" };
  if (!isPublicIpLiteral(ip)) return { status: "private" };
  const entry = ipCache.get(ip);
  if (entry && entry.expires > Date.now()) return entry.result;
  if (ipCache.size >= IP_CACHE_LIMIT && !entry) {
    // Keep pending entries to coalesce requests and keep the queue bounded.
    const settled = [...ipCache].find(([, value]) => value.result.status !== "pending");
    if (!settled) return { status: "unavailable" };
    ipCache.delete(settled[0]);
  }
  const next: IpGeoEntry = { result: { status: "pending" }, expires: Infinity };
  ipCache.set(ip, next);
  geoQueue.push({ ip, entry: next });
  drainGeoQueue();
  return next.result;
}

/** Dashboard authentication is enforced by the outer handler; only literal IPs leave the host. */
export function ipGeoRoute(req: Request, url: URL): Response | null {
  if (url.pathname !== "/api/ip-network") return null;
  const headers = { "cache-control": "no-store" };
  if (req.method !== "GET")
    return Response.json({ error: "Method not allowed" }, { status: 405, headers });
  const address = url.searchParams.get("ip") ?? "";
  const ip = address.length <= 128 ? sourceIpLiteral(address) : null;
  if (!ip)
    return Response.json({ error: "Provide an IPv4 or IPv6 address." }, { status: 400, headers });
  return Response.json(getIpGeo(ip), { headers });
}

async function resolveDevice(name: string, host: string | undefined): Promise<void> {
  const ip = host ? await publicIpOf(host) : null;
  const geo = ip ? await fetchGeo(ip) : null;
  cache.set(name, { geo, at: Date.now() });
}

/** Resolve every configured device whose cache entry is missing or stale. */
export async function refreshGeo(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const now = Date.now();
    await Promise.all(
      Object.entries(getConfig().devices).map(([name, dc]) => {
        const c = cache.get(name);
        if (c && now - c.at < REFRESH_MS) return Promise.resolve();
        // MAC-Telnet devices have no IP to geolocate.
        return resolveDevice(name, dc.mac ? undefined : dc.host);
      }),
    );
  } finally {
    inFlight = false;
  }
}

/** Start periodic geo lookups (one immediate pass, then daily). */
export function startGeoLookups(): void {
  void refreshGeo();
  timer = setInterval(() => void refreshGeo(), REFRESH_MS);
}

/** Stop periodic geo lookups. */
export function stopGeoLookups(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
