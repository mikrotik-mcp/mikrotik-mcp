/** Runtime OpenVPN connections, not PPP accounts or retained accounting records. */
export interface OpenVpnSession {
  id: string;
  name: string;
  address: string;
  callerId: string;
  sessionId: string;
  encoding: string;
  radius: boolean;
  uptime: string;
  uptimeSeconds: number | null;
  disconnectToken?: string;
  /** Dashboard-only enrichment of callerId; never inferred from the tunnel address. */
  sourceGeo?: {
    status: "pending" | "resolved" | "private" | "unavailable";
    countryCode?: string;
    country?: string;
  };
}
export interface OpenVpnSnapshot {
  device: string;
  observedAt: number;
  sessions: OpenVpnSession[];
  canDisconnect: boolean;
}

/** RouterOS :tostr time supports unit and clock forms; unknown values are not zero. */
export function openVpnUptime(value: string): number | null {
  const clock = /^(?:(\d+)w)?(?:(\d+)d)?(\d{1,3}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(value);
  if (clock) {
    if (+clock[4] > 59 || +clock[5] > 59) return null;
    return (
      +(clock[1] || 0) * 604800 +
      +(clock[2] || 0) * 86400 +
      +clock[3] * 3600 +
      +clock[4] * 60 +
      +clock[5]
    );
  }
  if (!/^(?=\d)(?:\d+w)?(?:\d+d)?(?:\d+h)?(?:\d+m)?(?:\d+(?:\.\d+)?s)?$/.test(value)) return null;
  const units: Record<string, number> = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };
  const seconds = [...value.matchAll(/(\d+(?:\.\d+)?)([wdhms])/g)].reduce(
    (total, part) => total + +part[1] * units[part[2]],
    0,
  );
  return Number.isSafeInteger(Math.floor(seconds)) ? Math.floor(seconds) : null;
}

export function connectionDuration(seconds: number | null): string {
  if (seconds === null) return "Unavailable";
  const s = Math.max(0, Math.floor(seconds));
  const days = Math.floor(s / 86400);
  const clock = [Math.floor(s / 3600) % 24, Math.floor(s / 60) % 60, s % 60]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
  return `${days ? `${days}d ` : ""}${clock}`;
}
