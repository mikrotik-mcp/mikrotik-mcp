/**
 * MCP Apps metadata — the small, host-agnostic glue that links a tool to an
 * interactive view (the `ext-apps` extension, spec `2026-01-26`).
 *
 * A tool opts into a UI by carrying a `ui://…` resource URI in its `_meta`. We
 * emit the same target under three keys so every host recognises it:
 *
 *   - `_meta.ui.resourceUri`     — the preferred MCP Apps shape (Claude, etc.)
 *   - `_meta["ui/resourceUri"]`  — the deprecated flat alias (older hosts)
 *   - `_meta["openai/outputTemplate"]` — the OpenAI Apps SDK key (ChatGPT)
 *
 * Keeping this in one tiny module (rather than importing the whole
 * `@modelcontextprotocol/ext-apps/server` into the hot tool-registration path)
 * keeps the dependency surface small and the values explicit. The string keys
 * mirror `RESOURCE_URI_META_KEY` / OpenAI's `outputTemplate` from the SDK.
 */

/**
 * MIME type the host expects for an MCP App HTML resource. The `profile`
 * parameter is how a host distinguishes an interactive MCP App view from a
 * plain HTML resource (matches `RESOURCE_MIME_TYPE` in `@modelcontextprotocol/
 * ext-apps`).
 */
export const UI_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

/** Preferred nested key: `_meta.ui`. */
export const UI_META_KEY = "ui";
/** Deprecated flat alias for older MCP Apps hosts. */
export const UI_RESOURCE_URI_LEGACY_KEY = "ui/resourceUri";
/** OpenAI Apps SDK key recognised by ChatGPT. */
export const OPENAI_OUTPUT_TEMPLATE_KEY = "openai/outputTemplate";

/**
 * The `ui://` resource URI for a view id. Pure and dependency-free so the
 * registration hot path (and the records auto-view) can reference views without
 * importing the resource-serving layer (`ui-resources.ts`, which pulls in
 * `node:fs` + the ext-apps server). `ui-resources` re-exports this.
 */
export function uiViewUri(id: string): string {
  // Host caches key on the resource URI. Revise when the HTML/data contract changes.
  return `ui://mikrotik/${id}.html?v=2`;
}

/** Links a tool to an MCP App view resource. */
export interface UiLink {
  /** `ui://…` resource URI of the HTML view the host should render. */
  resourceUri: string;
  /**
   * Where the tool may be invoked from. `"model"` lets the LLM call it;
   * `"app"` lets the rendered view call it (e.g. polling/refresh helpers).
   * Defaults to model-visible when omitted.
   */
  visibility?: ("model" | "app")[];
}

/** Build the `_meta` object that advertises a tool's UI to every host. */
export function toolUiMeta(ui: UiLink): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    [UI_META_KEY]: ui.visibility
      ? { resourceUri: ui.resourceUri, visibility: ui.visibility }
      : { resourceUri: ui.resourceUri },
    [UI_RESOURCE_URI_LEGACY_KEY]: ui.resourceUri,
    [OPENAI_OUTPUT_TEMPLATE_KEY]: ui.resourceUri,
  };
  return meta;
}
