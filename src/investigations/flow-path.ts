/** Exact-flow export evidence, not a route simulation or a packet capture. */
import { z } from "zod";
import type { FlowRecord } from "../flows/decode";

export const flowPathInput = z.object({
  client: z.ipv4(),
  destination: z.ipv4(),
  source_port: z.number().int().min(1).max(65535),
  destination_port: z.number().int().min(1).max(65535),
  protocol: z.enum(["tcp", "udp"]),
  interface_names: z
    .array(
      z
        .string()
        .min(1)
        .max(128)
        // Reject control characters and CLI negation, rather than broadening a named query.
        .refine(
          (name) =>
            !name.startsWith("!") &&
            name.split("").every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127),
        ),
    )
    .max(8)
    .default([]),
});
export type FlowPathInput = z.infer<typeof flowPathInput>;
export interface FlowInterface {
  index: number;
  name: string;
  type: string;
  mappedAt: number;
}
export interface FlowBranch {
  inputIf: number | null;
  outputIf: number | null;
  ingress?: FlowInterface;
  egress?: FlowInterface;
  records: number;
  first: number;
  last: number;
}
export interface FlowPathResult {
  device: string;
  exporter: string;
  checkedAt: number;
  from: number;
  tuple: FlowPathInput;
  collectorRunning: boolean;
  exporterSeen: boolean;
  limited: boolean;
  forward: FlowBranch[];
  reverse: FlowBranch[];
  rejected: number;
  warnings: string[];
  evidence: FlowRecord[];
}

/** An index of zero/missing is unknown, never an implicit drop or a physical port. */
const index = (n?: number): number | null =>
  n !== undefined && Number.isSafeInteger(n) && n > 0 ? n : null;

/** Match every tuple field and exporter again, even when the storage query is scoped. */
export function flowBranches(
  records: FlowRecord[],
  tuple: FlowPathInput,
  exporter: string,
  from: number,
  to: number,
  interfaces: FlowInterface[],
  reverse = false,
): { branches: FlowBranch[]; matched: FlowRecord[]; rejected: number } {
  const branches = new Map<string, FlowBranch>();
  const matched: FlowRecord[] = [];
  let rejected = 0;
  for (const r of records) {
    if (
      r.exporter !== exporter ||
      r.protocol !== (tuple.protocol === "tcp" ? 6 : 17) ||
      r.src !== (reverse ? tuple.destination : tuple.client) ||
      r.dst !== (reverse ? tuple.client : tuple.destination) ||
      r.srcPort !== (reverse ? tuple.destination_port : tuple.source_port) ||
      r.dstPort !== (reverse ? tuple.source_port : tuple.destination_port)
    )
      continue;
    if (
      ![r.start, r.end, r.packets, r.bytes].every(Number.isFinite) ||
      r.start > r.end ||
      r.end < from ||
      r.end > to ||
      r.packets <= 0 ||
      r.bytes < 0
    ) {
      rejected++;
      continue;
    }
    matched.push(r);
    const inputIf = index(r.inputIf),
      outputIf = index(r.outputIf);
    const key = `${inputIf}:${outputIf}`;
    const existing = branches.get(key);
    if (existing) {
      existing.records++;
      existing.first = Math.min(existing.first, r.start);
      existing.last = Math.max(existing.last, r.end);
      continue;
    }
    const resolve = (i: number | null): FlowInterface | undefined => {
      const candidates = interfaces.filter((item) => item.index === i);
      return candidates.length === 1 ? candidates[0] : undefined;
    };
    branches.set(key, {
      inputIf,
      outputIf,
      ingress: resolve(inputIf),
      egress: resolve(outputIf),
      records: 1,
      first: r.start,
      last: r.end,
    });
  }
  return { branches: [...branches.values()].sort((a, b) => b.last - a.last), matched, rejected };
}

/** Interpret only the documented ifDescr OID. CLI row ordinals are never ifIndex. */
export function interfaceIndexFromOid(raw: string): number | undefined {
  const names = [...raw.matchAll(/\bname=\.?1\.3\.6\.1\.2\.1\.2\.2\.1\.2\.(\d+)(?=\s|$)/g)];
  if (names.length !== 1) return undefined;
  return index(Number(names[0][1])) ?? undefined;
}
