import { createHash } from "node:crypto";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { z } from "zod";

export const addressSetInput = z.object({
  name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/),
  family: z.enum(["ipv4", "ipv6"]).default("ipv4"),
  operation: z.enum(["union", "intersection", "difference"]).default("union"),
  left: z.array(z.string().max(80)).min(1).max(2048),
  right: z.array(z.string().max(80)).max(2048).default([]),
  source: z.string().trim().min(1).max(256).describe("Provenance label, not a URL to fetch"),
  parent: z.string().uuid().optional(),
});
export type AddressSetInput = z.infer<typeof addressSetInput>;
type Span = [bigint, bigint];

function merge(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const [lo, hi] of spans.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    const previous = out.at(-1);
    if (previous && lo <= previous[1] + 1n) previous[1] = hi > previous[1] ? hi : previous[1];
    else out.push([lo, hi]);
  }
  return out;
}
function parse(values: string[], family: "ipv4" | "ipv6"): Span[] {
  const bits = family === "ipv4" ? 32 : 128;
  return merge(
    values.map((value) => {
      const parts = value.trim().split("/");
      if (
        parts.length > 2 ||
        isIP(parts[0]) !== (bits === 32 ? 4 : 6) ||
        (parts[1] !== undefined && !/^\d+$/.test(parts[1]))
      )
        throw new Error(`Invalid ${family} prefix: ${value}`);
      const prefix = parts[1] === undefined ? bits : Number(parts[1]);
      if (prefix < 0 || prefix > bits) throw new Error(`Invalid prefix length: ${value}`);
      const address = ipaddr
        .parse(parts[0])
        .toByteArray()
        .reduce((n, b) => (n << 8n) | BigInt(b), 0n);
      const size = 1n << BigInt(bits - prefix);
      const lo = (address / size) * size;
      return [lo, lo + size - 1n] as Span;
    }),
  );
}
function subtract(a: Span[], b: Span[]): Span[] {
  const out: Span[] = [];
  for (const [lo, hi] of a) {
    let start = lo;
    for (const [bl, bh] of b) {
      if (bh < start) continue;
      if (bl > hi) break;
      if (bl > start) out.push([start, bl - 1n]);
      start = bh + 1n > start ? bh + 1n : start;
      if (start > hi) break;
    }
    if (start <= hi) out.push([start, hi]);
  }
  return out;
}
function cidrs(spans: Span[], family: "ipv4" | "ipv6"): string[] {
  const bits = family === "ipv4" ? 32 : 128;
  const out: string[] = [];
  for (const [lo, hi] of spans) {
    let start = lo;
    while (start <= hi) {
      let hostBits = 0;
      while (hostBits < bits) {
        const next = 1n << BigInt(hostBits + 1);
        if (start % next !== 0n || start + next - 1n > hi) break;
        hostBits++;
      }
      const bytes = Array.from({ length: bits / 8 }, (_, i) =>
        Number((start >> BigInt(bits - 8 - i * 8)) & 255n),
      );
      out.push(`${ipaddr.fromByteArray(bytes).toString()}/${bits - hostBits}`);
      if (out.length > 4096) throw new Error("Result exceeds 4096 prefixes; narrow the input.");
      start += 1n << BigInt(hostBits);
    }
  }
  return out;
}
export function composeAddressSet(input: z.input<typeof addressSetInput>) {
  const a = addressSetInput.parse(input);
  return combinePrefixes(a);
}

/** Saved canonical results may contain more prefixes than either original operand. */
export function combinePrefixes(
  a: Pick<AddressSetInput, "left" | "right" | "family" | "operation">,
) {
  if (a.left.length > 4096 || a.right.length > 4096)
    throw new Error("Operand exceeds 4096 prefixes.");
  const left = parse(a.left, a.family),
    right = parse(a.right, a.family);
  const spans =
    a.operation === "union"
      ? merge([...left, ...right])
      : a.operation === "difference"
        ? subtract(left, right)
        : subtract(left, subtract(left, right));
  const prefixes = cidrs(spans, a.family);
  return {
    prefixes,
    checksum: createHash("sha256")
      .update(`${a.family}\n${prefixes.join("\n")}`)
      .digest("hex"),
    addresses: spans.reduce((n, [lo, hi]) => n + hi - lo + 1n, 0n).toString(),
  };
}

export const referenceSchema = z.object({
  table: z.enum(["filter", "mangle"]),
  id: z.string().regex(/^\*[0-9A-Fa-f]+$/),
  field: z.enum(["src-address-list", "dst-address-list"]),
  expected: z.string().min(1).max(128),
});
export type SetReference = z.infer<typeof referenceSchema>;
export interface AddressSetRevision {
  id: string;
  device: string;
  updatedAt: number;
  createdAt: number;
  input: AddressSetInput;
  prefixes: string[];
  checksum: string;
  addresses: string;
  list: string;
  state: "draft" | "published" | "rolled-back" | "uncertain";
  plan?: {
    id: string;
    expiresAt: number;
    references: SetReference[];
    fingerprint: string;
    rollback: boolean;
    commands: string[];
  };
  references?: SetReference[];
  originalListsHash?: string;
  delta?: {
    added: string[];
    removed: string[];
    addedAddresses: string;
    removedAddresses: string;
    large: boolean;
  };
  snapshot?: string;
  error?: string;
}
