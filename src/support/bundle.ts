import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Investigation } from "../investigations/model";
import type { ToolEvent } from "../observability/event";
import type { Snapshot } from "../snapshots/store";
import type { CheckSession } from "../client-check/model";
import { summarizeRun } from "../client-check/model";
import { parseExport } from "../policy/parse";

export const bundleInput = z
  .object({
    since: z.number().int().positive(),
    until: z.number().int().positive(),
    cases: z.array(z.uuid()).max(10).default([]),
    includeEvents: z.boolean().default(true),
    includeSnapshots: z.boolean().default(true),
    includeChecks: z.boolean().default(true),
  })
  .refine(
    (v) => v.until >= v.since && v.until - v.since <= 7 * 86400000,
    "Choose a time range of at most seven days.",
  );
export interface Bundle {
  id: string;
  device: string;
  devices: string[];
  createdAt: number;
  status: "ready";
  report: Record<string, unknown>;
  digest: string;
}
export interface BundleEvidence {
  device: string;
  cases: Investigation[];
  events: ToolEvent[];
  snapshots: Snapshot[];
  checks: CheckSession[];
  missing: string[];
}

/** Minimise FIRST: free-form logs, exports, tool payloads and names never enter the report.
 * Consistent aliases preserve relationships within one bundle; the reverse map is discarded. */
