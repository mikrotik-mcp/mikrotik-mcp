/**
 * MikroTik Device Dashboard — MCP App view.
 *
 * Renders the `show_system_dashboard` tool's `structuredContent` as an
 * interactive health dashboard, syncs with the host theme, and offers a live
 * refresh that re-invokes the tool via the App bridge.
 *
 * All DOM is built with `textContent`/element nodes (never innerHTML), so
 * device-supplied strings can never inject markup.
 */
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  getDocumentTheme,
} from "@modelcontextprotocol/ext-apps";
import { connectApp } from "../shared/kit";
import "./styles.css";

interface Derived {
  cpuLoadPct: number | null;
  memUsedBytes: number | null;
  memTotalBytes: number | null;
  memUsedPct: number | null;
  hddUsedBytes: number | null;
  hddTotalBytes: number | null;
  hddUsedPct: number | null;
  temperatureC: number | null;
  voltageV: number | null;
}
interface Dashboard {
  device: string;
  identity: string;
  resource: Record<string, string>;
  health: Record<string, string>;
  routerboard: Record<string, string>;
  derived: Derived;
  generatedAt: string;
}

const TOOL_NAME = "show_system_dashboard";
const root = document.getElementById("app")!;

// ── tiny DOM helper (text/nodes only — no innerHTML) ────────────────────────
type Child = Node | string | null | undefined | false;
function h(tag: string, props: Record<string, string> = {}, ...kids: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") el.className = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === false || kid == null) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function bytes(n: number | null): string {
  if (n == null) return "—";
  const u = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

function severity(pct: number | null): string {
  if (pct == null) return "";
  return pct >= 90 ? "is-bad" : pct >= 70 ? "is-warn" : "is-good";
}

// ── components ──────────────────────────────────────────────────────────────
const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function gauge(label: string, pct: number | null, sub: string): HTMLElement {
  const r = 26;
  const circ = 2 * Math.PI * r;
  const frac = pct == null ? 0 : Math.max(0, Math.min(100, pct)) / 100;
  const svg = svgEl("svg", { width: 64, height: 64, viewBox: "0 0 64 64" });
  const track = svgEl("circle", { cx: 32, cy: 32, r, fill: "none", "stroke-width": 7 });
  track.setAttribute("class", "gauge__track");
  const bar = svgEl("circle", {
    cx: 32,
    cy: 32,
    r,
    fill: "none",
    "stroke-width": 7,
    "stroke-dasharray": circ,
    "stroke-dashoffset": circ * (1 - frac),
  });
  bar.setAttribute("class", `gauge__bar ${severity(pct)}`);
  const txt = svgEl("text", { x: 32, y: 37, "text-anchor": "middle" });
  txt.setAttribute("class", "gauge__pct");
  txt.textContent = pct == null ? "—" : `${Math.round(pct)}%`;
  svg.replaceChildren(track, bar, txt);
  return h(
    "div",
    { class: "card gauge" },
    svg as unknown as Node,
    h(
      "div",
      { class: "gauge__meta" },
      h("p", { class: "card__label" }, label),
      h("small", {}, sub),
    ),
  );
}

function stat(label: string, value: string): HTMLElement {
  return h(
    "div",
    { class: "card" },
    h("p", { class: "card__label" }, label),
    h("div", { class: "card__value" }, value),
  );
}

function kvTable(title: string, obj: Record<string, string>): HTMLElement | null {
  const entries = Object.entries(obj);
  if (entries.length === 0) return null;
  const body = h(
    "div",
    { class: "kv__body" },
    ...entries.flatMap(([k, v]) => [
      h("div", { class: "kv__k" }, k),
      h("div", { class: "kv__v" }, v || "—"),
    ]),
  );
  return h("details", { class: "kv" }, h("summary", {}, `${title} (${entries.length})`), body);
}

// ── render ──────────────────────────────────────────────────────────────────
let current: Dashboard | null = null;
let busy = false;

function render(): void {
  if (!current) {
    root.replaceChildren(h("div", { class: "skeleton" }, "Waiting for device data…"));
    return;
  }
  const d = current;
  const dv = d.derived;
  const ver = d.resource.version ?? "?";
  const board = d.routerboard.model ?? d.resource["board-name"] ?? "?";

  const gauges = [
    gauge("CPU load", dv.cpuLoadPct, `${d.resource["cpu-count"] ?? "?"} cores`),
    gauge("Memory", dv.memUsedPct, `${bytes(dv.memUsedBytes)} / ${bytes(dv.memTotalBytes)}`),
    dv.hddUsedPct != null &&
      gauge("Disk", dv.hddUsedPct, `${bytes(dv.hddUsedBytes)} / ${bytes(dv.hddTotalBytes)}`),
  ].filter(Boolean) as HTMLElement[];

  const stats = [
    stat("Uptime", d.resource.uptime ?? "—"),
    dv.temperatureC != null && stat("Temperature", `${dv.temperatureC} °C`),
    dv.voltageV != null && stat("Voltage", `${dv.voltageV} V`),
    stat("Architecture", d.resource["architecture-name"] ?? "—"),
  ].filter(Boolean) as HTMLElement[];

  const refreshBtn = h("button", { class: "btn" }, busy ? "Refreshing…" : "↻ Refresh");
  if (busy) refreshBtn.setAttribute("disabled", "true");
  refreshBtn.addEventListener("click", refresh);

  const pill = h("span", { class: "pill" }, "device ", h("b", {}, d.device));

  const header = h(
    "header",
    { class: "hd" },
    h("span", { class: "hd__dot" }),
    h(
      "div",
      {},
      h("h1", { class: "hd__title" }, d.identity),
      h("p", { class: "hd__sub" }, `${board} · RouterOS ${ver}`),
    ),
    h("span", { class: "hd__spacer" }),
    pill,
  );
  const footer = h(
    "footer",
    { class: "foot" },
    refreshBtn,
    h("span", {}, `updated ${new Date(d.generatedAt).toLocaleTimeString()}`),
  );

  const children = [
    header,
    h("section", { class: "grid" }, ...gauges),
    h("section", { class: "grid" }, ...stats),
    kvTable("System resource", d.resource),
    kvTable("RouterBOARD", d.routerboard),
    footer,
  ].filter((c): c is HTMLElement => c != null);

  root.replaceChildren(...children);
}

// ── bridge ──────────────────────────────────────────────────────────────────
const app = new App({ name: "mikrotik-dashboard", version: "1.0.0" });

function adopt(structured: unknown): boolean {
  if (structured && typeof structured === "object" && "device" in structured) {
    current = structured as Dashboard;
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
    console.error("[dashboard] refresh failed", e);
  } finally {
    busy = false;
    render();
  }
}

app.onhostcontextchanged = (ctx) => {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
  if (ctx.safeAreaInsets) {
    const { top, right, bottom, left } = ctx.safeAreaInsets;
    document.body.style.padding = `${top + 16}px ${right + 16}px ${bottom + 16}px ${left + 16}px`;
  }
};
app.onteardown = async () => ({});

applyDocumentTheme(getDocumentTheme());
render();
void connectApp(app, "dashboard", root, adopt);
