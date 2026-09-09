/**
 * MCP App view registry — the `ui://` HTML resources this server can render.
 *
 * This is the single source of truth for views: tools reference a view via
 * {@link uiViewUri} (e.g. `defineTool({ ui: { resourceUri: uiViewUri("dashboard") } })`),
 * and {@link registerUiResources} serves the matching built HTML so the host can
 * fetch and render it in a sandboxed iframe.
 *
 * The HTML is built (single-file) by `bun run build:ui` into `dist/ui/<id>.html`.
 * If a view hasn't been built yet, a small placeholder is served so the server
 * still runs (and the failure is obvious in the host instead of crashing).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { UI_DIST_DIR } from "../paths";
import { uiViewUri } from "./ui-meta";

export interface UiView {
  /** Stable id — used in the resource URI and the built HTML filename. */
  id: string;
  /** Human-readable name shown in `resources/list`. */
  name: string;
  /** One-line summary. */
  description: string;
}

// Re-exported from `ui-meta` (the pure home) so existing imports keep working.
export { uiViewUri };

/**
 * Every MCP App view the server ships. Add a view here and reference
 * `uiViewUri(id)` from the tool that should render it.
 */
export const UI_VIEWS: UiView[] = [
  {
    id: "dashboard",
    name: "MikroTik Device Dashboard",
    description:
      "Live device health: CPU load, memory, uptime, temperature, board and RouterOS version.",
  },
  {
    id: "records",
    name: "MikroTik Records Viewer",
    description:
      "Generic searchable/sortable table + detail viewer for any read tool (list_*/get_*): " +
      "filter, drill into a row, refresh live, and export to CSV/JSON.",
  },
  {
    id: "interfaces",
    name: "MikroTik Interfaces",
    description:
      "Interface overview: per-port status (running/disabled), type, MTU and MAC with live refresh.",
  },
  {
    id: "firewall",
    name: "MikroTik Firewall Rules",
    description:
      "Ordered firewall filter rules: chain, action, matchers, packet/byte counters and enabled state.",
  },
  {
    id: "firewall-audit",
    name: "MikroTik Firewall Audit",
    description:
      "Prioritised firewall findings (shadowed/broad/missing-drop/duplicate/dead) with a risk " +
      "score and one-click fixes.",
  },
  {
    id: "connected-devices",
    name: "MikroTik Connected Devices",
    description:
      "Devices on the network with per-device Download/Upload charts, uptime/status, and one-click " +
      "block/allow and pin-IP.",
  },
  {
    id: "aaa",
    name: "MikroTik RADIUS & User Manager",
    description:
      "Full RADIUS client + built-in User Manager RADIUS server management: servers, users, " +
      "profiles, limitations, NAS clients, assignments, sessions and settings, with add/edit/remove.",
  },
];

/** Placeholder served when a view's HTML hasn't been built yet. */
function placeholderHtml(view: UiView): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${view.name}</title></head><body style="font:14px/1.5 system-ui;padding:24px;color:#9aa0a6;background:#0b0d10"><h2 style="color:#e8eaed;margin:0 0 8px">${view.name}</h2><p>This MCP App view hasn't been built yet. Run <code style="color:#7c9cff">bun run build:ui</code> to generate it.</p></body></html>`;
}

/**
 * Register every UI view as a `ui://` resource. Returns the number registered.
 * The HTML is read on each fetch so rebuilds are picked up without a restart.
 */
export function registerUiResources(server: McpServer): number {
  for (const view of UI_VIEWS) {
    const uri = uiViewUri(view.id);
    const file = join(UI_DIST_DIR, `${view.id}.html`);
    // ext-apps 2's registration helper targets SDK 2. Register with our SDK 1
    // server directly, preserving the MCP Apps MIME type and resource metadata.
    server.registerResource(
      view.name,
      uri,
      { description: view.description, mimeType: RESOURCE_MIME_TYPE },
      () => {
        let html: string;
        try {
          html = readFileSync(file, "utf8");
        } catch {
          html = placeholderHtml(view);
        }
        return { contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: html }] };
      },
    );
  }
  return UI_VIEWS.length;
}
