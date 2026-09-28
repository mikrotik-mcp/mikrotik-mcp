import type { CheckConnection, CheckSession } from "./model";

// Presence is ephemeral and local to this server, not a saved test or a router health check.
// ponytail: process-local presence; use shared TTL storage if clustered dashboards are needed.
const connections = new Map<string, CheckConnection & { expiresAt: number }>();
export function clientPresence(s: CheckSession): CheckConnection | null {
  for (const [id, c] of connections) if (c.expiresAt <= Date.now()) connections.delete(id);
  const c = connections.get(s.id);
  return c
    ? {
        connectedAt: c.connectedAt,
        lastSeen: c.lastSeen,
        peerAddress: c.peerAddress,
        deviceLabel: c.deviceLabel,
      }
    : null;
}
export function noteClientPresence(s: CheckSession, peer: string, agent: string): void {
  const previous = clientPresence(s),
    now = Date.now();
  const deviceLabel = /Android/i.test(agent)
    ? "Android device"
    : /iPhone/i.test(agent)
      ? "iPhone"
      : /iPad/i.test(agent)
        ? "iPad"
        : /Windows/i.test(agent)
          ? "Windows device"
          : /Macintosh/i.test(agent)
            ? "Mac"
            : /Linux/i.test(agent)
              ? "Linux device"
              : "Browser device";
  connections.set(s.id, {
    connectedAt: previous?.peerAddress === peer ? previous.connectedAt : now,
    lastSeen: now,
    peerAddress: peer,
    deviceLabel,
    expiresAt: s.expiresAt,
  });
}
