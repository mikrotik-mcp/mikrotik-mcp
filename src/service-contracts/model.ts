/** Service contracts reference administrator-approved endpoints, never arbitrary model-supplied URLs. */
import { z } from "zod";
import ipaddr from "ipaddr.js";

export const ProbeTargetSchema = z.object({
  kind: z.enum(["dns", "tcp", "tls", "https"]),
  host: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i),
  port: z.number().int().min(1).max(65535).default(443),
  path: z
    .string()
    .max(1024)
    .default("/health")
    .refine(
      (p) => p.startsWith("/") && !p.startsWith("//") && !/[\r\n#?]/.test(p),
      "Use an absolute path without query, fragment or control characters",
    ),
  addresses: z
    .array(
      z
        .string()
        .refine(
          (s) => ipaddr.isValid(s) || ipaddr.isValidCIDR(s),
          "Expected an IP address or CIDR",
        ),
    )
    .min(1)
    .max(32),
});
export const ServiceProbeConfigSchema = z.object({
  scheduled: z.record(z.string(), z.array(z.uuid()).max(5)).default({}),
  targets: z.record(z.string().regex(/^[a-z\d_-]{1,64}$/i), ProbeTargetSchema).default({}),
  timeoutMs: z.number().int().min(100).max(10000).default(5000),
});
export type ProbeTarget = z.infer<typeof ProbeTargetSchema>;
export const contractInput = z.object({
  name: z.string().trim().min(1).max(120),
  checks: z
    .array(
      z.object({
        target: z.string().min(1).max(64),
        maxLatencyMs: z.number().int().min(1).max(10000).default(2000),
        expectedStatus: z.array(z.number().int().min(200).max(599)).min(1).max(10).default([200]),
      }),
    )
    .min(1)
    .max(10),
  packetSuiteId: z.string().min(1).max(120).optional(),
});
export type ServiceContract = z.infer<typeof contractInput> & {
  id: string;
  device: string;
  createdAt: number;
};
export interface ContractCheckResult {
  target: string;
  kind: "dns" | "tcp" | "tls" | "https" | "simulation" | "unconfigured";
  status: "pass" | "fail" | "unknown";
  durationMs: number;
  detail: string;
}
export interface ContractRun {
  id: string;
  contractId: string;
  device: string;
  startedAt: number;
  finishedAt: number;
  vantage: "mcp-host";
  status: "pass" | "fail" | "unknown";
  checks: ContractCheckResult[];
}

/** Match an explicitly resolved IP to operator-owned ranges, including address-family checks. */
export function addressAllowed(address: string, ranges: string[]): boolean {
  if (!ipaddr.isValid(address)) return false;
  const candidate = ipaddr.process(address);
  return ranges.some((range) => {
    if (!range.includes("/"))
      return (
        ipaddr.isValid(range) &&
        candidate.toNormalizedString() === ipaddr.process(range).toNormalizedString()
      );
    const [network, prefix] = ipaddr.parseCIDR(range);
    return network.kind() === candidate.kind() && candidate.match(network, prefix);
  });
}
export function overallStatus(checks: ContractCheckResult[]): ContractRun["status"] {
  if (!checks.length || checks.some((c) => c.status === "unknown")) return "unknown";
  return checks.every((c) => c.status === "pass") ? "pass" : "fail";
}
