/** Evidence-only workspaces: render existing results, never run or replay tools. */
import { App } from "@modelcontextprotocol/ext-apps";
import { REPORT_VIEW_META } from "../../src/core/report-views";
import type { ReportView, ReportViewKind } from "../../src/core/report-views";
import { button, connectApp, copyText, download, h, networkIcon, wireHostContext } from "./kit";
import "./base.css";
import "./report.css";
import { diffElement, isUnifiedDiff } from "./diff";
import "./diff.css";

type Row = Record<string, unknown>;
const object = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => {
  if (value == null) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
    return String(value);
  return JSON.stringify(value) ?? "—";
};
const label = (key: string): string =>
  key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ");
const time = (value: unknown): string => {
  if (value == null) return "Not recorded";
  const date = new Date(typeof value === "number" ? value : text(value));
  return Number.isNaN(date.getTime()) ? text(value) : date.toLocaleString();
};

export function statusBadge(value: unknown): HTMLElement {
  const status = text(value).toLowerCase();
  const tone = ["pass", "observed"].includes(status)
    ? "good"
    : ["fail", "failed", "error", "denied", "blocked", "critical", "high", "partial"].includes(
          status,
        )
      ? "bad"
      : ["unknown", "unverified", "inferred", "medium", "warn", "warning"].includes(status)
        ? "warn"
        : "info";
  return h("span", { class: `report-status is-${tone}` }, text(value));
}

/** JSON tokens stay text nodes; RouterOS strings cannot inject HTML. */
export function jsonEvidence(value: unknown): HTMLElement {
  const raw = JSON.stringify(value, null, 2) ?? "null";
  const code = h("pre", { class: "report-json", tabindex: "0", "aria-label": "JSON evidence" });
  const preview = raw.slice(0, 120_000);
  const tokens =
    /("(?:\\.|[^"\\])*"\s*:?)|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  let offset = 0;
  for (const match of preview.matchAll(tokens)) {
    code.append(document.createTextNode(preview.slice(offset, match.index)));
    const kind = match[1]
      ? match[0].endsWith(":")
        ? "key"
        : "string"
      : match[2]
        ? "literal"
        : "number";
    code.append(h("span", { class: `json-${kind}` }, match[0]));
    offset = match.index + match[0].length;
  }
  code.append(document.createTextNode(preview.slice(offset)));
  if (raw.length > preview.length)
    code.append(h("p", {}, "Preview truncated. Export JSON to read the complete result."));
  return code;
}

function disclosure(title: string, body: HTMLElement): HTMLElement {
  return h("details", { class: "report-disclosure" }, h("summary", {}, title), body);
}
function panel(title: string, ...children: HTMLElement[]): HTMLElement {
  return h(
    "section",
    { class: "report-panel" },
    h("h2", { class: "report-section-title" }, title),
    ...children,
  );
}
function note(message: string): HTMLElement {
  return h("p", { class: "report-note" }, message);
}
function empty(message: string): HTMLElement {
  return h("div", { class: "empty" }, message);
}
function fieldGrid(row: Row, excluded: string[] = []): HTMLElement {
  const entries = Object.entries(row).filter(
    ([key, value]) =>
      !excluded.includes(key) &&
      !key.startsWith("__") &&
      (value == null || typeof value !== "object"),
  );
  return h(
    "dl",
    { class: "report-fields" },
    ...entries
      .slice(0, 30)
      .map(([key, value]) =>
        h(
          "div",
          {},
          h("dt", {}, label(key)),
          h(
            "dd",
            {},
            typeof value === "string" && (key === "unified" || isUnifiedDiff(value))
              ? diffElement(value)
              : ["status", "state", "verdict", "clientOutcome"].includes(key)
                ? statusBadge(value)
                : /(?:At|^ts)$/.test(key)
                  ? time(value)
                  : text(value),
          ),
        ),
      ),
  );
}
function bullets(items: unknown[]): HTMLElement {
  return h("ul", { class: "report-list" }, ...items.map((item) => h("li", {}, text(item))));
}
function node(name: string, caption: string, tone = ""): HTMLElement {
  return h(
    "div",
    { class: `path-node ${tone}` },
    networkIcon(),
    h("span", { class: "path-caption" }, caption),
    h("b", {}, name),
  );
}
function arrow(): HTMLElement {
  return h("span", { class: "path-arrow", "aria-hidden": "true" }, "→");
}

