/** Offline composition of explicit router paths. Never equates a prediction with live delivery. */
import { z } from "zod";
import { buildModel } from "../sim/model";
import type { SimModel } from "../sim/model";
import { tracePacket } from "../sim/trace";
import type { SimPacket } from "../sim/firewall";
import { parseIp } from "../sim/ip";
import { looksLikeError } from "../core/routeros";
import { contentSha } from "../snapshots/format";
import type { Snapshot } from "../snapshots/store";
import type { HopEvidence, PathLeg, RoundTripResult } from "./types";
import { parseExport } from "../policy/parse";

const hop = z.object({
  device: z.string().min(1).max(128),
  ingress: z.string().min(1).max(128),
  egress: z.string().min(1).max(128),
});
export const roundTripInput = z.object({
  snapshots: z
    .array(z.object({ device: z.string().min(1).max(128), id: z.string().min(1).max(128) }))
    .min(1)
    .max(8),
  forward: z.array(hop).min(1).max(8),
  reverse: z.array(hop).min(1).max(8),
  packet: z.object({
    srcAddress: z.ipv4(),
    dstAddress: z.ipv4(),
    protocol: z.enum(["tcp", "udp", "icmp"]).default("tcp"),
    srcPort: z.number().int().min(1).max(65535).optional(),
    dstPort: z.number().int().min(1).max(65535).optional(),
  }),
  maxAgeSeconds: z.number().int().min(1).max(86400).default(900),
  maxSkewSeconds: z.number().int().min(0).max(3600).default(120),
});
export type RoundTripInput = z.infer<typeof roundTripInput>;
type Hop = z.infer<typeof hop>;
/** Validate topology consistency before even looking up snapshot bodies. */
export function validatePath(input: RoundTripInput): string[] {
  const devices = [...new Set([...input.forward, ...input.reverse].map((h) => h.device))];
  if (
    new Set(input.snapshots.map((s) => s.device)).size !== input.snapshots.length ||
    devices.length !== input.snapshots.length ||
    devices.some((device) => !input.snapshots.some((s) => s.device === device))
  )
    throw new Error("Supply exactly one snapshot for each path device");
  for (const leg of [input.forward, input.reverse])
    if (new Set(leg.map((h) => h.device)).size !== leg.length)
      throw new Error("Loops and repeated devices are not supported");
  const first = input.forward[0];
  const last = input.forward.at(-1)!;
  if (
    input.reverse[0].device !== last.device ||
    input.reverse[0].ingress !== last.egress ||
    input.reverse.at(-1)!.device !== first.device ||
    input.reverse.at(-1)!.egress !== first.ingress
  )
    throw new Error("Reverse path must join the same client and destination interfaces");
  if (
    (input.packet.protocol === "tcp" || input.packet.protocol === "udp") &&
    (input.packet.srcPort === undefined || input.packet.dstPort === undefined)
  )
    throw new Error("TCP/UDP require both ports so reverse matching is meaningful");
  return devices;
}

function walk(
  hops: Hop[],
  models: Map<string, SimModel>,
  packet: Omit<SimPacket, "inInterface">,
): PathLeg {
  const results: HopEvidence[] = [];
  for (const [i, h] of hops.entries()) {
    const model = models.get(h.device)!;
    const result: HopEvidence = { ...h, status: "unknown", reason: "" };
    results.push(result);
    // Global model omissions (including raw/VRF-like unparsed input) cannot disappear in composition.
    if (
      model.unparsedLines ||
      model.unmodelled.length ||
      model.dynamicRouteSources.length ||
      !model.interfaces.includes(h.ingress) ||
      !model.interfaces.includes(h.egress)
    ) {
      result.reason =
        "Export is incomplete, has unsupported constructs/dynamic routes, or lacks a declared interface";
      return { status: "unknown", hops: results };
    }
    const trace = tracePacket({ model, packet: { ...packet, inInterface: h.ingress } });
    const { routing, steps, ...rest } = trace;
    result.trace = {
      ...rest,
      steps: steps.map(({ raw: _raw, ...step }) => step),
      route: routing
        ? {
            table: routing.route?.table,
            gateway: routing.gateway,
            outInterface: routing.outInterface,
          }
        : undefined,
    };
    if (trace.nat.length) {
      result.reason =
        "NAT boundary: cross-router tuple rewriting and reverse conntrack are not modelled";
      return { status: "unknown", hops: results };
    }
    if (trace.verdict === "drop" || trace.verdict === "reject") {
      result.status = "blocked";
      result.reason = trace.summary;
      return { status: "blocked", hops: results };
    }
    if (trace.verdict === "unknown" || trace.path !== "forward") {
      result.reason =
        trace.path !== "forward"
          ? "Router-local delivery is outside this transit path"
          : trace.summary;
      return { status: "unknown", hops: results };
    }
    if (routing?.outInterface !== h.egress) {
      result.reason = `Declared egress ${h.egress} differs from modelled egress ${routing?.outInterface ?? "unknown"}`;
      return { status: "unknown", hops: results };
    }
    const next = hops[i + 1];
    if (next) {
      const gateway = parseIp(routing.gateway ?? "");
      // An explicit interface gateway is an operator-declared link, not discovered connectivity.
      const explicitInterface = routing.gateway === h.egress;
      const peer = models.get(next.device)!;
      if (
        !explicitInterface &&
        (gateway === null ||
          !peer.addresses.some(
            (a) => !a.disabled && a.interface === next.ingress && a.address === gateway,
          ))
      ) {
        result.reason =
          "Selected next-hop does not identify the declared next router's ingress address";
        return { status: "unknown", hops: results };
      }
    } else if (routing.route?.kind !== "connected") {
      result.reason =
        "Path ends before a directly connected destination network; more hops are required";
      return { status: "unknown", hops: results };
    }
    result.status = "modelled";
    result.reason =
      "Static forwarding agrees with the declared path; link and host liveness are not tested";
  }
  return { status: "modelled", hops: results };
}

