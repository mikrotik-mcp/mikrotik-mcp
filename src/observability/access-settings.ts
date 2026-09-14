/** Dashboard-owned access administration. Never executes a tool or contacts a router. */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AccessConfig } from "../config";
import { AccessConfigSchema, getConfigSource } from "../config";
import type { AccessDecision, AccessPolicy, RiskLevel } from "../core/access";
import {
  evaluateAccess,
  getAccessPolicy,
  hasSessionNarrowing,
  previewAccessPolicy,
  recentDenials,
} from "../core/access";
import { getConfig } from "../core/runtime";
import { moduleCatalog } from "../tools/index";
import type { ConfigAdmin } from "./config-admin";
import { recordVersion } from "./config-history";
import { riskOf } from "./event";

export interface AccessSettings {
  revision: string;
  configured: AccessConfig;
  effective: AccessPolicy;
  narrowed: boolean;
  readOnly: boolean;
  devices: { name: string; disabled: boolean }[];
  tools: { name: string; risk: RiskLevel; noDevice: boolean }[];
  denials: ReturnType<typeof recentDenials>;
  pending: { id: string; expiresAt?: number; owned: boolean } | null;
  fromFile: boolean;
}

export interface AccessPreview {
  effective: AccessPolicy;
  allowed: number;
  blocked: number;
  newlyAllowed: number;
  newlyBlocked: number;
  device?: string;
  check?: AccessDecision;
}

const list = z.array(z.string().trim().min(1).max(200)).max(200);
const accessSchema = AccessConfigSchema.extend({
  devices: list,
  denyDevices: list,
  tools: list,
  denyTools: list,
  label: z.string().trim().max(200).optional(),
}).strict();
const editSchema = z
  .object({
    revision: z.string().min(1),
    access: accessSchema,
    device: z.string().optional(),
    tool: z.string().optional(),
  })
  .strict();
const idSchema = z.object({ pendingId: z.string().min(1) }).strict();
const json = (body: unknown, status = 200) => Response.json(body, { status });
const policyFor = ({ enabled, ...scope }: AccessConfig): AccessPolicy => ({ enabled, scope });