function genericData(data: unknown, query: string): HTMLElement {
  const row = object(data);
  if (Array.isArray(data)) return collection("Records", data, query);
  if (data == null || typeof data !== "object") return plainReport(text(data), query);
  if (!Object.keys(row).length) return empty("No structured fields returned.");
  const nested = Object.entries(row).filter(
    ([, value]) => value !== null && typeof value === "object",
  );
  return h(
    "div",
    { class: "report-stack" },
    fieldGrid(row),
    ...nested.map(([key, value]) =>
      Array.isArray(value)
        ? collection(label(key), value, query)
        : disclosure(
            label(key),
            h("div", { class: "report-inset" }, fieldGrid(object(value)), jsonEvidence(value)),
          ),
    ),
  );
}
function collection(title: string, items: unknown[], query: string): HTMLElement {
  const matches = items.filter((item) => !query || text(item).toLowerCase().includes(query));
  let limit = 24;
  const list = h("div", { class: "report-collection" });
  const render = (): void => {
    list.replaceChildren(
      ...matches.slice(0, limit).map((item) => {
        const row = object(item);
        if (!Object.keys(row).length) return h("p", { class: "report-prose" }, text(item));
        const name =
          row.name ??
          row.title ??
          row.label ??
          row.target ??
          row.source ??
          row.device ??
          row.id ??
          "Record";
        const status = row.status ?? row.state ?? row.severity;
        return h(
          "article",
          { class: "report-record" },
          h(
            "div",
            { class: "report-record-head" },
            h("h3", {}, text(name)),
            status == null ? null : statusBadge(status),
          ),
          fieldGrid(row, ["name", "title", "label", "status", "state", "severity"]),
          disclosure("Record evidence", jsonEvidence(item)),
        );
      }),
    );
    if (!matches.length)
      list.append(
        empty(
          items.length
            ? "No records match your search."
            : "No records returned. Missing records do not prove a healthy or inactive network.",
        ),
      );
    if (matches.length > limit)
      list.append(
        button(`Show more · ${matches.length - limit} remaining`, () => {
          limit += 24;
          render();
        }),
      );
  };
  render();
  return panel(`${title} · ${matches.length}${query ? ` of ${items.length}` : ""}`, list);
}

