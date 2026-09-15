/**
 * Connected Devices — MCP App view.
 *
 * Renders the `list_connected_devices` tool's `structuredContent` as an
 * interactive table: per device its IP, MAC, name, status and static/blocked
 * state. Selecting a device polls `get_device_traffic` and draws a live
 * Download/Upload chart plus cumulative totals. Block/Allow and Pin-IP call the
 * server tools back through the App bridge and adopt the refreshed list.
 *
 * All DOM is built with textContent/element nodes (never innerHTML).
 */
import { App } from "@modelcontextprotocol/ext-apps";
import { h, button, bytes, connectApp, wireHostContext } from "../shared/kit";
import "./styles.css";

interface Device {
  mac: string;
  ip: string;
  host: string;
  iface: string;
  server: string;
  status: string;
  static: boolean;
  blocked: boolean;
  lastSeen: string;
  comment: string;
}
interface DevicesView {
  __mikrotikView: "connected-devices";
  devices: Device[];
  counts: { total: number; blocked: number; static: number };
  generatedAt: string;
}
interface TrafficSample {
  __mikrotikView: "device-traffic";
  ip: string;
  source: string;
  rxBitsPerSec: number;
  txBitsPerSec: number;
  rxBytes: number;
  txBytes: number;
  ts: string;
}

const root = document.getElementById("app")!;
const SVG = "http://www.w3.org/2000/svg";
const MAX_SAMPLES = 40;
const POLL_MS = 2000;

let view: DevicesView | null = null;
let selected: string | null = null; // selected MAC
let history: { rx: number; tx: number }[] = [];
let latest: TrafficSample | null = null;
let busy = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let autoTimer: ReturnType<typeof setInterval> | null = null;

const app = new App({ name: "mikrotik-connected-devices", version: "1.0.0" });

// ── helpers ──────────────────────────────────────────────────────────────────
function mbps(bitsPerSec: number): string {
  return `${(bitsPerSec / 1e6).toFixed(2)} Mbps`;
}
function selectedDevice(): Device | undefined {
  return view?.devices.find((d) => d.mac === selected);
}

// ── live traffic polling for the selected device ─────────────────────────────
function stopPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}
function startPolling(ip: string): void {
  stopPolling();
  history = [];
  latest = null;
  const tick = async (): Promise<void> => {
    try {
      const res = await app.callServerTool({ name: "get_device_traffic", arguments: { ip } });
      const s = (res as { structuredContent?: TrafficSample }).structuredContent;
      if (!s || s.ip !== ip) return;
      latest = s;
      history.push({ rx: s.rxBitsPerSec, tx: s.txBitsPerSec });
      if (history.length > MAX_SAMPLES) history.shift();
      renderDetail();
    } catch (e) {
      console.error("[connected-devices] traffic poll failed", e);
    }
  };
  void tick();
  pollTimer = setInterval(() => void tick(), POLL_MS);
}

