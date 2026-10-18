import { z } from "zod";
import { parseExport, recordsOf } from "../policy/parse";
import { traverseChain } from "./firewall";
import type { SimPacket, TraversalStep } from "./firewall";
import { formatIp, parseCidr, parseIp } from "./ip";
import { buildModel } from "./model";

export const verificationSchema = z.object({
  config_text: z.string().min(1).max(200_000),
  source: z.string().max(64),
  destination: z.string().max(64),
  source_ports: z.string().max(64).default("0-65535"),
  destination_ports: z.string().max(64).default("0-65535"),
  protocol: z.enum(["tcp", "udp"]).default("tcp"),
  chain: z.enum(["input", "forward", "output"]).default("forward"),
  in_interface: z.string().max(128).default("bridge"),
  out_interface: z.string().max(128).default("ether1"),
  connection_state: z.enum(["new", "established", "related", "invalid"]).default("new"),
  expect: z.enum(["accept", "drop", "reject"]).default("drop"),
});

export interface VerificationReport {
  status: "proved" | "violated" | "unknown";
  scope: string;
  reason: string;
  cells: number;
  checked: number;
  witness?: SimPacket;
  trace?: TraversalStep[];
}

type Interval = [number, number];
const SCOPE =
  "IPv4 filter-chain entry only; declared interfaces/state; static export. Not end-to-end reachability or NAT/routing verification.";
const MAX_CELLS = 4096;
const ALLOWED = new Set([
  "chain",
  "action",
  "disabled",
  "comment",
  "log",
  "log-prefix",
  "jump-target",
  "reject-with",
  "src-address",
  "dst-address",
  "src-address-list",
  "dst-address-list",
  "src-port",
  "dst-port",
  "port",
  "protocol",
  "in-interface",
  "out-interface",
  "connection-state",
]);

function addressRange(text: string): Interval {
  if (text.includes("-")) {
    const parts = text.split("-");
    const lo = parseIp(parts[0]);
    const hi = parseIp(parts[1] ?? "");
    if (parts.length === 2 && lo !== null && hi !== null && lo <= hi) return [lo, hi];
  } else if (/^\d+\.\d+\.\d+\.\d+(\/\d{1,2})?$/.test(text)) {
    const cidr = parseCidr(text);
    if (cidr) return [cidr.network, cidr.network + 2 ** (32 - cidr.prefix) - 1];
  }
  throw new Error(`Unsupported IPv4 address/range: ${text}`);
}

function portRange(text: string): Interval {
  if (!/^\d+(?:-\d+)?$/.test(text)) throw new Error(`Invalid port range: ${text}`);
  const [lo, end] = text.split("-").map(Number);
  const hi = end ?? lo;
  if (lo > hi || hi > 65535) throw new Error(`Invalid port range: ${text}`);
  return [lo, hi];
}

/** Every matcher is constant inside each cell; one representative covers the entire cell. */
function representatives(scope: Interval, boundaries: Interval[]): number[] {
  const points = new Set([scope[0]]);
  for (const [lo, hi] of boundaries) {
    if (lo > scope[0] && lo <= scope[1]) points.add(lo);
    if (hi + 1 > scope[0] && hi + 1 <= scope[1]) points.add(hi + 1);
  }
  return [...points].sort((a, b) => a - b);
}

export function verifyPolicy(input: z.input<typeof verificationSchema>): VerificationReport {
  const a = verificationSchema.parse(input);
  const result: VerificationReport = {
    status: "unknown",
    scope: SCOPE,
    reason: "",
    cells: 0,
    checked: 0,
  };
  try {
    const source = addressRange(a.source);
    const destination = addressRange(a.destination);
    const sourcePorts = portRange(a.source_ports);
    const destinationPorts = portRange(a.destination_ports);
    const parsed = parseExport(a.config_text);
    if (parsed.unparsed.length) throw new Error("Export contains unparsed lines.");
    const filter = recordsOf(parsed, "/ip/firewall/filter");
    if (!filter.length)
      throw new Error("No filter rules in supplied export; completeness cannot be established.");
    if (filter.length > 256)
      throw new Error("More than 256 filter rules; narrow the supplied model.");
    const model = buildModel(a.config_text);
    const lists = recordsOf(parsed, "/ip/firewall/address-list");
    const src: Interval[] = [],
      dst: Interval[] = [],
      sp: Interval[] = [],
      dp: Interval[] = [];
    for (const rule of filter) {
      if (rule.op !== "add")
        throw new Error(`Only exported add rules supported (line ${rule.line}).`);
      if (["yes", "true"].includes(rule.fields.disabled)) continue;
      for (const [field, raw] of Object.entries(rule.fields)) {
        if (!ALLOWED.has(field)) throw new Error(`Unsupported ${field} at line ${rule.line}.`);
        const value = raw.replace(/^!/, "");
        if (
          field === "action" &&
          !["accept", "drop", "reject", "jump", "return", "log", "passthrough"].includes(value)
        )
          throw new Error(`Unsupported action ${value} at line ${rule.line}.`);
        if (field === "src-address" || field === "dst-address")
          (field === "src-address" ? src : dst).push(addressRange(value));
        if (field === "src-address-list" || field === "dst-address-list") {
          const members = lists.filter((r) => r.fields.list === value);
          if (!members.length)
            throw new Error(`List ${value} is absent; dynamic membership cannot be proven.`);
          for (const member of members) {
            if (member.op !== "add" || member.fields.timeout || member.fields.dynamic)
              throw new Error(`List ${value} has non-static membership.`);
            (field === "src-address-list" ? src : dst).push(
              addressRange(member.fields.address ?? ""),
            );
          }
        }
        if (["src-port", "dst-port", "port"].includes(field)) {
          const ranges = value.split(",").map(portRange);
          if (field !== "dst-port") sp.push(...ranges);
          if (field !== "src-port") dp.push(...ranges);
        }
      }
    }
    const axes = [
      representatives(source, src),
      representatives(destination, dst),
      representatives(sourcePorts, sp),
      representatives(destinationPorts, dp),
    ];
    result.cells = axes.reduce((n, axis) => n * axis.length, 1);
    if (result.cells > MAX_CELLS)
      throw new Error(
        `Analysis requires ${result.cells} cells; limit is ${MAX_CELLS}. Narrow the scope.`,
      );
    for (const s of axes[0])
      for (const d of axes[1])
        for (const p of axes[2])
          for (const q of axes[3]) {
            const packet: SimPacket = {
              srcAddress: formatIp(s),
              dstAddress: formatIp(d),
              srcPort: p,
              dstPort: q,
              protocol: a.protocol,
              inInterface: a.in_interface,
              outInterface: a.out_interface,
              connectionState: a.connection_state,
            };
            const trace = traverseChain(model, model.filter, a.chain, packet);
            result.checked++;
            if (trace.verdict !== a.expect) {
              return {
                ...result,
                status: trace.verdict === "unknown" ? "unknown" : "violated",
                reason: `Expected ${a.expect}; model returned ${trace.verdict}.`,
                witness: packet,
                trace: trace.steps,
              };
            }
          }
    return {
      ...result,
      status: "proved",
      reason: `All ${result.cells} equivalence cells satisfy ${a.expect} within the stated filter-only model.`,
    };
  } catch (error) {
    return { ...result, reason: error instanceof Error ? error.message : String(error) };
  }
}