/** Shared Config Studio state machine gives backup, hot apply, keep and timed rollback. */
export function createAccessSettingsRoutes(
  admin: ConfigAdmin,
  deps: {
    getConfig: typeof getConfig;
    getConfigSource: typeof getConfigSource;
    getAccessPolicy: typeof getAccessPolicy;
    hasSessionNarrowing: typeof hasSessionNarrowing;
    previewAccessPolicy: typeof previewAccessPolicy;
    recentDenials: typeof recentDenials;
    recordVersion: (...args: Parameters<typeof recordVersion>) => unknown;
    now: () => number;
  } = {
    getConfig,
    getConfigSource,
    getAccessPolicy,
    hasSessionNarrowing,
    previewAccessPolicy,
    recentDenials,
    recordVersion,
    now: Date.now,
  },
) {
  let pending: { id: string; expiresAt: number } | null = null;
  const tools = moduleCatalog.flatMap((m) =>
    m.tools.map((t) => ({ name: t.name, risk: riskOf(t.annotations), noDevice: !!t.noDevice })),
  );
  const revision = () =>
    createHash("sha256")
      .update(JSON.stringify([deps.getConfig(), deps.getAccessPolicy()]))
      .digest("hex");
  const payload = (): AccessSettings => {
    const cfg = deps.getConfig();
    const id = admin.pendingId();
    return {
      revision: revision(),
      configured: cfg.access,
      effective: deps.getAccessPolicy(),
      narrowed: deps.hasSessionNarrowing(),
      readOnly: cfg.readOnly,
      devices: Object.entries(cfg.devices).map(([name, d]) => ({ name, disabled: !!d.disabled })),
      tools,
      denials: deps.recentDenials(50),
      fromFile: deps.getConfigSource().fromFile,
      pending: id
        ? {
            id,
            owned: id === pending?.id,
            expiresAt: id === pending?.id ? pending.expiresAt : undefined,
          }
        : null,
    };
  };

  return async (req: Request, url: URL): Promise<Response | null> => {
    const path = url.pathname;
    if (!path.startsWith("/api/access/settings")) return null;
    if (path === "/api/access/settings" && req.method === "GET") return json(payload());
    if (!["preview", "apply", "keep", "rollback"].some((s) => path === `/api/access/settings/${s}`))
      return json({ error: "Not found" }, 404);
    if (req.method !== "POST") return json({ error: "Use POST" }, 405);
    // JSON-only writes cannot be submitted by a cross-site HTML form. The outer
    // dashboard handler also enforces its configured bearer token before routing.
    if (req.headers.get("sec-fetch-site") === "cross-site")
      return json({ error: "Cross-site access changes are not allowed" }, 403);
    if (req.headers.get("content-type")?.split(";")[0].trim() !== "application/json")
      return json({ error: "Expected application/json" }, 415);
    let body: unknown;
    try {
      const text = await req.text();
      if (text.length > 65_536) return json({ error: "Access settings are too large" }, 413);
      body = JSON.parse(text);
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }

    if (path.endsWith("/keep") || path.endsWith("/rollback")) {
      const parsed = idSchema.safeParse(body);
      if (!parsed.success) return json({ error: "A pending change ID is required" }, 400);
      const id = parsed.data.pendingId;
      if (pending?.id !== id || admin.pendingId() !== id)
        return json(
          { error: "This change expired or was replaced. Refresh the current policy." },
          409,
        );
      const keep = path.endsWith("/keep");
      const ok = keep ? admin.keepConfig(id) : admin.rollback(id);
      if (!ok) return json({ error: "This change is no longer pending" }, 409);
      pending = null;
      if (keep) deps.recordVersion(deps.getConfig(), "auto", deps.now(), "access scope updated");
      return json({ ok: true, settings: payload() });
    }

    const parsed = editSchema.safeParse(body);
    if (!parsed.success)
      return json(
        { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") },
        400,
      );
    const { access, tool } = parsed.data;
    if (parsed.data.revision !== revision())
      return json(
        { error: "Configuration changed since you opened this editor. Refresh before applying." },
        409,
      );
    const cfg = deps.getConfig();
    const device = parsed.data.device
      ? Object.keys(cfg.devices).find(
          (key) => key.toLowerCase() === parsed.data.device!.toLowerCase(),
        )
      : cfg.defaultDevice;
    const unknownDevice = [
      ...access.devices,
      ...access.denyDevices,
      ...(parsed.data.device ? [parsed.data.device] : []),
    ].find(
      (name) => !Object.keys(cfg.devices).some((key) => key.toLowerCase() === name.toLowerCase()),
    );
    if (unknownDevice) return json({ error: `Unknown device: ${unknownDevice}` }, 400);
    if (tool && !tools.some((t) => t.name === tool))
      return json({ error: `Unknown tool: ${tool}` }, 400);

    if (path.endsWith("/preview")) {
      const effective = deps.previewAccessPolicy(policyFor(access));
      const current = deps.getAccessPolicy();
      const now = deps.now();
      const decide = (policy: AccessPolicy, t: (typeof tools)[number]): AccessDecision => {
        if (cfg.readOnly && t.risk !== "READ")
          return { allowed: false, reason: "Server-wide read-only mode prevents writes." };
        if (!t.noDevice && (!device || !cfg.devices[device]))
          return {
            allowed: false,
            rule: "device",
            reason: "No configured target router is available.",
          };
        if (!t.noDevice && device && cfg.devices[device]?.disabled)
          return { allowed: false, rule: "device", reason: "This configured device is disabled." };
        return evaluateAccess(policy, {
          tool: t.name,
          risk: t.risk,
          device: t.noDevice ? undefined : device,
          now,
        });
      };
      const result: AccessPreview = {
        effective,
        allowed: 0,
        blocked: 0,
        newlyAllowed: 0,
        newlyBlocked: 0,
        device,
      };
      for (const t of tools) {
        const next = decide(effective, t);
        const prev = decide(current, t);
        result[next.allowed ? "allowed" : "blocked"]++;
        if (next.allowed && !prev.allowed) result.newlyAllowed++;
        if (!next.allowed && prev.allowed) result.newlyBlocked++;
        if (tool === t.name) result.check = next;
      }
      return json({ ok: true, preview: result });
    }

    if (admin.pendingId())
      return json(
        {
          error: "Another configuration change is awaiting confirmation. Keep or revert it first.",
        },
        409,
      );
    // No await between revision comparison and apply: other config writes cannot
    // interleave. Merge ONLY access into the latest complete, unredacted config.
    const res = admin.applyConfig({ ...cfg, access }, 60_000);
    pending = { id: res.pendingId, expiresAt: deps.now() + res.rollbackMs };
    return json({ ok: true, settings: payload() });
  };
}
