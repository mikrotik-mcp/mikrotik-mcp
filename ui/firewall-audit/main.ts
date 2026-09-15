/**
 * MikroTik Firewall Audit — interactive MCP App view for `firewall_audit`.
 *
 * Renders the prioritised findings (high → low) as cards: severity chip, the
 * plain-language explanation, the suggested fix, and — when the server provided
 * a one-click action — a button that calls the matching tool (e.g.
 * `disable_filter_rule`) over the App bridge and re-runs the audit. A risk gauge
 * and severity counts sit up top. Text-node only — no innerHTML.
 */
import { App } from "@modelcontextprotocol/ext-apps";
import { button, connectApp, h, wireHostContext } from "../shared/kit";
import "./styles.css";

type Severity = "high" | "medium" | "low";
interface OneClickAction {
  tool: string;
  args: Record<string, unknown>;
  label: string;
}
interface Finding {
  kind: string;
  severity: Severity;
  table: string;
  chain: string;
  ruleIndex?: number;
  relatedIndex?: number;
  title: string;
  detail: string;
  suggestion: string;
  action?: OneClickAction;
}
interface AuditView {
  __mikrotikView: "firewall-audit";
  device: string;
  riskScore: number;
  grade: string;
  counts: { high: number; medium: number; low: number; total: number };
  ruleCount: number;
  findings: Finding[];
  generatedAt: string;
}

const TOOL_NAME = "firewall_audit";
const root = document.getElementById("app")!;

let view: AuditView | null = null;
let busy = false;
let pending: string | null = null; // a finding currently being actioned

const app = new App({ name: "mikrotik-firewall-audit", version: "1.0.0" });

function gradeClass(grade: string): string {
  if (grade === "clean" || grade === "good") return "is-good";
  if (grade === "fair") return "is-warn";
  return "is-bad";
}

function sevClass(sev: Severity): string {
  return sev === "high" ? "is-bad" : sev === "medium" ? "is-warn" : "is-low";
}

/** A small SVG risk gauge (0–100), coloured by grade. */
function gauge(score: number, grade: string): HTMLElement {
  const r = 34;
  const c = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(100, score)) / 100;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 88 88");
  svg.setAttribute("class", `gauge ${gradeClass(grade)}`);
  const mk = (cls: string, extra: Record<string, string>): SVGCircleElement => {
    const el = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    el.setAttribute("class", cls);
    el.setAttribute("cx", "44");
    el.setAttribute("cy", "44");
    el.setAttribute("r", String(r));
    for (const [k, v] of Object.entries(extra)) el.setAttribute(k, v);
    return el;
  };
  svg.append(mk("gauge__bg", {}));
  svg.append(
    mk("gauge__fg", {
      "stroke-dasharray": `${c * frac} ${c}`,
      transform: "rotate(-90 44 44)",
    }),
  );
  const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
  label.setAttribute("x", "44");
  label.setAttribute("y", "48");
  label.setAttribute("text-anchor", "middle");
  label.setAttribute("class", "gauge__num");
  label.textContent = String(score);
  svg.append(label);
  return svg as unknown as HTMLElement;
}

async function runAction(f: Finding, fid: string): Promise<void> {
  if (!f.action || busy) return;
  pending = fid;
  render();
  try {
    await app.callServerTool({ name: f.action.tool, arguments: f.action.args });
    await refresh(); // re-audit to reflect the change
  } catch (e) {
    console.error("[firewall-audit] action failed", e);
  } finally {
    pending = null;
    render();
  }
}

function findingCard(f: Finding, i: number): HTMLElement {
  const fid = `${f.kind}-${f.table}-${f.ruleIndex ?? f.chain}-${i}`;
  const head = h(
    "div",
    { class: "f-head" },
    h("span", { class: `chip ${sevClass(f.severity)}` }, f.severity),
    h("span", { class: "f-title" }, f.title),
    h("span", { class: "f-where" }, `${f.table}/${f.chain}`),
  );
  const body = h(
    "div",
    { class: "f-body" },
    h("p", { class: "f-detail" }, f.detail),
    h("p", { class: "f-fix" }, h("b", {}, "Fix: "), f.suggestion),
  );
  const card = h("div", { class: `f-card ${sevClass(f.severity)}` }, head, body);
  if (f.action) {
    const label = pending === fid ? "Working…" : f.action.label;
    card.append(
      h(
        "div",
        { class: "f-actions" },
        button(label, () => void runAction(f, fid), {
          class: "btn-danger",
          disabled: busy || pending === fid,
          title: `Calls ${f.action.tool}`,
        }),
      ),
    );
  }
  return card;
}

function render(): void {
  if (!view) {
    root.replaceChildren(h("div", { class: "skeleton" }, "Running firewall audit…"));
    return;
  }
  const v = view;

  const header = h(
    "header",
    { class: "hd" },
    gauge(v.riskScore, v.grade),
    h(
      "div",
      { class: "hd__meta" },
      h("h1", { class: "hd__title" }, "Firewall audit"),
      h(
        "p",
        { class: "hd__sub" },
        `device `,
        h("b", {}, v.device),
        ` · ${v.ruleCount} rules · grade `,
        h("b", { class: gradeClass(v.grade) }, v.grade),
      ),
      h(
        "div",
        { class: "counts" },
        h("span", { class: "chip is-bad" }, `${v.counts.high} high`),
        h("span", { class: "chip is-warn" }, `${v.counts.medium} medium`),
        h("span", { class: "chip is-low" }, `${v.counts.low} low`),
      ),
    ),
    h("span", { class: "hd__spacer" }),
    button(busy ? "Auditing…" : "↻ Re-audit", refresh, { disabled: busy }),
  );

  let content: HTMLElement;
  if (v.findings.length === 0) {
    content = h("div", { class: "empty" }, "No issues found — the ruleset looks clean. ✓");
  } else {
    content = h("div", { class: "f-list" }, ...v.findings.map(findingCard));
  }

  const footer = h(
    "footer",
    { class: "foot" },
    h("span", { class: "grow" }),
    h("span", {}, `updated ${new Date(v.generatedAt).toLocaleTimeString()}`),
  );

  root.replaceChildren(header, content, footer);
}

function adopt(structured: unknown): boolean {
  if (
    structured &&
    typeof structured === "object" &&
    (structured as { __mikrotikView?: string }).__mikrotikView === "firewall-audit"
  ) {
    view = structured as AuditView;
    render();
    return true;
  }
  return false;
}

async function refresh(): Promise<void> {
  if (busy) return;
  busy = true;
  render();
  try {
    const res = await app.callServerTool({ name: TOOL_NAME, arguments: {} });
    adopt((res as { structuredContent?: unknown }).structuredContent);
  } catch (e) {
    console.error("[firewall-audit] refresh failed", e);
  } finally {
    busy = false;
    render();
  }
}

wireHostContext(app);
app.onteardown = async () => ({});

render();
void connectApp(app, "firewall-audit", root, adopt);
