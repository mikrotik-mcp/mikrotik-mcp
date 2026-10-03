import { z } from "zod";
import { createHash } from "node:crypto";
import { Cmd } from "../core/routeros";
import { parseExport } from "../policy/parse";
import type { WorkspaceRecord } from "../operations/store";

export const rosVersion = z.string().regex(/^7\.\d+(?:\.\d+)?(?:beta\d+|rc\d+)?$/);
export const recoveryInput = z.object({
  snapshotId: z.string().min(1).max(100),
  version: rosVersion,
  mode: z.enum(["restore", "upgrade"]).default("restore"),
});
export const REQUIRED_CHECKS = [
  "authenticated-boot",
  "import",
  "configuration-readback",
  "reboot-persistence",
  "isolation",
] as const;
export const capabilitiesSchema = z.object({
  protocol: z.literal("mikrotik-recovery/v1"),
  runnerId: z.string().regex(/^[a-zA-Z0-9_.-]{1,80}$/),
  isolated: z.literal(true),
  productionNetworkAccess: z.literal(false),
  disposable: z.literal(true),
  enforcesTtl: z.literal(true),
  versions: z
    .array(
      z.object({
        version: rosVersion,
        imageSha256: z.string().regex(/^[a-f0-9]{64}$/),
        architecture: z.enum(["x86_64", "aarch64"]),
      }),
    )
    .min(1)
    .max(30)
    .refine((versions) => new Set(versions.map((v) => v.version)).size === versions.length, {
      message: "Each RouterOS version must identify one unambiguous pinned image.",
    }),
});
export type RunnerCapabilities = z.infer<typeof capabilitiesSchema>;
export const resultSchema = z.object({
  protocol: z.literal("mikrotik-recovery/v1"),
  id: z.uuid(),
  requestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  runnerId: z.string().min(1).max(80),
  version: rosVersion,
  state: z.enum(["running", "completed", "failed", "destroyed"]),
  isolated: z.literal(true),
  productionNetworkAccess: z.literal(false),
  checks: z
    .array(
      z.object({
        name: z.enum(REQUIRED_CHECKS),
        state: z.enum(["pass", "fail", "unsupported", "pending"]),
        detail: z.string().max(500),
      }),
    )
    .max(5),
  elapsedMs: z.number().int().min(0).max(3600000).optional(),
  cleanup: z.enum(["pending", "destroyed", "failed"]),
});
export type RunnerResult = z.infer<typeof resultSchema>;
export interface LabCoverage {
  scope: string;
  included: number;
  excluded: number;
  reason?: string;
}
export interface RecoveryRun extends WorkspaceRecord {
  snapshotId: string;
  snapshotSha: string;
  snapshotAt: number;
  sourceVersion?: string;
  version: string;
  mode: "restore" | "upgrade";
  commands: string[];
  commandSha256: string;
  coverage: LabCoverage[];
  state: "prepared" | "running" | "passed" | "failed" | "uncertain" | "destroyed";
  runnerId?: string;
  runnerBinding?: string;
  capabilitiesSha?: string;
  requestSha256?: string;
  preparedAt: number;
  startedAt?: number;
  result?: RunnerResult;
  error?: string;
}
export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
/** Literal, additive subset only. Never forward raw export text, scripts, passwords or management services. */
const FIELDS: Record<string, string[]> = {
  "/interface/bridge": ["name", "protocol-mode", "vlan-filtering", "pvid", "disabled"],
  "/interface/vlan": ["name", "interface", "vlan-id", "disabled"],
  "/interface/bridge/port": [
    "bridge",
    "interface",
    "pvid",
    "ingress-filtering",
    "frame-types",
    "disabled",
  ],
  "/interface/bridge/vlan": ["bridge", "tagged", "untagged", "vlan-ids", "disabled"],
  "/interface/list": ["name", "include", "exclude"],
  "/interface/list/member": ["list", "interface", "disabled"],
  "/ip/address": ["address", "interface", "network", "disabled"],
  "/ipv6/address": ["address", "interface", "advertise", "disabled"],
  "/ip/route": [
    "dst-address",
    "gateway",
    "distance",
    "routing-table",
    "scope",
    "target-scope",
    "disabled",
    "blackhole",
  ],
  "/ipv6/route": [
    "dst-address",
    "gateway",
    "distance",
    "routing-table",
    "scope",
    "target-scope",
    "disabled",
    "blackhole",
  ],
  "/routing/table": ["name", "fib", "disabled"],
  "/ip/firewall/filter": [
    "chain",
    "action",
    "protocol",
    "src-address",
    "dst-address",
    "src-port",
    "dst-port",
    "connection-state",
    "in-interface",
    "out-interface",
    "in-interface-list",
    "out-interface-list",
    "disabled",
  ],
  "/ipv6/firewall/filter": [
    "chain",
    "action",
    "protocol",
    "src-address",
    "dst-address",
    "src-port",
    "dst-port",
    "connection-state",
    "in-interface",
    "out-interface",
    "in-interface-list",
    "out-interface-list",
    "disabled",
  ],
};
export function buildRecoverySubset(body: string): { commands: string[]; coverage: LabCoverage[] } {
  if (body.length > 512000) throw new Error("Snapshot exceeds the 512 KB rehearsal limit.");
  const model = parseExport(body),
    commands: string[] = [],
    coverage: LabCoverage[] = [];
  for (const section of model.sections) {
    const allowed = FIELDS[section.path];
    let included = 0,
      excluded = 0;
    for (const row of section.records) {
      const fields = Object.entries(row.fields).filter(([key]) => key !== "comment");
      // Reject interpreted expressions even inside quoted strings: this is intentionally conservative.
      if (
        !allowed ||
        row.op !== "add" ||
        /[$[\]{};\\\r\n]/.test(row.raw) ||
        fields.some(([key, value]) => !allowed.includes(key) || value.length > 200) ||
        fields.length === 0 ||
        row.flags.length > 0
      ) {
        excluded++;
        continue;
      }
      let cmd = new Cmd(`${section.path.replaceAll("/", " ").trimStart().replace(/^/, "/")} add`);
      for (const [key, value] of fields) cmd = cmd.set(key, value);
      commands.push(cmd.build());
      included++;
    }
    coverage.push({
      scope: section.path,
      included,
      excluded,
      reason: excluded
        ? "Unsupported scope, operation, field or expression: not sent to the lab."
        : undefined,
    });
  }
  if (model.unparsed.length)
    coverage.push({
      scope: "unparsed lines",
      included: 0,
      excluded: model.unparsed.length,
      reason: "Unparsed text is never executed.",
    });
  if (commands.length > 300)
    throw new Error("More than 300 portable records. Prepare a smaller reviewed snapshot.");
  return { commands, coverage };
}
export function validateRunnerResult(input: unknown, run: RecoveryRun): RunnerResult {
  const result = resultSchema.parse(input);
  if (
    result.id !== run.id ||
    result.runnerId !== run.runnerId ||
    result.requestSha256 !== run.requestSha256 ||
    result.version !== run.version
  )
    throw new Error("Runner evidence does not match this immutable rehearsal.");
  if (new Set(result.checks.map((c) => c.name)).size !== result.checks.length)
    throw new Error("Duplicate runner checks are not valid evidence.");
  if (result.state === "destroyed" && result.cleanup !== "destroyed")
    throw new Error("Destruction is not confirmed.");
  return result;
}
export function resultState(result: RunnerResult): RecoveryRun["state"] {
  if (result.state === "destroyed") return "destroyed";
  if (result.state === "failed" || result.checks.some((c) => c.state === "fail")) return "failed";
  if (result.state === "running") return "running";
  return REQUIRED_CHECKS.every((name) =>
    result.checks.some((c) => c.name === name && c.state === "pass"),
  )
    ? "passed"
    : "uncertain";
}
