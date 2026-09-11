import type { CaseEvidence, Investigation } from "../../src/investigations/model";

export interface TunnelEvidence {
  device: string;
  name: string;
  protocol: string;
  encrypted: boolean;
  state: "running" | "disabled" | "not-running" | "unknown";
  routes: Record<string, string>[];
  evidenceId: string;
}
const protocols: Record<string, [string, boolean]> = {
  wg: ["WireGuard", true],
  wireguard: ["WireGuard", true],
  "ovpn-in": ["OpenVPN", true],
  "ovpn-out": ["OpenVPN", true],
  "sstp-in": ["SSTP", true],
  "sstp-out": ["SSTP", true],
  "l2tp-in": ["L2TP", false],
  "l2tp-out": ["L2TP", false],
  "pptp-in": ["PPTP", false],
  "pptp-out": ["PPTP", false],
  gre: ["GRE", false],
  "gre-tunnel": ["GRE", false],
  eoip: ["EoIP", false],
  "eoip-tunnel": ["EoIP", false],
  ipip: ["IPIP", false],
  "ipip-tunnel": ["IPIP", false],
  vxlan: ["VXLAN", false],
};
const yes = (v?: string) => v === "yes" || v === "true";
export function tunnelInventory(investigation: Investigation): TunnelEvidence[] {
  return investigation.evidence
    .filter((e) => e.source === "interfaces" && e.state === "observed")
    .flatMap((e) =>
      e.rows.flatMap((r) => {
        const protocol = protocols[(r.type ?? "").toLowerCase()];
        if (!protocol || !r.name) return [];
        const state =
          yes(r.disabled) || (r.flags ?? "").includes("X")
            ? "disabled"
            : yes(r.running) || (r.flags ?? "").includes("R")
              ? "running"
              : r.running === "no" || r.running === "false"
                ? "not-running"
                : "unknown";
        const routes = investigation.evidence
          .filter((s) => s.device === e.device && s.source === "routes" && s.state === "observed")
          .flatMap((s) => s.rows)
          .filter((route) =>
            [route.gateway, route["immediate-gw"]].some((gateway) =>
              gateway
                ?.split(",")
                .some((part) => part.trim() === r.name || part.trim().split("%")[1] === r.name),
            ),
          );
        return [
          {
            device: e.device,
            name: r.name,
            protocol: protocol[0],
            encrypted: protocol[1],
            state,
            routes,
            evidenceId: e.id,
          },
        ];
      }),
    );
}

export function pingObservation(e?: CaseEvidence): {
  state: "reply" | "loss" | "unknown";
  text: string;
} {
  const r = e?.rows[0];
  if (e?.state !== "observed" || !r?.sent || r.received === undefined)
    return { state: "unknown", text: "Router probe unavailable" };
  const sent = Number(r.sent),
    received = Number(r.received);
  if (
    !Number.isInteger(sent) ||
    !Number.isInteger(received) ||
    sent <= 0 ||
    received < 0 ||
    received > sent
  )
    return { state: "unknown", text: "Router probe unavailable" };
  return {
    state: received < sent ? "loss" : "reply",
    text: `${received} / ${sent} ICMP replies from the router's perspective`,
  };
}