// ── the Download/Upload chart (hand-rolled SVG, no deps) ──────────────────────
function chart(): SVGElement {
  const W = 460;
  const Ht = 140;
  const pad = 6;
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${Ht}`);
  svg.setAttribute("class", "traffic-chart");
  const max = Math.max(1, ...history.flatMap((p) => [p.rx, p.tx]));
  const x = (i: number): number => pad + (i * (W - 2 * pad)) / Math.max(1, MAX_SAMPLES - 1);
  const y = (v: number): number => Ht - pad - (v / max) * (Ht - 2 * pad);

  const series = (pick: (p: { rx: number; tx: number }) => number, cls: string): void => {
    if (history.length < 2) return;
    const pts = history.map((p, i) => `${x(i).toFixed(1)},${y(pick(p)).toFixed(1)}`).join(" ");
    // Filled area under the line.
    const area = document.createElementNS(SVG, "polygon");
    const first = x(0).toFixed(1);
    const last = x(history.length - 1).toFixed(1);
    area.setAttribute("points", `${first},${Ht - pad} ${pts} ${last},${Ht - pad}`);
    area.setAttribute("class", `${cls} area`);
    svg.appendChild(area);
    const line = document.createElementNS(SVG, "polyline");
    line.setAttribute("points", pts);
    line.setAttribute("class", `${cls} line`);
    svg.appendChild(line);
  };
  series((p) => p.rx, "rx"); // download
  series((p) => p.tx, "tx"); // upload
  return svg;
}

// ── detail panel (chart + totals) for the selected device ────────────────────
function renderDetail(): void {
  const panel = document.getElementById("detail");
  if (!panel) return;
  const d = selectedDevice();
  panel.replaceChildren();
  if (!d) {
    panel.appendChild(h("div", { class: "muted" }, "Select a device to see its traffic."));
    return;
  }
  panel.appendChild(h("div", { class: "detail-title" }, d.host || d.comment || d.ip));
  panel.appendChild(
    h("div", { class: "detail-sub" }, `${d.ip} · ${d.mac} · ${d.iface || "?"} · ${d.status}`),
  );

  if (latest && latest.source === "none") {
    panel.appendChild(
      h(
        "div",
        { class: "muted note" },
        "No per-device counter. Ask: “create a simple queue for this device” to enable Download/Upload tracking.",
      ),
    );
  } else {
    panel.appendChild(
      h(
        "div",
        { class: "rates" },
        h("span", { class: "rate rx" }, `↓ ${latest ? mbps(latest.rxBitsPerSec) : "…"}`),
        h("span", { class: "rate tx" }, `↑ ${latest ? mbps(latest.txBitsPerSec) : "…"}`),
      ),
    );
    panel.appendChild(chart());
    if (latest) {
      panel.appendChild(
        h(
          "div",
          { class: "totals muted" },
          `total ↓ ${bytes(latest.rxBytes)} · ↑ ${bytes(latest.txBytes)}`,
        ),
      );
    }
  }
}

// ── server-tool actions ──────────────────────────────────────────────────────
function adopt(structured: unknown): boolean {
  if (
    structured &&
    typeof structured === "object" &&
    (structured as { __mikrotikView?: string }).__mikrotikView === "connected-devices"
  ) {
    view = structured as DevicesView;
    render();
    return true;
  }
  return false;
}
async function action(name: string, mac: string): Promise<void> {
  if (busy) return;
  busy = true;
  render();
  try {
    const res = await app.callServerTool({ name, arguments: { mac } });
    adopt((res as { structuredContent?: unknown }).structuredContent);
  } catch (e) {
    console.error(`[connected-devices] ${name} failed`, e);
  } finally {
    busy = false;
    render();
  }
}
async function refresh(): Promise<void> {
  if (busy) return;
  busy = true;
  render();
  try {
    const res = await app.callServerTool({ name: "list_connected_devices", arguments: {} });
    adopt((res as { structuredContent?: unknown }).structuredContent);
  } catch (e) {
    console.error("[connected-devices] refresh failed", e);
  } finally {
    busy = false;
    render();
  }
}

// ── render ───────────────────────────────────────────────────────────────────
function render(): void {
  if (!view) {
    root.replaceChildren(h("div", { class: "muted loading" }, "Loading connected devices…"));
    return;
  }
  const c = view.counts;

  const head = h(
    "div",
    { class: "toolbar" },
    h("h1", { class: "title" }, "Connected Devices"),
    h(
      "div",
      { class: "counts muted" },
      `${c.total} total · ${c.static} static · ${c.blocked} blocked`,
    ),
    button("↻ Refresh", () => void refresh(), { class: busy ? "is-busy" : "" }),
  );

  const rows = view.devices.map((d) => {
    const isSel = d.mac === selected;
    const tr = h(
      "div",
      { class: `row${isSel ? " is-selected" : ""}${d.blocked ? " is-blocked" : ""}` },
      h("span", { class: "cell ip" }, d.ip || "—"),
      h("span", { class: "cell name" }, d.host || d.comment || "(unknown)"),
      h("span", { class: "cell mac mono" }, d.mac),
      h("span", { class: "cell iface" }, d.iface || ""),
      h(
        "span",
        { class: "cell badges" },
        d.static ? h("span", { class: "badge static" }, "static") : null,
        d.blocked ? h("span", { class: "badge blocked" }, "blocked") : null,
      ),
      h(
        "span",
        { class: "cell actions" },
        d.blocked
          ? button("Allow", () => void action("allow_device", d.mac), { class: "ok" })
          : button("Block", () => void action("block_device", d.mac), { class: "danger" }),
        d.static
          ? null
          : button("Pin IP", () => void action("make_device_static", d.mac), { class: "" }),
      ),
    );
    tr.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".actions")) return; // don't select on button click
      selected = d.mac;
      if (d.ip) startPolling(d.ip);
      else stopPolling();
      render();
    });
    return tr;
  });

  root.replaceChildren(
    head,
    h(
      "div",
      { class: "table" },
      h(
        "div",
        { class: "row header" },
        h("span", { class: "cell ip" }, "IP"),
        h("span", { class: "cell name" }, "Name"),
        h("span", { class: "cell mac" }, "MAC"),
        h("span", { class: "cell iface" }, "Iface"),
        h("span", { class: "cell badges" }, ""),
        h("span", { class: "cell actions" }, ""),
      ),
      ...rows,
    ),
    h("div", { id: "detail", class: "detail" }),
  );
  renderDetail();
}

// ── bridge ───────────────────────────────────────────────────────────────────
wireHostContext(app);
app.onteardown = async () => {
  stopPolling();
  if (autoTimer) clearInterval(autoTimer);
  return {};
};

render();
void connectApp(app, "connected-devices", root, adopt).then((ok) => {
  // Do not replay a cancelled/failed initial request or overwrite its feedback.
  if (ok)
    autoTimer = setInterval(() => {
      if (view) void refresh();
    }, 15000);
});