function investigation(data: Row, query: string): HTMLElement {
  if (Array.isArray(data.forward) || Array.isArray(data.reverse)) {
    return h(
      "div",
      { class: "report-stack" },
      note(
        "Exported flow evidence only. Named interfaces describe exporter records, not proof of VPN encryption or application delivery. No matching records is not proof of a dropped packet.",
      ),
      fieldGrid(data, ["device"]),
      ...["forward", "reverse"].map((direction) =>
        panel(
          `${label(direction)} · reported interfaces`,
          ...array(data[direction]).map((item) => {
            const branch = object(item),
              ingress = object(branch.ingress),
              egress = object(branch.egress);
            return h(
              "article",
              { class: "report-record" },
              h(
                "div",
                { class: "path-strip" },
                node(
                  text(
                    ingress.name ??
                      (branch.inputIf == null
                        ? "Unknown ingress"
                        : `ifIndex ${text(branch.inputIf)}`),
                  ),
                  "Reported ingress",
                ),
                arrow(),
                node(text(data.device), "Exporter router"),
                arrow(),
                node(
                  text(
                    egress.name ??
                      (branch.outputIf == null
                        ? "Unknown exit"
                        : `ifIndex ${text(branch.outputIf)}`),
                  ),
                  `Reported exit · ${text(egress.type ?? "type unknown")}`,
                ),
              ),
              fieldGrid(branch, ["inputIf", "outputIf"]),
            );
          }),
          ...(!array(data[direction]).length
            ? [empty("No matching exported branch. The path remains unverified.")]
            : []),
        ),
      ),
      bullets(array(data.warnings)),
    );
  }
  if (!Array.isArray(data.evidence) || !data.client) return genericData(data, query);
  return h(
    "div",
    { class: "report-stack" },
    panel(
      text(data.service ?? "Client & service"),
      h(
        "div",
        { class: "path-strip" },
        node(text(data.client), "Client"),
        arrow(),
        node(text(data.device), "Access router"),
        arrow(),
        node(text(data.target), "Destination · unverified", "is-unverified"),
      ),
      note(
        "Investigation scope, not a captured packet path. Router ICMP does not prove the client's forward path or application health.",
      ),
      fieldGrid({
        clientOutcome: data.clientOutcome,
        createdAt: data.createdAt,
        finishedAt: data.finishedAt,
      }),
    ),
    collection("Evidence sources", array(data.evidence), query),
    panel("Next experiments · not performed", bullets(array(data.nextTests))),
  );
}

function roundTrip(data: Row): HTMLElement {
  return h(
    "div",
    { class: "report-stack" },
    note(
      "Snapshot simulation, not a live trace. Modelled forwarding never proves endpoint availability. A blocked hop is a model result; unknown means the available evidence cannot settle it.",
    ),
    h(
      "div",
      { class: "report-summary" },
      statusBadge(data.status ?? "unknown"),
      h(
        "span",
        {},
        data.asymmetric === true ? "Declared paths are asymmetric" : "Forward & return analysis",
      ),
      statusBadge("Live delivery unverified"),
    ),
    h(
      "div",
      { class: "report-leg-grid" },
      ...["forward", "reverse"].map((direction) => {
        const leg = object(data[direction]);
        return panel(
          `${label(direction)} path`,
          statusBadge(leg.status ?? "unknown"),
          h(
            "ol",
            { class: "path-hops" },
            ...array(leg.hops).map((item, index) => {
              const hop = object(item);
              return h(
                "li",
                { class: "path-hop" },
                h("span", { class: "path-hop-index" }, String(index + 1)),
                h(
                  "article",
                  { class: "report-record" },
                  h(
                    "div",
                    { class: "report-record-head" },
                    h("h3", {}, text(hop.device)),
                    statusBadge(hop.status ?? "unknown"),
                  ),
                  h(
                    "div",
                    { class: "path-interfaces" },
                    h("code", {}, text(hop.ingress)),
                    arrow(),
                    h("code", {}, text(hop.egress)),
                  ),
                  h("p", { class: "report-prose" }, text(hop.reason)),
                  disclosure("Hop evidence", jsonEvidence(hop.trace ?? hop)),
                ),
              );
            }),
          ),
          ...(!array(leg.hops).length ? [empty("No hop evidence for this direction.")] : []),
        );
      }),
    ),
    panel("Assumptions & boundaries", bullets(array(data.assumptions))),
    collection("Snapshot provenance", array(data.provenance), ""),
  );
}

