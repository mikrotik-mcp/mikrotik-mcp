/**
 * IPv4 address arithmetic for the simulator. PURE.
 *
 * Deliberately IPv4-only in v1 (see `docs/tasks/08` §2): a half-correct IPv6
 * path would be exactly the kind of confident-but-wrong answer this whole
 * feature is designed not to produce. An IPv6 literal is REJECTED here rather
 * than coerced, so the caller can surface it as unmodelled.
 */

/** A parsed IPv4 CIDR: network address as a 32-bit int, plus the prefix length. */
export interface Cidr {
  /** Network address (host bits cleared), as an unsigned 32-bit integer. */
  network: number;
  prefix: number;
  /** Canonical `a.b.c.d/len` text, for reporting. */
  text: string;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Parse a dotted-quad into an unsigned 32-bit integer, or null. */
export function parseIp(text: string): number | null {
  const m = IPV4.exec(text.trim());
  if (!m) return null;
  let value = 0;
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i]);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

export function formatIp(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join(".");
}

function mask(prefix: number): number {
  // `<<32` is a no-op in JS (shift counts are mod 32), so /0 needs its own case.
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

/**
 * Parse `a.b.c.d`, `a.b.c.d/len` or a RouterOS address-with-network
 * (`192.168.88.1/24` means the HOST .1 inside the /24). A bare address is a /32.
 * Returns null for anything not IPv4 — including an IPv6 literal or a range.
 */
export function parseCidr(text: string): Cidr | null {
  const raw = text.trim();
  const [addr, len] = raw.split("/");
  const ip = parseIp(addr ?? "");
  if (ip === null) return null;
  const prefix = len === undefined ? 32 : Number(len);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const network = (ip & mask(prefix)) >>> 0;
  return { network, prefix, text: `${formatIp(network)}/${prefix}` };
}

/** The HOST address of an `address/prefix` (RouterOS `/ip address` form). */
export function hostOf(text: string): number | null {
  const [addr] = text.trim().split("/");
  return parseIp(addr ?? "");
}

/** Does `ip` fall inside `cidr`? */
export function inCidr(ip: number, cidr: Cidr): boolean {
  return (ip & mask(cidr.prefix)) >>> 0 === cidr.network;
}

/**
 * Match an address against a RouterOS address MATCHER, which may be a single
 * address, a CIDR, or a `from-to` range. Returns null when the matcher is not
 * something this model understands (an IPv6 literal, a DNS name) so the caller
 * can mark it unmodelled instead of silently failing to match.
 */
export function matchAddress(ip: number, matcher: string): boolean | null {
  const text = matcher.trim();
  if (text === "") return null;

  if (text.includes("-")) {
    const [from, to] = text.split("-");
    const lo = parseIp(from ?? "");
    const hi = parseIp(to ?? "");
    if (lo === null || hi === null) return null;
    return ip >= lo && ip <= hi;
  }
  const cidr = parseCidr(text);
  if (!cidr) return null;
  return inCidr(ip, cidr);
}

/** True when the text looks like an IPv6 address — used to reject, not to parse. */
export function looksIpv6(text: string): boolean {
  return text.includes(":");
}

/**
 * Match a RouterOS port matcher: `443`, `80,443`, `1000-2000`, or a combination.
 * Returns null when it cannot be understood.
 */
export function matchPort(port: number | undefined, matcher: string): boolean | null {
  if (port === undefined) return false;
  let understood = false;
  for (const part of matcher.split(",")) {
    const piece = part.trim();
    if (piece === "") continue;
    if (piece.includes("-")) {
      const [lo, hi] = piece.split("-").map((n) => Number(n));
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null;
      understood = true;
      if (port >= lo && port <= hi) return true;
      continue;
    }
    const value = Number(piece);
    if (!Number.isInteger(value)) return null;
    understood = true;
    if (port === value) return true;
  }
  return understood ? false : null;
}
