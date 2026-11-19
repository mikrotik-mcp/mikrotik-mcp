/**
 * Listen for MikroTik Neighbor Discovery (MNDP) on the MCP host itself.
 *
 * Every RouterOS device announces itself on UDP 5678 about once a minute, and
 * answers a short request at once. Reading a router's `/ip neighbor` shows what
 * that router hears; this shows what the host hears, which finds devices on
 * the host's own network segment even when no router is managed yet.
 *
 * A packet is a 4-byte header and then records of type (2 bytes), length
 * (2 bytes) and value. The parser is pure and bounded: a record that claims
 * more bytes than the packet holds ends the parse.
 */
import { createSocket } from "node:dgram";

export const MNDP_PORT = 5678;

export interface HeardNeighbor {
  mac?: string;
  identity?: string;
  version?: string;
  platform?: string;
  board?: string;
  interface?: string;
  ip?: string;
}

const TYPE = { mac: 1, identity: 5, version: 7, platform: 8, board: 12, interface: 16, ipv4: 17 };
/** Text from a device on the network: printable characters only, bounded. */
const text = (value: Buffer): string =>
  value
    .toString("utf8")
    .replace(/[^\x20-\x7E -￿]/g, "")
    .slice(0, 80);

export function parseMndp(packet: Buffer): HeardNeighbor | null {
  if (packet.length < 8) return null;
  const heard: HeardNeighbor = {};
  let at = 4;
  while (at + 4 <= packet.length) {
    const type = packet.readUInt16BE(at);
    const length = packet.readUInt16BE(at + 2);
    const value = packet.subarray(at + 4, at + 4 + length);
    if (value.length !== length) break;
    at += 4 + length;
    if (type === TYPE.mac && length === 6)
      heard.mac = Array.from(value, (byte) =>
        byte.toString(16).padStart(2, "0").toUpperCase(),
      ).join(":");
    else if (type === TYPE.identity) heard.identity = text(value);
    else if (type === TYPE.version) heard.version = text(value);
    else if (type === TYPE.platform) heard.platform = text(value);
    else if (type === TYPE.board) heard.board = text(value);
    else if (type === TYPE.interface) heard.interface = text(value);
    else if (type === TYPE.ipv4 && length === 4) heard.ip = Array.from(value).join(".");
  }
  return heard.mac || heard.identity ? heard : null;
}

/**
 * Listen for `ms` milliseconds and return what was heard, one entry for each
 * MAC address. A request is broadcast first so devices answer at once.
 * Rejects when the port cannot be opened (another program holds it).
 */
export function listenMndp(ms: number, port = MNDP_PORT): Promise<HeardNeighbor[]> {
  return new Promise((resolve, reject) => {
    const socket = createSocket({ type: "udp4", reuseAddr: true });
    const heard = new Map<string, HeardNeighbor>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (error?: Error): void => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      if (error) reject(error);
      else resolve(Array.from(heard.values()));
    };
    socket.on("error", (error) => done(error));
    socket.on("message", (packet, from) => {
      const neighbor = parseMndp(packet);
      if (!neighbor) return;
      // The address the packet came from is real even when the device names none.
      neighbor.ip ??= from.address;
      heard.set(neighbor.mac ?? `${from.address}`, neighbor);
    });
    socket.bind(port, () => {
      try {
        socket.setBroadcast(true);
        socket.send(Buffer.alloc(4), port, "255.255.255.255", () => {});
      } catch {
        /* listening still works without the request */
      }
      timer = setTimeout(() => done(), ms);
    });
  });
}
