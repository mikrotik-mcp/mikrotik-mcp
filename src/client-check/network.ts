import { networkInterfaces } from "node:os";
import { isIP } from "node:net";
import { clientCheckOrigin } from "./model";

/** Advertise actual local addresses, never the wildcard bind address or a Host header. */
export function clientCheckNetwork(host: string, port: number, interfaces = networkInterfaces()) {
  const wildcard = host === "0.0.0.0" || host === "::";
  const candidates = Object.entries(interfaces)
    .flatMap(([name, addresses]) =>
      (addresses ?? [])
        .filter((a) => !a.internal && a.family === "IPv4" && (wildcard || a.address === host))
        .map((a) => ({ name, address: a.address, origin: `http://${a.address}:${port}` })),
    )
    .sort(
      (a, b) =>
        Number(/^(utun|tun|wg|tailscale)/.test(a.name)) -
        Number(/^(utun|tun|wg|tailscale)/.test(b.name)),
    );
  if (!wildcard && !candidates.length) {
    try {
      const origin = clientCheckOrigin(`http://${isIP(host) === 6 ? `[${host}]` : host}:${port}`);
      candidates.push({ name: "Bound address", address: host, origin });
    } catch {
      /* Loopback-only binds need an explicit restart, not a misleading QR. */
    }
  }
  return { bindHost: host, port, candidates, localOnly: !wildcard && !candidates.length };
}
export type ClientCheckNetwork = ReturnType<typeof clientCheckNetwork>;
