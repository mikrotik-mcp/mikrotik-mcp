import { diffElement, isUnifiedDiff } from "../shared/diff";
import "../shared/diff.css";
/**
 * MikroTik Records Viewer — the generic MCP App view shared by every read tool
 * (`list_*` / `get_*` / `show_*` / `print_*`).
 *
 * The registry attaches this view to read tools automatically and derives a
 * `RecordsView` payload (`{ columns, rows, flags, raw, … }`) from the tool's
 * text output. This view renders that payload as:
 *
 *   • a searchable / sortable / flag-filterable table for multi-row lists,
 *   • a key/value detail grid for a single record, or
 *   • the raw text (always carried as a fallback) when nothing parsed.
 *
 * Features: live refresh + auto-poll via the App bridge, CSV/JSON export, copy,
 * and click-to-expand row drill-down. All DOM is built with text nodes (never
 * innerHTML), so device-supplied strings can't inject markup.
 */
import { App } from "@modelcontextprotocol/ext-apps";
import { button, connectApp, copyText, download, h, toCsv, wireHostContext } from "../shared/kit";
import "./styles.css";

interface RecordsView {
  __mikrotikView: "records";
  tool: string;
  title: string;
  kind: "list" | "record";
  format: string;
  columns: string[];
  rows: Record<string, string>[];
  flags: Record<string, string>;
  count: number;
  raw: string;
  generatedAt: string;
}

const root = document.getElementById("app")!;

// ── view state ──────────────────────────────────────────────────────────────
let view: RecordsView | null = null;
let query = "";
let sortCol: string | null = null;
let sortDir: 1 | -1 = 1;
const activeFlags = new Set<string>();
let selected: number | null = null;
let busy = false;
let autoMs = 0;
let autoTimer: ReturnType<typeof setInterval> | null = null;
let lastArgs: Record<string, unknown> = {};

// ── helpers ───────────────────────────────────────────────────────────────
/** Order columns with the index/flags first, then the rest as-is. */
function orderedColumns(v: RecordsView): string[] {
  const lead = ["#", "flags"].filter((c) => v.columns.includes(c));
  return [...lead, ...v.columns.filter((c) => !lead.includes(c))];
}

/** Apply search + flag filters, then the active sort. */
function visibleRows(v: RecordsView): Record<string, string>[] {
  const q = query.trim().toLowerCase();
  let rows = v.rows;
  if (q) {
    rows = rows.filter((r) => Object.values(r).some((val) => val.toLowerCase().includes(q)));
  }
  if (activeFlags.size) {
    rows = rows.filter((r) => {
      const f = r.flags ?? "";
      return [...activeFlags].every((letter) => f.includes(letter));
    });
  }
  if (sortCol) {
    const col = sortCol;
    rows = [...rows].sort((a, b) => {
      const av = a[col] ?? "";
      const bv = b[col] ?? "";
      const an = Number(av);
      const bn = Number(bv);
      const numeric = av !== "" && bv !== "" && !Number.isNaN(an) && !Number.isNaN(bn);
      const cmp = numeric ? an - bn : av.localeCompare(bv);
      return cmp * sortDir;
    });
  }
  return rows;
}

/** Flag letters actually present across the rows (for the filter chips). */
function presentFlags(v: RecordsView): string[] {
  const set = new Set<string>();
  for (const r of v.rows) for (const ch of r.flags ?? "") set.add(ch);
  return [...set].sort();
}

function rowToCli(row: Record<string, string>): string {
  return Object.entries(row)
    .filter(([k]) => k !== "#" && k !== "flags")
    .map(([k, val]) => (/\s/.test(val) ? `${k}="${val}"` : `${k}=${val}`))
    .join(" ");
}

// ── components ──────────────────────────────────────────────────────────────
function flagChips(v: RecordsView): HTMLElement | false {
  const flags = presentFlags(v);
  if (!flags.length) return false;
  return h(
    "div",
    { class: "toolbar" },
    ...flags.map((letter) => {
      const meaning = v.flags[letter] ?? letter;
      const on = activeFlags.has(letter);
      return button(
        `${letter} · ${meaning}`,
        () => {
          if (on) activeFlags.delete(letter);
          else activeFlags.add(letter);
          render();
        },
        { class: on ? "is-active" : "", title: `Filter rows flagged "${meaning}"` },
      );
    }),
  );
}