function serviceHealth(data: Row, query: string): HTMLElement {
  return h(
    "div",
    { class: "report-stack" },
    note(
      "Checks originate from the MCP host, not from the router or client. Definitions do not run probes; saved results are historical, not current health guarantees.",
    ),
    fieldGrid(data),
    ...(Array.isArray(data.checks)
      ? [
          h(
            "div",
            { class: "service-checks" },
            ...data.checks.map((item) => {
              const check = object(item);
              return h(
                "article",
                { class: "report-record" },
                h(
                  "div",
                  { class: "report-record-head" },
                  h("span", { class: "service-protocol" }, text(check.kind ?? "endpoint")),
                  statusBadge(check.status ?? "Definition"),
                ),
                h("h3", { class: "service-target" }, text(check.target)),
                h(
                  "p",
                  { class: "service-latency" },
                  typeof check.durationMs === "number" &&
                    !(check.status === "unknown" && check.durationMs === 0)
                    ? `${check.durationMs.toLocaleString()} ms`
                    : check.maxLatencyMs != null
                      ? `Limit ${text(check.maxLatencyMs)} ms`
                      : "Not measured",
                ),
                h(
                  "p",
                  { class: "report-prose" },
                  text(check.detail ?? "No check has been run by this definition."),
                ),
                disclosure("Check evidence", jsonEvidence(check)),
              );
            }),
          ),
        ]
      : []),
    ...["contracts", "runs", "targets", "findings"]
      .filter((key) => Array.isArray(data[key]))
      .map((key) => collection(label(key), array(data[key]), query)),
  );
}

function fabric(data: Row, query: string): HTMLElement {
  if (!Array.isArray(data.ports)) return genericData(data, query);
  const ports = data.ports.filter((port) => !query || text(port).toLowerCase().includes(query));
  return h(
    "div",
    { class: "report-stack" },
    note(
      "Bridge-learned attachment records. Port roles are inferred from occupancy; hosts behind an uplink are not necessarily plugged directly into that port. Missing records can also reflect hardware offload or unavailable collection.",
    ),
    panel(
      "Fabric inventory",
      fieldGrid(object(data.stats)),
      h(
        "p",
        { class: "report-prose" },
        `${ports.length} of ${data.ports.length} returned ports shown`,
      ),
    ),
    h(
      "div",
      { class: "fabric-grid" },
      ...ports.map((item) => {
        const port = object(item);
        return h(
          "article",
          { class: "report-record fabric-port" },
          h(
            "div",
            { class: "report-record-head" },
            networkIcon(),
            h("h3", {}, text(port.interface)),
            statusBadge(port.role),
          ),
          h(
            "p",
            { class: "fabric-bridge" },
            `Bridge ${text(port.bridge)} · ${text(port.hostCount)} learned hosts`,
          ),
          port.peerIdentity ? note(`Neighbor: ${text(port.peerIdentity)}`) : null,
          h(
            "ul",
            { class: "fabric-hosts" },
            ...array(port.hosts).map((item) => {
              const host = object(item);
              return h(
                "li",
                {},
                h("b", {}, text(host.label)),
                h("code", {}, `${text(host.ip)} · ${text(host.mac)}`),
                h("small", {}, `Name source: ${text(host.nameSource)}`),
              );
            }),
          ),
        );
      }),
    ),
    ...(!ports.length ? [empty("No port records to display.")] : []),
  );
}

function plainReport(raw: string, query: string): HTMLElement {
  if (isUnifiedDiff(raw))
    return !query || raw.toLowerCase().includes(query)
      ? diffElement(raw)
      : empty("No sections match your search.");
  const sections = raw
    .split(/\n\s*\n/)
    .filter((part) => !query || part.toLowerCase().includes(query));
  return h(
    "div",
    { class: "report-stack" },
    ...sections.map((section) => h("pre", { class: "report-prose report-text" }, section)),
    ...(!sections.length
      ? [empty(query ? "No sections match your search." : "No report data returned.")]
      : []),
  );
}

