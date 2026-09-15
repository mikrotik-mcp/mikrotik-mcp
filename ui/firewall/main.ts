/**
 * MikroTik Firewall rules — bespoke MCP App view for `show_firewall_filter`.
 *
 * Renders the ordered filter ruleset as a table: index, chain, colour-coded
 * action, key matchers (protocol, src/dst, interfaces, ports) and packet/byte
 * counters, with disabled rules dimmed. Search by chain/action filter chips,
 * live refresh and CSV export via the App bridge. Text-node only — no innerHTML.
 */
import { App } from "@modelcontextprotocol/ext-apps";
import { button, connectApp, download, h, toCsv, wireHostContext } from "../shared/kit";
import "./styles.css";

interface FirewallView {
  __mikrotikView: "firewall";
  device: string;
  chain: string;
  rows: Record<string, string>[];
  flags: Record<string, string>;
  generatedAt: string;
}

const TOOL_NAME = "show_firewall_filter";
const root = document.getElementById("app")!;

let view: FirewallView | null = null;
let query = "";
let busy = false;

const MATCHER_KEYS = [
  "protocol",
  "src-address",
  "dst-address",
  "src-port",
  "dst-port",
  "in-interface",
  "out-interface",
  "in-interface-list",
  "out-interface-list",
  "connection-state",
  "src-address-list",
  "dst-address-list",
];

function actionClass(action: string): string {
  if (action === "accept") return "act is-accept";
  if (action === "drop" || action === "reject") return "act is-drop";
  if (action === "jump" || action === "return") return "act is-jump";
  return "act";
}

/** Compact integer formatting for counters (12.3k, 4.5M). */
function compact(value: string | undefined): string {
  const n = Number(value);
  if (!value || Number.isNaN(n)) return value ?? "—";
  if (n < 1000) return String(n);
  const u = ["k", "M", "G", "T"];
  let i = -1;
  let v = n;
  while (v >= 1000 && i < u.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v.toFixed(1)}${u[i]}`;
}

function matchers(row: Record<string, string>): HTMLElement {
  const parts: HTMLElement[] = [];
  for (const k of MATCHER_KEYS) {
    if (row[k]) parts.push(h("span", {}, `${k}=`, h("b", {}, row[k])));
  }
  const wrap = h("td", { class: "matchers" });
  parts.forEach((p, i) => {
    if (i) wrap.append(document.createTextNode("  "));
    wrap.append(p);
  });
  if (!parts.length) wrap.append(document.createTextNode(row.comment ?? "—"));
  return wrap;
}

function visibleRows(v: FirewallView): Record<string, string>[] {
  const q = query.trim().toLowerCase();
  if (!q) return v.rows;
  return v.rows.filter((r) => Object.values(r).some((val) => val.toLowerCase().includes(q)));
}

function ruleRow(row: Record<string, string>): HTMLElement {
  const disabled = (row.flags ?? "").includes("X");
  const action = row.action ?? "—";
  const tr = h("tr", disabled ? { class: "is-disabled" } : {});
  tr.append(
    h("td", { class: "col-num" }, row["#"] ?? "—"),
    h("td", {}, row.chain ?? "—"),
    h("td", {}, h("span", { class: actionClass(action) }, action)),
    matchers(row),
    h("td", { class: "num" }, compact(row.packets)),
    h("td", { class: "num" }, compact(row.bytes)),
  );
  return tr;
}

function render(): void {
  if (!view) {
    root.replaceChildren(h("div", { class: "skeleton" }, "Waiting for firewall rules…"));
    return;
  }
  const v = view;
  const rows = visibleRows(v);
  const disabled = v.rows.filter((r) => (r.flags ?? "").includes("X")).length;

  const search = h("input", {
    class: "search",
    type: "search",
    placeholder: `Search ${v.rows.length} rule(s)…`,
    value: query,
  }) as HTMLInputElement;
  search.addEventListener("input", () => {
    query = search.value;
    render();
  });

  const header = h(
    "header",
    { class: "hd" },
    h("span", { class: "hd__dot" }),
    h(
      "div",
      {},
      h("h1", { class: "hd__title" }, "Firewall — Filter"),
      h("p", { class: "hd__sub" }, `${v.rows.length} rules · ${disabled} disabled`),
    ),
    h("span", { class: "hd__spacer" }),
    h("span", { class: "pill" }, "device ", h("b", {}, v.device)),
  );

  const toolbar = h(
    "div",
    { class: "toolbar" },
    h("div", { class: "grow" }, search),
    button(busy ? "Refreshing…" : "↻ Refresh", refresh, { disabled: busy }),
    button(
      "CSV",
      () => {
        const cols = ["#", "chain", "action", ...MATCHER_KEYS, "packets", "bytes"];
        download(`firewall-${v.chain}.csv`, toCsv(cols, visibleRows(v)), "text/csv");
      },
      { title: "Export visible rules as CSV" },
    ),
  );

  let content: HTMLElement;
  if (!v.rows.length) {
    content = h("div", { class: "empty" }, "No filter rules configured.");
  } else if (!rows.length) {
    content = h("div", { class: "empty" }, "No rules match the search.");
  } else {
    const thead = h(
      "thead",
      {},
      h(
        "tr",
        {},
        h("th", { class: "col-num" }, "#"),
        h("th", {}, "chain"),
        h("th", {}, "action"),
        h("th", {}, "matchers"),
        h("th", { class: "num" }, "packets"),
        h("th", { class: "num" }, "bytes"),
      ),
    );
    content = h(
      "div",
      { class: "tablewrap" },
      h("table", { class: "tbl" }, thead, h("tbody", {}, ...rows.map(ruleRow))),
    );
  }

  const footer = h(
    "footer",
    { class: "foot" },
    h("span", { class: "grow" }),
    h("span", {}, `updated ${new Date(v.generatedAt).toLocaleTimeString()}`),
  );

  root.replaceChildren(header, toolbar, content, footer);
}

const app = new App({ name: "mikrotik-firewall", version: "1.0.0" });

function adopt(structured: unknown): boolean {
  if (
    structured &&
    typeof structured === "object" &&
    (structured as { __mikrotikView?: string }).__mikrotikView === "firewall"
  ) {
    view = structured as FirewallView;
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
    console.error("[firewall] refresh failed", e);
  } finally {
    busy = false;
    render();
  }
}

wireHostContext(app);
app.onteardown = async () => ({});

render();
void connectApp(app, "firewall", root, adopt);