function headerCell(col: string): HTMLElement {
  const isNum = col === "#";
  const th = h("th", isNum ? { class: "col-num" } : {}, col);
  if (sortCol === col) th.append(h("span", { class: "arrow" }, sortDir === 1 ? "▲" : "▼"));
  th.addEventListener("click", () => {
    if (sortCol === col) sortDir = sortDir === 1 ? -1 : 1;
    else {
      sortCol = col;
      sortDir = 1;
    }
    render();
  });
  return th;
}

function table(v: RecordsView, rows: Record<string, string>[]): HTMLElement {
  const cols = orderedColumns(v);
  const thead = h("thead", {}, h("tr", {}, ...cols.map(headerCell)));
  const body = h("tbody");
  rows.forEach((row) => {
    const disabled = (row.flags ?? "").includes("X");
    const tr = h("tr", disabled ? { class: "is-disabled" } : {});
    for (const c of cols) {
      tr.append(h("td", c === "#" ? { class: "col-num" } : {}, row[c] ?? "—"));
    }
    // Drill-down: open the detail drawer for this row (by its identity in v.rows).
    tr.addEventListener("click", () => {
      selected = v.rows.indexOf(row);
      render();
    });
    body.append(tr);
  });
  return h("div", { class: "tablewrap" }, h("table", { class: "tbl" }, thead, body));
}

function detailGrid(row: Record<string, string>): HTMLElement {
  const body = h("div", { class: "kv__body" });
  for (const [k, val] of Object.entries(row)) {
    body.append(h("div", { class: "kv__k" }, k), h("div", { class: "kv__v" }, val || "—"));
  }
  return body;
}

function drawer(v: RecordsView): HTMLElement | false {
  if (selected == null || !v.rows[selected]) return false;
  const row = v.rows[selected];
  const titleVal = row.name ?? row["#"] ?? "record";
  return h(
    "div",
    { class: "drawer" },
    h(
      "div",
      { class: "drawer__hd" },
      h("span", {}, "Row "),
      h("b", {}, String(titleVal)),
      h("span", { class: "hd__spacer" }),
      button("Copy as CLI", () => void copyText(rowToCli(row)), { title: "Copy key=value pairs" }),
      button("Close", () => {
        selected = null;
        render();
      }),
    ),
    detailGrid(row),
  );
}

function toolbar(v: RecordsView, shown: number): HTMLElement {
  const search = h("input", {
    class: "search",
    type: "search",
    placeholder: `Search ${v.count} row${v.count === 1 ? "" : "s"}…`,
    value: query,
  }) as HTMLInputElement;
  search.addEventListener("input", () => {
    query = search.value;
    selected = null;
    renderResultsOnly();
  });

  const autoSel = h("select", {
    class: "btn",
    title: "Auto-refresh interval",
  }) as HTMLSelectElement;
  for (const [label, ms] of [
    ["Auto: off", "0"],
    ["Auto: 5s", "5000"],
    ["Auto: 15s", "15000"],
    ["Auto: 60s", "60000"],
  ] as const) {
    const opt = h("option", { value: ms }, label) as HTMLOptionElement;
    if (Number(ms) === autoMs) opt.selected = true;
    autoSel.append(opt);
  }
  autoSel.addEventListener("change", () => setAuto(Number(autoSel.value)));

  const rowsForExport = (): Record<string, string>[] => visibleRows(v);
  const cols = orderedColumns(v);

  return h(
    "div",
    { class: "toolbar" },
    h("div", { class: "grow" }, search),
    button(busy ? "Refreshing…" : "↻ Refresh", refresh, { disabled: busy }),
    autoSel,
    button("CSV", () => download(`${v.tool}.csv`, toCsv(cols, rowsForExport()), "text/csv"), {
      title: "Export visible rows as CSV",
    }),
    button(
      "JSON",
      () =>
        download(`${v.tool}.json`, JSON.stringify(rowsForExport(), null, 2), "application/json"),
      { title: "Export visible rows as JSON" },
    ),
    button("Copy", () => void copyText(JSON.stringify(rowsForExport(), null, 2)), {
      title: "Copy visible rows as JSON",
    }),
    h("span", { class: "pill count-pill" }, "showing ", h("b", {}, `${shown}/${v.count}`)),
  );
}

