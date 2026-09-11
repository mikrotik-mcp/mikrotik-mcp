/** Only valid investigation identifiers are selectable; display names never become targets. */
export interface ClientOption {
  mac: string;
  ip: string;
  host: string;
  iface: string;
}

export function clientIdentifier(client: ClientOption): string {
  const ip = client.ip.trim();
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip.split(".").every((n) => Number(n) <= 255))
    return ip;
  const mac = client.mac.trim().toUpperCase();
  return /^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac) ? mac : "";
}

export function filterClientOptions(clients: ClientOption[], query: string): ClientOption[] {
  const search = query.trim().toLowerCase();
  return clients
    .filter(
      (c) =>
        clientIdentifier(c) &&
        [c.host, c.ip, c.mac, c.iface].some((v) => v.toLowerCase().includes(search)),
    )
    .sort((a, b) =>
      (a.host || a.ip || a.mac).localeCompare(b.host || b.ip || b.mac, undefined, {
        numeric: true,
      }),
    );
}
