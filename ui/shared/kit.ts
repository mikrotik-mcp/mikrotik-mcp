/**
 * Shared MCP App view kit — small, dependency-light helpers reused across the
 * MikroTik views (records, interfaces, firewall).
 *
 * Everything here builds DOM with `textContent`/element nodes (never
 * `innerHTML`), so device-supplied strings can never inject markup, and wires
 * the host bridge (theme, fonts, safe-area) the same way in every view.
 */
import {
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  getDocumentTheme,
} from "@modelcontextprotocol/ext-apps";
import type { App } from "@modelcontextprotocol/ext-apps";
import "./result.css";
import "./workspace.css";

export type Child = Node | string | null | undefined | false;

/** Tiny hyperscript helper: `h("div", { class: "x" }, "text", childNode)`. */
export function h(tag: string, props: Record<string, string> = {}, ...kids: Child[]): HTMLElement {
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

/** A `<button class="btn">` with a click handler (and optional modifier class). */
export function button(
  label: string,
  onClick: () => void,
  opts: { class?: string; title?: string; disabled?: boolean } = {},
): HTMLButtonElement {
  const el = h("button", {
    class: `btn${opts.class ? ` ${opts.class}` : ""}`,
    type: "button",
    ...(opts.title ? { title: opts.title } : {}),
  }) as HTMLButtonElement;
  el.textContent = label;
  if (opts.disabled) el.disabled = true;
  el.addEventListener("click", onClick);
  return el;
}

/** Format a byte count as a binary size (`124.0 MiB`), or `—` when unknown. */
export function bytes(n: number | null | undefined): string {
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

/** Severity class for a 0–100 percentage (green / amber / red). */
export function severity(pct: number | null | undefined): string {
  if (pct == null) return "";
  return pct >= 90 ? "is-bad" : pct >= 70 ? "is-warn" : "is-good";
}

/** Copy text to the clipboard, falling back to a hidden textarea + execCommand. */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } finally {
      ta.remove();
    }
  }
}

/** Trigger a client-side download of `text` as `filename`. */
export function download(filename: string, text: string, mime = "text/plain"): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Serialise rows to CSV with the given ordered columns (RFC-4180 quoting). */
export function toCsv(columns: string[], rows: Record<string, string>[]): string {
  const esc = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const head = columns.map(esc).join(",");
  const body = rows.map((r) => columns.map((c) => esc(r[c] ?? "")).join(",")).join("\n");
  return `${head}\n${body}\n`;
}

/**
 * Wire the standard host-context handler onto an App instance: theme, host CSS
 * variables/fonts and safe-area insets. Call once after constructing the App.
 */
export function wireHostContext(app: App): void {
  app.onhostcontextchanged = (ctx) => {
    if (ctx.theme) applyDocumentTheme(ctx.theme);
    if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
    if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
    if (ctx.safeAreaInsets) {
      const { top, right, bottom, left } = ctx.safeAreaInsets;
      document.body.style.padding = `${top + 16}px ${right + 16}px ${bottom + 16}px ${left + 16}px`;
    }
  };
  applyDocumentTheme(getDocumentTheme());
}

/** Default connect timeout — 10 s is long enough for a healthy host. */
const CONNECT_TIMEOUT_MS = 10_000;

/** Compact network-instrument mark; no external assets are needed in the iframe. */
export function networkIcon(): SVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [key, value] of Object.entries({
    viewBox: "0 0 24 24",
    width: "20",
    height: "20",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.5",
    "aria-hidden": "true",
  }))
    svg.setAttribute(key, value);
  const path = document.createElementNS(ns, "path");
  path.setAttribute(
    "d",
    "M6 7v4a6 6 0 0 0 6 6m6-10v4a6 6 0 0 1-6 6m0 0v3M4 3h4v4H4zm12 0h4v4h-4zM10 20h4v3h-4z",
  );
  svg.append(path);
  return svg;
}

function mountWorkspace(root: HTMLElement, tag: string): void {
  document.documentElement.dataset.mcpView = tag;
  root.classList.add("app");
  const names: Record<string, string> = {
    dashboard: "Device health",
    records: "Data explorer",
    interfaces: "Interface inventory",
    firewall: "Firewall policy",
    "firewall-audit": "Security findings",
    "connected-devices": "Client inventory",
    aaa: "Identity & access",
    investigations: "Client investigations",
    "round-trip": "Round-trip lab",
    "service-health": "Service health",
    fabric: "Layer-2 fabric",
    operations: "Change operations",
    reports: "Evidence reports",
  };
  document.getElementById("mcp-app-masthead")?.remove();
  root.before(
    h(
      "header",
      { id: "mcp-app-masthead", class: "mcp-masthead" },
      h("span", { class: "mcp-mark" }, networkIcon()),
      h(
        "div",
        {},
        h("span", { class: "mcp-brand" }, "MikroTik ", h("b", {}, "MCP")),
        h("p", { class: "mcp-context" }, names[tag] ?? "Tool workspace"),
      ),
      h("span", { class: "mcp-response-label" }, "TOOL RESPONSE"),
    ),
  );
}