// ── render ──────────────────────────────────────────────────────────────────
function header(v: RecordsView): HTMLElement {
  return h(
    "header",
    { class: "hd" },
    h("span", { class: "hd__dot" }),
    h("div", {}, h("h1", { class: "hd__title" }, v.title), h("p", { class: "hd__sub" }, v.tool)),
    h("span", { class: "hd__spacer" }),
  );
}

/** Re-render only the results region without rebuilding the search box (keeps focus). */
function renderResultsOnly(): void {
  if (!view) return;
  const slot = document.getElementById("results");
  if (!slot) {
    render();
    return;
  }
  slot.replaceChildren(results(view));
  const countPill = document.querySelector(".count-pill b");
  if (countPill) countPill.textContent = `${visibleRows(view).length}/${view.count}`;
}

function results(v: RecordsView): HTMLElement {
  const rows = visibleRows(v);
  if (v.rows.length === 0) {
    return v.raw
      ? isUnifiedDiff(v.raw)
        ? diffElement(v.raw)
        : h("pre", { class: "raw" }, v.raw)
      : h("div", { class: "empty" }, "No records returned.");
  }
  if (v.kind === "record" && v.rows.length === 1) return detailGrid(v.rows[0]);
  if (rows.length === 0) return h("div", { class: "empty" }, "No rows match the current filter.");
  return table(v, rows);
}

function render(): void {
  if (!view) {
    root.replaceChildren(h("div", { class: "skeleton" }, "Waiting for data…"));
    return;
  }
  const v = view;
  const shown = visibleRows(v).length;
  const isList = v.kind === "list" && v.rows.length > 0;

  const children: (HTMLElement | false)[] = [
    header(v),
    isList && toolbar(v, shown),
    isList && flagChips(v),
    h("div", { id: "results" }, results(v)),
    drawer(v),
    h(
      "footer",
      { class: "foot" },
      h("span", {}, `format: ${v.format}`),
      h("span", { class: "grow" }),
      h("span", {}, `updated ${new Date(v.generatedAt).toLocaleTimeString()}`),
    ),
  ];
  root.replaceChildren(...(children.filter(Boolean) as HTMLElement[]));
}

// ── bridge ──────────────────────────────────────────────────────────────────
const app = new App({ name: "mikrotik-records", version: "1.0.0" });

function adopt(structured: unknown): boolean {
  if (
    structured &&
    typeof structured === "object" &&
    (structured as { __mikrotikView?: string }).__mikrotikView === "records"
  ) {
    view = structured as RecordsView;
    selected = null;
    render();
    return true;
  }
  return false;
}

async function refresh(): Promise<void> {
  if (busy || !view) return;
  busy = true;
  render();
  try {
    const res = await app.callServerTool({ name: view.tool, arguments: lastArgs });
    adopt((res as { structuredContent?: unknown }).structuredContent);
  } catch (e) {
    console.error("[records] refresh failed", e);
  } finally {
    busy = false;
    render();
  }
}

function setAuto(ms: number): void {
  autoMs = ms;
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
  }
  if (ms > 0) autoTimer = setInterval(() => void refresh(), ms);
  render();
}

app.ontoolinput = (input) => {
  // Remember the arguments so Refresh re-runs the same query.
  if (input && typeof input === "object" && "arguments" in input) {
    lastArgs = ((input as { arguments?: Record<string, unknown> }).arguments ?? {}) as Record<
      string,
      unknown
    >;
  }
};
wireHostContext(app);
app.onteardown = async () => {
  if (autoTimer) clearInterval(autoTimer);
  return {};
};

render();
void connectApp(app, "records", root, adopt);