/** Both directions are conditional predictions; even a complete model is not a connectivity test. */
export function traceRoundTrip(
  raw: RoundTripInput,
  snapshots: Snapshot[],
  now = Date.now(),
): RoundTripResult {
  const input = roundTripInput.parse(raw);
  validatePath(input);
  const selected = input.snapshots.map((ref) => {
    const snapshot = snapshots.find((s) => s.id === ref.id && s.device === ref.device);
    if (
      !snapshot ||
      !snapshot.body.trim() ||
      looksLikeError(snapshot.body) ||
      new TextEncoder().encode(snapshot.body).length > 512 * 1024 ||
      snapshot.ts > now + 10_000 ||
      now - snapshot.ts > input.maxAgeSeconds * 1000 ||
      !Number.isFinite(snapshot.ts) ||
      contentSha(snapshot.body) !== snapshot.sha
    )
      throw new Error(
        "Snapshot missing, stale, oversized, future-dated or inconsistent; capture fresh evidence",
      );
    return snapshot;
  });
  const times = selected.map((s) => s.ts);
  if (Math.max(...times) - Math.min(...times) > input.maxSkewSeconds * 1000)
    throw new Error("Snapshot capture skew exceeds the requested bound");
  const models = new Map(
    selected.map((s) => {
      const model = buildModel(s.body);
      // These parse successfully but the single-router simulator does not apply their side-effects.
      for (const section of parseExport(s.body).sections) {
        const outsideScope = [
          "/routing/rule",
          "/ip/vrf",
          "/ip/settings",
          "/ip/firewall/connection",
          "/ip/ipsec",
          "/ip/hotspot",
          "/interface/bridge/filter",
          "/interface/bridge/nat",
          "/interface/bridge/settings",
          "/mpls",
        ].some((prefix) => section.path === prefix || section.path.startsWith(`${prefix}/`));
        const disabledInterface =
          section.path.startsWith("/interface/") &&
          section.records.some((r) => r.fields.disabled === "yes" || r.fields.disabled === "true");
        if (section.records.length && (outsideScope || disabledInterface))
          model.unmodelled.push({
            section: section.path,
            what: "unmodelled forwarding or interface state",
            line: section.records[0].line,
          });
      }
      return [s.device, model] as const;
    }),
  );
  const forward = walk(input.forward, models, { ...input.packet, connectionState: "new" });
  // Never synthesize a valid return tuple after an unknown/NAT outbound path.
  const asymmetricNewRouter = input.reverse.find(
    (h) => !input.forward.some((f) => f.device === h.device),
  );
  const reverse: PathLeg =
    forward.status !== "modelled"
      ? { status: "unknown", hops: [] }
      : asymmetricNewRouter
        ? {
            status: "unknown",
            hops: [
              {
                ...asymmetricNewRouter,
                status: "unknown",
                reason:
                  "Return-only router has no modelled forward conntrack; established state cannot be assumed",
              },
            ],
          }
        : walk(input.reverse, models, {
            srcAddress: input.packet.dstAddress,
            dstAddress: input.packet.srcAddress,
            protocol: input.packet.protocol,
            srcPort: input.packet.dstPort,
            dstPort: input.packet.srcPort,
            connectionState: "established",
          });
  const expectedReturn = [...input.forward]
    .reverse()
    .map((h) => `${h.device}:${h.egress}:${h.ingress}`);
  const actualReturn = input.reverse.map((h) => `${h.device}:${h.ingress}:${h.egress}`);
  return {
    status:
      forward.status === "blocked" || reverse.status === "blocked"
        ? "blocked"
        : forward.status === "modelled" && reverse.status === "modelled"
          ? "modelled"
          : "unknown",
    liveDelivery: "unverified",
    asymmetric: JSON.stringify(expectedReturn) !== JSON.stringify(actualReturn),
    assumptions: [
      "Explicit adjacent hops are operator-declared links, not discovered or probed links.",
      "Return leg assumes a replying endpoint and established conntrack on each router; no handshake or conntrack was observed.",
      "IPv4 static routed transit only. NAT, dynamic routing, unsupported constructs and incomplete paths stop with UNKNOWN.",
      "Snapshot freshness bounds do not prove that configuration or route liveness stayed unchanged.",
    ],
    provenance: selected.map((s) => ({
      device: s.device,
      snapshotId: s.id,
      capturedAt: s.ts,
      sha: s.sha,
    })),
    forward,
    reverse,
  };
}