/**
 * Install result handlers BEFORE connecting: hosts can deliver results during
 * initialization. Each view accepts its own payload; other results remain
 * readable instead of silently leaving the loading skeleton in place.
 * A delayed-result notice is not a tool timeout and never replays a tool call.
 */
export async function connectApp(
  app: App,
  tag: string,
  root: HTMLElement,
  adopt: (structured: unknown, result?: Parameters<NonNullable<App["ontoolresult"]>>[0]) => boolean,
): Promise<boolean> {
  mountWorkspace(root, tag);
  let received = false;
  let disposed = false;
  let pending: ReturnType<typeof setTimeout> | undefined;
  const clearPending = (): void => {
    if (pending !== undefined) clearTimeout(pending);
    pending = undefined;
  };
  const show = (title: string, message: string, detail?: string, error = false): void => {
    root.replaceChildren(
      h(
        "section",
        { class: "app-result", role: error ? "alert" : "status" },
        h("h2", { class: "app-result__title" }, title),
        h("p", { class: "app-result__message" }, message),
        detail ? h("pre", { class: "app-result__detail" }, detail) : null,
      ),
    );
  };
  app.ontoolresult = (result) => {
    if (disposed) return;
    received = true;
    clearPending();
    const text = (result.content ?? [])
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
      .trim();
    if (result.isError) {
      show(
        "Tool failed",
        "The tool returned an error. No successful result is available.",
        text,
        true,
      );
      return;
    }
    try {
      if (adopt(result.structuredContent, result)) return;
      const structured = result.structuredContent;
      if (text || structured) {
        show(
          "Tool result",
          "The response is shown below; it does not use this view's interactive format.",
          [text, structured ? JSON.stringify(structured, null, 2) : ""]
            .filter(Boolean)
            .join("\n\n"),
        );
      } else {
        show(
          "No data returned",
          result.content?.some((part) => part.type !== "text")
            ? "The tool returned non-text content. Open the original tool response in your client."
            : "The tool completed without text or structured data.",
        );
      }
    } catch {
      show("Unable to display result", "The tool returned an invalid view payload.", text, true);
    }
  };
  app.ontoolcancelled = (params) => {
    if (disposed) return;
    received = true;
    clearPending();
    show("Tool cancelled", params.reason || "The host cancelled this tool call.");
  };
  const teardown = app.onteardown;
  app.onteardown = (params, extra) => {
    disposed = true;
    clearPending();
    return teardown?.(params, extra) ?? {};
  };
  const close = app.onclose;
  app.onclose = () => {
    if (!disposed && !received) {
      show(
        "Host disconnected",
        "The connection closed before a tool result arrived.",
        undefined,
        true,
      );
    }
    disposed = true;
    clearPending();
    close?.();
  };
  try {
    await app.connect(undefined, { timeout: CONNECT_TIMEOUT_MS });
    if (disposed) return false;
    const context = app.getHostContext?.();
    if (context) app.onhostcontextchanged?.(context);
    if (!received) {
      pending = setTimeout(() => {
        show(
          "Still awaiting the tool result",
          "The host is connected, but has not delivered a result. Check the original tool response or your client's MCP connection. Do not repeat a configuration-changing call just to refresh this view. Late results will still appear here.",
        );
      }, 15_000);
    }
    console.warn(`[${tag}] connected`, {
      host: app.getHostVersion(),
      caps: app.getHostCapabilities(),
    });
    return true;
  } catch (err) {
    clearPending();
    if (disposed) return false;
    disposed = true;
    console.error(`[${tag}] connect failed`, err);
    const msg =
      err instanceof Error && /timed?\s*out/i.test(err.message)
        ? "The MCP App host did not respond — make sure your client supports MCP Apps (ext-apps)."
        : `Connection failed: ${err instanceof Error ? err.message : String(err)}`;
    show("Cannot connect to the host", msg, undefined, true);
    return false;
  }
}
