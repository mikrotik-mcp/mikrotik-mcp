/**
 * Helpers for WireGuard user onboarding: pick a free tunnel address, read and
 * write the expiry in a peer comment, and draw the client config as a QR code.
 * PURE (no device, no files) except nothing: callers do the I/O.
 */
import { deflateSync, crc32 } from "node:zlib";
import qrcode from "qrcode-generator";

/** The marker on every peer this feature creates. */
export const USER_TAG = "vpn-user: ";

const toInt = (ip: string): number | null => {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    value = value * 256 + Number(part);
  }
  return value;
};
const toIp = (value: number): string =>
  [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");

/**
 * The lowest host address of `cidr` (the server's own address and prefix, for
 * example `10.20.0.1/24`) that no peer uses. `used` holds allowed-address
 * values (`10.20.0.5/32`, or several separated by commas). `null` when the
 * subnet is full or `cidr` is not IPv4.
 */
export function nextFreeAddress(cidr: string, used: string[]): string | null {
  const [address, prefixText] = cidr.split("/");
  const server = toInt(address ?? "");
  const prefix = Number(prefixText);
  if (server === null || !Number.isInteger(prefix) || prefix < 8 || prefix > 30) return null;
  const size = 2 ** (32 - prefix);
  const network = Math.floor(server / size) * size;
  const taken = new Set<number>([server]);
  for (const entry of used)
    for (const one of entry.split(",")) {
      const value = toInt(one.trim().split("/")[0] ?? "");
      if (value !== null) taken.add(value);
    }
  for (let host = network + 1; host < network + size - 1; host += 1)
    if (!taken.has(host)) return toIp(host);
  return null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `vpn-user: alice expires=2026-12-31` */
export function userComment(user: string, expires?: string): string {
  return `${USER_TAG}${user}${expires ? ` expires=${expires}` : ""}`;
}

/** The user label and expiry of a peer comment, or `null` when it is not one of ours. */
export function readUserComment(comment: string): { user: string; expires?: string } | null {
  if (!comment.startsWith(USER_TAG)) return null;
  const rest = comment.slice(USER_TAG.length);
  const match = rest.match(/^(.*?) expires=(\d{4}-\d{2}-\d{2})$/);
  return match ? { user: match[1]!, expires: match[2] } : { user: rest };
}

export const isDate = (value: string): boolean =>
  DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

/** True when `expires` (a calendar day) is before `today` (also `YYYY-MM-DD`). */
export const isExpired = (expires: string | undefined, today: string): boolean =>
  expires !== undefined && expires < today;

/** A RouterOS regular expression that matches the comment of exactly this user. */
export function userCommentPattern(user: string): string {
  const escaped = user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `^${USER_TAG}${escaped}( expires=[0-9-]+)?\$`;
}

/** A PNG chunk: length, type, data, CRC. */
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

/**
 * The text as a QR code in a PNG (black on white, 8 pixels for each module and
 * a 4-module quiet zone, as phone cameras expect).
 */
export function qrPng(text: string, scale = 8): Buffer {
  const code = qrcode(0, "M");
  code.addData(text);
  code.make();
  const modules = code.getModuleCount();
  const quiet = 4;
  const side = (modules + quiet * 2) * scale;
  // 8-bit grayscale: each row is a filter byte (0) and one byte for each pixel.
  const raw = Buffer.alloc((side + 1) * side, 255);
  for (let y = 0; y < side; y += 1) {
    raw[y * (side + 1)] = 0;
    const row = Math.floor(y / scale) - quiet;
    for (let x = 0; x < side; x += 1) {
      const col = Math.floor(x / scale) - quiet;
      const dark = row >= 0 && col >= 0 && row < modules && col < modules && code.isDark(row, col);
      if (dark) raw[y * (side + 1) + 1 + x] = 0;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
