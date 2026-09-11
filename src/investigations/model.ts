/** Evidence is historical and router-scoped; it never proves an application's client-side health. */
import { z } from "zod";

export const investigationInput = z.object({
  client: z.union([z.ipv4(), z.string().regex(/^(?:[\da-f]{2}:){5}[\da-f]{2}$/i)]),
  target: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i),
  service: z.string().trim().min(1).max(120),
  vantage_devices: z.array(z.string().trim().min(1)).max(2).default([]),
});
export interface CaseEvidence {
  id: string;
  device: string;
  source: string;
  startedAt: number;
  finishedAt: number;
  state: "observed" | "inferred" | "unknown";
  summary: string;
  rows: Record<string, string>[];
  truncated: boolean;
}
export interface Investigation {
  id: string;
  createdAt: number;
  finishedAt: number;
  device: string;
  devices: string[];
  client: string;
  target: string;
  service: string;
  clientOutcome: "unverified";
  evidence: CaseEvidence[];
  nextTests: string[];
}

/** Recommend missing experiments, never coerce unavailable evidence into healthy zeroes. */
export function nextTests(evidence: CaseEvidence[], client: string, target: string): string[] {
  const steps = new Set<string>();
  if (evidence.some((e) => e.state === "unknown"))
    steps.add(
      "Retry unavailable evidence sources; missing data is not evidence of a healthy network.",
    );
  if (!evidence.some((e) => ["dhcp", "arp", "bridge-host"].includes(e.source) && e.rows.length))
    steps.add(
      `Locate ${client} on its access router; an absent DHCP/ARP record does not prove it is offline.`,
    );
  steps.add(
    `Test DNS and the application's TCP/TLS/HTTP request to ${target} from the actual client network.`,
  );
  steps.add(
    "Trace both directions through the relevant routers; router-originated ICMP does not exercise the client's forward chain.",
  );
  steps.add(
    "If needed, request a separate scoped packet capture; investigations never start captures or change configuration.",
  );
  return [...steps];
}
