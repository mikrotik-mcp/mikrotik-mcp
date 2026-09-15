/**
 * MikroTik Interfaces overview — bespoke MCP App view for `show_interfaces`.
 *
 * Renders each interface as a status card (running / disabled / down, type,
 * MTU, MAC, comment) with a search box and live refresh via the App bridge.
 * DOM is text-node only — no innerHTML.
 */
import { App } from "@modelcontextprotocol/ext-apps";
import { button, connectApp, h, wireHostContext } from "../shared/kit";
import "./styles.css";

interface IfacesView {
  __mikrotikView: "interfaces";
  device: string;
  rows: Record<string, string>[];
  flags: Record<string, string>;
  generatedAt: string;
}

const TOOL_NAME = "show_interfaces";
const root = document.getElementById("app")!;

let view: IfacesView | null = null;
let query = "";
let busy = false;

function isRunning(row: Record<string, string>): boolean {
  return (row.flags ?? "").includes("R") || row.running === "true";
}
function isDisabled(row: Record<string, string>): boolean {
  return (row.flags ?? "").includes("X") || row.disabled === "true";
}

function metaRow(label: string, value: string | undefined): HTMLElement | false {
  return !!value && h("div", { class: "contents" }, h("span", {}, label), h("b", {}, value));
}

function card(row: Record<string, string>): HTMLElement {
  const disabled = isDisabled(row);
  const dotClass = disabled ? "dot is-down" : isRunning(row) ? "dot is-up" : "dot";
  const meta = h(
    "div",
    { class: "if-card__meta" },
    metaRow("MTU", row.mtu ?? row["actual-mtu"]),
    metaRow("MAC", row["mac-address"]),
    metaRow("comment", row.comment),
  );
  return h(
    "div",
    { class: `card if-card${disabled ? " is-disabled" : ""}` },
    h(
      "div",
      { class: "if-card__top" },
      h("span", { class: dotClass }),
      h("span", { class: "if-card__name" }, row.name ?? "?"),
      h("span", { class: "badge" }, row.type ?? "—"),
    ),
    meta,
  );
}

function visibleRows(v: IfacesView): Record<string, string>[] {
  const q = query.trim().toLowerCase();
  if (!q) return v.rows;
  return v.rows.filter((r) => Object.values(r).some((val) => val.toLowerCase().includes(q)));
}

function render(): void {
  if (!view) {
    root.replaceChildren(h("div", { class: "skeleton" }, "Waiting for interfaces…"));
    return;
  }
  const v = view;
  const rows = visibleRows(v);
  const running = v.rows.filter(isRunning).length;
  const disabled = v.rows.filter(isDisabled).length;

  const search = h("input", {
    class: "search",
    type: "search",
    placeholder: `Search ${v.rows.length} interface(s)…`,
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
      h("h1", { class: "hd__title" }, "Interfaces"),
      h(
        "p",
        { class: "hd__sub" },
        `${running} running · ${disabled} disabled · ${v.rows.length} total`,
      ),
    ),
    h("span", { class: "hd__spacer" }),
    h("span", { class: "pill" }, "device ", h("b", {}, v.device)),
  );

  const toolbar = h(
    "div",
    { class: "toolbar" },
    h("div", { class: "grow" }, search),
    button(busy ? "Refreshing…" : "↻ Refresh", refresh, { disabled: busy }),
  );

  const grid = rows.length
    ? h("section", { class: "if-grid" }, ...rows.map(card))
    : h("div", { class: "empty" }, "No interfaces match the search.");

  const footer = h(
    "footer",
    { class: "foot" },
    h("span", { class: "grow" }),
    h("span", {}, `updated ${new Date(v.generatedAt).toLocaleTimeString()}`),
  );

  root.replaceChildren(header, toolbar, grid, footer);
}

const app = new App({ name: "mikrotik-interfaces", version: "1.0.0" });

function adopt(structured: unknown): boolean {
  if (
    structured &&
    typeof structured === "object" &&
    (structured as { __mikrotikView?: string }).__mikrotikView === "interfaces"
  ) {
    view = structured as IfacesView;
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
    console.error("[interfaces] refresh failed", e);
  } finally {
    busy = false;
    render();
  }
}

wireHostContext(app);
app.onteardown = async () => ({});

render();
void connectApp(app, "interfaces", root, adopt);