export function buildBundle(input: z.infer<typeof bundleInput>, data: BundleEvidence): Bundle {
  const aliases = new Map<string, string>(),
    counts = new Map<string, number>();
  const alias = (type: string, value: string) => {
    const key = `${type}:${value}`;
    if (!aliases.has(key)) {
      const n = (counts.get(type) ?? 0) + 1;
      counts.set(type, n);
      aliases.set(key, `${type}-${n}`);
    }
    return aliases.get(key)!;
  };
  const fields = new Set([
    "address",
    "active-address",
    "mac-address",
    "active-mac-address",
    "interface",
    "actual-interface",
    "bridge",
    "gateway",
    "dst-address",
    "src-address",
    "routing-table",
    "new-routing-mark",
    "src-address-list",
    "dst-address-list",
    "in-interface",
    "out-interface",
    "name",
    "server",
    "servers",
    "dynamic-servers",
    "network",
    "pool",
  ]);
  const category = (key: string) =>
    /mac-address/.test(key)
      ? "mac"
      : /interface|bridge/.test(key)
        ? "interface"
        : /address|gateway|network|servers/.test(key)
          ? "address"
          : "name";
  const safeRows = (rows: Record<string, string>[]) =>
    rows.slice(0, 100).map((r) =>
      Object.fromEntries(
        Object.entries(r)
          .filter(([k]) => fields.has(k))
          .map(([k, v]) => [k, alias(category(k), v)]),
      ),
    );
  const inRange = (t: number) => t >= input.since && t <= input.until;
  const report = {
    format: "mikrotik-support/v1",
    createdAt: new Date().toISOString(),
    router: alias("router", data.device),
    window: { from: new Date(input.since).toISOString(), to: new Date(input.until).toISOString() },
    privacy: {
      mode: "minimised",
      removed: [
        "Credentials and private keys",
        "Raw config, log messages, tool arguments and output",
        "Comments, labels, hostnames and personal names",
        "Browser tokens and user agent",
      ],
      aliases: "Local to this bundle. Reverse mapping is not saved.",
      review:
        "Review timestamps, counts and network relationships before sharing. This is minimisation, not a guarantee of anonymity.",
    },
    cases: data.cases
      .filter((c) => input.cases.includes(c.id) && inRange(c.createdAt))
      .map((c) => ({
        id: alias("case", c.id),
        at: c.createdAt,
        client: alias("address", c.client),
        target: alias("address", c.target),
        clientOutcome: c.clientOutcome,
        evidence: c.evidence.map((e) => ({
          source: /^[\w-]+$/.test(e.source) ? e.source : "other",
          router: alias("router", e.device),
          at: e.finishedAt,
          state: e.state,
          truncated: e.truncated,
          rows: safeRows(e.rows),
        })),
      })),
    events: input.includeEvents
      ? data.events
          .filter((e) => inRange(e.ts))
          .slice(0, 200)
          .map((e) => ({
            at: e.ts,
            tool: /^[a-z_0-9]+$/.test(e.tool) ? e.tool : "unknown",
            risk: e.risk,
            durationMs: e.durationMs,
            outcome: e.isError ? "error" : "ok",
          }))
      : [],
    snapshots: input.includeSnapshots
      ? data.snapshots
          .filter((s) => inRange(s.ts))
          .slice(0, 20)
          .map((s) => ({
            at: s.ts,
            sections: parseExport(s.body).sections.map((sec) => ({
              path: /^\/[a-z/-]+$/.test(sec.path) ? sec.path : "/unparsed",
              records: sec.records.length,
            })),
            unparsed: parseExport(s.body).unparsed.length,
          }))
      : [],
    clientChecks: input.includeChecks
      ? data.checks
          .flatMap((s) =>
            s.runs
              .filter((r) => inRange(r.receivedAt))
              .map((r) => ({
                at: r.receivedAt,
                case: s.caseId ? alias("case", s.caseId) : null,
                path: r.path,
                endpoint: alias("endpoint", r.endpoint),
                family: r.family,
                ...summarizeRun(r),
              })),
          )
          .slice(0, 100)
      : [],
    unknowns: [
      ...data.missing,
      "Historical evidence is not current network state.",
      "Successful router calls do not prove client application delivery.",
      "Packet contents, raw logs and secrets are intentionally excluded.",
    ],
    limits: { events: 200, snapshots: 20, cases: 10, rowsPerSource: 100, clientRuns: 100 },
  };
  const digest = createHash("sha256").update(JSON.stringify(report)).digest("hex");
  return {
    id: randomUUID(),
    device: data.device,
    devices: [...new Set([data.device, ...data.cases.flatMap((c) => c.devices)])],
    createdAt: Date.now(),
    status: "ready",
    report,
    digest,
  };
}
export function bundleHtml(bundle: Bundle): string {
  const escape = (s: string) =>
    s.replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
    );
  const groups = [
    ["cases", "Investigation cases"],
    ["events", "Tool activity"],
    ["snapshots", "Configuration inventories"],
    ["clientChecks", "Client measurements"],
  ].map(([key, label]) => ({
    label,
    rows: Array.isArray(bundle.report[key]) ? bundle.report[key] : [],
  }));
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Network support evidence</title><style>
  :root{color-scheme:dark}*{box-sizing:border-box}body{font:15px/1.65 system-ui;margin:0;background:#101827;color:#e0e8f5}main{max-width:1000px;margin:auto;padding:48px 24px}header{border-bottom:1px solid #33465d;padding-bottom:24px;margin-bottom:24px}h1{font-size:clamp(28px,5vw,42px);line-height:1.15;letter-spacing:-.04em;max-width:650px}h2{font-size:18px}p,small{color:#a9b9ce}.eyebrow{font:11px monospace;letter-spacing:.16em;color:#99baff}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:24px 0}.metric,details,.note{border:1px solid #33465d;border-radius:14px;background:#172337;padding:20px}.metric strong{display:block;font:28px monospace;color:#99baff}.metric span{font-size:12px}details{margin:12px 0}summary{cursor:pointer;font-weight:600}summary:focus-visible{outline:2px solid #99baff;outline-offset:6px}pre{margin:16px 0 0;max-height:480px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.8 monospace}small{display:block;overflow-wrap:anywhere}footer{margin-top:28px}.note{border-left:3px solid #99baff}@media print{body{background:white;color:#172337}.metric,details,.note{background:white}pre{max-height:none}}
  </style><main><header><p class="eyebrow">MIKROTIK MCP / SUPPORT EVIDENCE</p><h1>A smaller report.<br>A clearer conversation.</h1><p>Historical, minimised evidence. No commands, external assets or scripts.</p><small>Prepared ${escape(new Date(bundle.createdAt).toISOString())}</small></header>
  <div class="metrics">${groups.map((g) => `<div class="metric"><strong>${g.rows.length}</strong><span>${g.label}</span></div>`).join("")}</div>
  <section class="note"><h2>Review before sharing</h2><p>Addresses and names are aliases. Credentials, raw configuration and tool bodies are excluded. Timestamps and network relationships can still identify an environment; this is not a guarantee of anonymity.</p></section>
  ${groups.map((g) => `<details><summary>${g.label} · ${g.rows.length}</summary>${g.rows.length ? `<pre>${escape(JSON.stringify(g.rows, null, 2))}</pre>` : "<p>No evidence included. This does not prove absence of an issue.</p>"}</details>`).join("")}
  <details open><summary>Scope and evidence limits</summary><pre>${escape(JSON.stringify({ window: bundle.report.window, unknowns: bundle.report.unknowns, limits: bundle.report.limits }, null, 2))}</pre></details>
  <details><summary>Complete JSON report</summary><pre>${escape(JSON.stringify(bundle.report, null, 2))}</pre></details>
  <footer><small>SHA-256 of JSON report: ${escape(bundle.digest)}</small><p>This file is local. It has not been uploaded or sent to support.</p></footer></main></html>`;
}