export function renderReport(view: ReportView, query = ""): HTMLElement {
  const data = object(view.data);
  // Searching uses the original evidence tree, so no dedicated visual can silently
  // ignore a query or hide the fact that results are a filtered projection.
  if (query) {
    const lines = (view.data == null ? view.raw : JSON.stringify(view.data, null, 2)).split("\n");
    const matches = lines.flatMap((line, index) =>
      line.toLowerCase().includes(query) ? [`${index + 1}  ${line}`] : [],
    );
    return panel(
      "Search results · original evidence",
      note(
        `${matches.length} matching lines. Line numbers refer to the original result below. This is not a complete path or report.`,
      ),
      matches.length
        ? h("pre", { class: "report-text" }, matches.slice(0, 200).join("\n"))
        : empty("No evidence matches your search."),
      ...(matches.length > 200
        ? [note("Showing the first 200 matching lines. Refine your search.")]
        : []),
    );
  }
  if (view.data == null && view.kind !== "operations") return plainReport(view.raw, query);
  if (view.data != null && (typeof view.data !== "object" || Array.isArray(view.data)))
    return genericData(view.data, query);
  if (view.kind === "round-trip") return roundTrip(data);
  if (view.kind === "investigations") return investigation(data, query);
  if (view.kind === "service-health") return serviceHealth(data, query);
  if (view.kind === "fabric") return fabric(data, query);
  return h(
    "div",
    { class: "report-stack" },
    view.kind === "operations"
      ? note(
          "Result presentation only. This view does not apply, verify, commit or replay changes. Cross-router commits are best-effort, not ACID; a PARTIAL result requires the reported recovery steps.",
        )
      : note(
          "Evidence from the tool result. No live check or corrective action is performed by opening this view.",
        ),
    view.data == null ? plainReport(view.raw, query) : genericData(view.data, query),
  );
}

export function startReportView(kind: ReportViewKind): void {
  const root = document.getElementById("app")!;
  const app = new App({ name: `mikrotik-${kind}`, version: "1.0.0" });
  let view: ReportView | undefined;
  let query = "";
  const render = (): void => {
    if (!view) return;
    const current = view;
    const body = h("div", { class: "report-body" }, renderReport(current));
    const search = h("input", {
      class: "search",
      type: "search",
      placeholder: "Search evidence…",
      "aria-label": "Search evidence",
    }) as HTMLInputElement;
    search.addEventListener("input", () => {
      query = search.value.toLowerCase().trim();
      body.replaceChildren(renderReport(current, query));
    });
    root.replaceChildren(
      h(
        "header",
        { class: "hd" },
        h(
          "div",
          {},
          h("p", { class: "report-eyebrow" }, label(kind)),
          h("h1", { class: "hd__title" }, current.title),
          h("p", { class: "hd__sub" }, current.tool),
        ),
        h("span", { class: "hd__spacer" }),
        h("span", { class: "pill" }, current.device),
      ),
      h(
        "div",
        { class: "toolbar" },
        h("div", { class: "grow" }, search),
        button("Copy result", () => void copyText(current.raw)),
        button("Export JSON", () =>
          download(
            `${current.tool}.json`,
            JSON.stringify(current.data ?? current, null, 2),
            "application/json",
          ),
        ),
      ),
      body,
      disclosure(
        "Original result · JSON & text",
        h(
          "div",
          { class: "report-inset" },
          jsonEvidence(current.data),
          isUnifiedDiff(current.raw)
            ? diffElement(current.raw)
            : h("pre", { class: "report-text" }, current.raw),
        ),
      ),
      h(
        "footer",
        { class: "foot" },
        h("span", {}, "Prepared ", time(current.generatedAt)),
        h("span", { class: "grow" }),
        h("span", {}, "No actions run from this view"),
      ),
    );
  };
  wireHostContext(app);
  root.replaceChildren(h("div", { class: "skeleton" }, "Waiting for the tool result…"));
  void connectApp(app, kind, root, (structured, result) => {
    const candidate = object(result?._meta?.[REPORT_VIEW_META] ?? structured);
    if (
      candidate.__mikrotikView !== "report" ||
      candidate.kind !== kind ||
      typeof candidate.raw !== "string" ||
      typeof candidate.title !== "string"
    )
      return false;
    view = candidate as unknown as ReportView;
    query = "";
    render();
    return true;
  });
}
