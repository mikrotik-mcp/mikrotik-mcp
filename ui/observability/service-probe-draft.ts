import { ProbeTargetSchema, ServiceProbeConfigSchema } from "../../src/service-contracts/model";
import type { ProbeTarget } from "../../src/service-contracts/model";

export type ProbeDraft = {
  alias: string;
  kind: ProbeTarget["kind"];
  host: string;
  port: string;
  path: string;
  addresses: string;
};
type Cfg = Record<string, unknown>;
export const asProbeObject = (value: unknown): Cfg =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Cfg) : {};
export function probeTargets(cfg: Cfg): Record<string, ProbeTarget> {
  // JSON mode can hold schema-invalid drafts. Render repairable fields without
  // mutating that draft or losing its authoritative server-side errors.
  return Object.fromEntries(
    Object.entries(asProbeObject(asProbeObject(cfg.serviceProbes).targets)).map(([alias, raw]) => {
      const t = asProbeObject(raw);
      return [
        alias,
        {
          kind: ProbeTargetSchema.shape.kind.safeParse(t.kind).data ?? "https",
          host: typeof t.host === "string" ? t.host : "",
          port: typeof t.port === "number" ? t.port : 443,
          path: typeof t.path === "string" ? t.path : "/",
          addresses: Array.isArray(t.addresses)
            ? t.addresses.filter((a): a is string => typeof a === "string")
            : [],
        },
      ];
    }),
  );
}
export function newProbeDraft(alias = "", target?: ProbeTarget): ProbeDraft {
  return {
    alias,
    kind: target?.kind ?? "https",
    host: target?.host ?? "",
    port: String(target?.port ?? 443),
    path: target?.path ?? "/",
    addresses: target?.addresses.join("\n") ?? "",
  };
}
export function parseProbeDraft(
  draft: ProbeDraft,
  targets: Record<string, ProbeTarget>,
  original?: string,
) {
  const errors: Record<string, string> = {};
  const alias = draft.alias.trim();
  if (
    !ServiceProbeConfigSchema.shape.targets.unwrap().keyType.safeParse(alias).success ||
    ["__proto__", "constructor", "prototype"].includes(alias)
  )
    errors.alias = "Use 1–64 letters, numbers, underscores or hyphens.";
  else if (original !== undefined && alias !== original)
    errors.alias =
      "Keep the existing ID so policies and health checks can still find this service.";
  else if (Object.hasOwn(targets, alias) && original !== alias)
    errors.alias = "This service ID is already in use. Choose another ID.";
  const addresses = [...new Set(draft.addresses.split(/[\s,;]+/).filter(Boolean))];
  const result = ProbeTargetSchema.safeParse({
    kind: draft.kind,
    host: draft.host.trim(),
    port: draft.kind === "dns" ? 443 : Number(draft.port),
    path: draft.kind === "https" ? draft.path : "/",
    addresses,
  });
  if (!result.success) {
    for (const issue of result.error.issues) {
      const field = String(issue.path[0]);
      errors[field] ??=
        field === "host"
          ? "Enter a hostname or IPv4 address only, without https://, port or path."
          : field === "addresses"
            ? "Enter 1–32 valid IPv4/IPv6 addresses or CIDRs, separated by commas or new lines."
            : field === "port"
              ? "Use a port between 1 and 65535."
              : issue.message;
    }
  }
  return {
    errors,
    addresses,
    value:
      result.success && !Object.keys(errors).length ? { alias, target: result.data } : undefined,
  };
}
/** Only the target map changes; schedules, timeout and unrelated settings survive. */
export function updateProbeTarget(cfg: Cfg, alias: string, target: ProbeTarget | null): Cfg {
  const probes = asProbeObject(cfg.serviceProbes);
  const targets = { ...asProbeObject(probes.targets) };
  if (target)
    Object.defineProperty(targets, alias, {
      value: target,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  else delete targets[alias];
  return { ...cfg, serviceProbes: { ...probes, targets } };
}
