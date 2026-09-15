/**
 * RADIUS & User Manager — MCP App view.
 *
 * Renders the `manage_radius_user_manager` tool's `structuredContent` as an
 * interactive, tabbed management console for the router's RADIUS client and the
 * built-in User Manager RADIUS server. Every section (RADIUS servers, users,
 * profiles, limitations, NAS clients, assignments, sessions, settings) lists
 * live rows and supports add / edit / enable-disable / remove — all routed back
 * through the App bridge to the app-only `get_aaa_section`, `aaa_mutate`,
 * `get_aaa_settings` and `set_aaa_settings` tools (the same `aaa-data` layer the
 * observability dashboard uses).
 *
 * All DOM is built with textContent/element nodes (never innerHTML).
 */
import { App } from "@modelcontextprotocol/ext-apps";
import { h, button, connectApp, wireHostContext } from "../shared/kit";
import "./styles.css";

type Row = Record<string, string>;
interface Field {
  key: string;
  label: string;
  type?: "text" | "number" | "password" | "bool" | "select";
  options?: string[];
  placeholder?: string;
  required?: boolean;
}
interface Section {
  slug: string;
  label: string;
  idKey: string;
  columns: { key: string; label: string }[];
  fields: Field[];
  toggle?: boolean;
  addOnly?: boolean;
  readonly?: boolean;
}

// ── section schemas (mirror the server whitelist in src/tools/aaa-data.ts) ────
const SECTIONS: Section[] = [
  {
    slug: "radius",
    label: "RADIUS Servers",
    idKey: ".id",
    toggle: true,
    columns: [
      { key: "address", label: "Address" },
      { key: "service", label: "Service" },
      { key: "authentication-port", label: "Auth" },
      { key: "accounting-port", label: "Acct" },
      { key: "_status", label: "Status" },
    ],
    fields: [
      { key: "address", label: "Address", required: true },
      { key: "secret", label: "Secret", type: "password", required: true },
      { key: "service", label: "Service", required: true, placeholder: "login,ppp,hotspot,…" },
      { key: "authentication-port", label: "Auth port", type: "number", placeholder: "1812" },
      { key: "accounting-port", label: "Acct port", type: "number", placeholder: "1813" },
      { key: "timeout", label: "Timeout", placeholder: "300ms" },
      { key: "src-address", label: "Src address" },
      { key: "realm", label: "Realm" },
      { key: "called-id", label: "Called ID" },
      { key: "domain", label: "Domain" },
      { key: "protocol", label: "Protocol", type: "select", options: ["udp", "radsec"] },
      { key: "certificate", label: "Certificate" },
      { key: "accounting-backup", label: "Acct backup", type: "bool" },
      { key: "comment", label: "Comment" },
      { key: "disabled", label: "Disabled", type: "bool" },
    ],
  },
  {
    slug: "um-users",
    label: "Users",
    idKey: "name",
    toggle: true,
    columns: [
      { key: "name", label: "Name" },
      { key: "group", label: "Group" },
      { key: "shared-users", label: "Shared" },
      { key: "comment", label: "Comment" },
      { key: "_status", label: "Status" },
    ],
    fields: [
      { key: "name", label: "Name", required: true },
      { key: "password", label: "Password", type: "password", required: true },
      { key: "group", label: "Group" },
      { key: "shared-users", label: "Shared users", type: "number" },
      { key: "attributes", label: "Attributes" },
      { key: "caller-id", label: "Caller ID" },
      { key: "otp-secret", label: "OTP secret", type: "password" },
      { key: "comment", label: "Comment" },
      { key: "disabled", label: "Disabled", type: "bool" },
    ],
  },
  {
    slug: "um-profiles",
    label: "Profiles",
    idKey: "name",
    columns: [
      { key: "name", label: "Name" },
      { key: "validity", label: "Validity" },
      { key: "price", label: "Price" },
      { key: "starts-when", label: "Starts" },
    ],
    fields: [
      { key: "name", label: "Name", required: true },
      { key: "name-for-users", label: "Display name" },
      { key: "validity", label: "Validity", placeholder: "30d" },
      { key: "price", label: "Price", type: "number" },
      {
        key: "starts-when",
        label: "Starts when",
        type: "select",
        options: ["assigned", "first-auth"],
      },
      { key: "override-shared-users", label: "Override shared" },
      { key: "comment", label: "Comment" },
    ],
  },
  {
    slug: "um-limitations",
    label: "Limitations",
    idKey: "name",
    columns: [
      { key: "name", label: "Name" },
      { key: "rate-limit-rx", label: "Rate ↓" },
      { key: "rate-limit-tx", label: "Rate ↑" },
      { key: "transfer-limit", label: "Transfer" },
      { key: "uptime-limit", label: "Uptime" },
    ],
    fields: [
      { key: "name", label: "Name", required: true },
      { key: "rate-limit-rx", label: "Download rate", placeholder: "10M" },
      { key: "rate-limit-tx", label: "Upload rate", placeholder: "10M" },
      { key: "rate-limit-min-rx", label: "Min ↓ (CIR)" },
      { key: "rate-limit-min-tx", label: "Min ↑ (CIR)" },
      { key: "rate-limit-burst-rx", label: "Burst ↓" },
      { key: "rate-limit-burst-tx", label: "Burst ↑" },
      { key: "rate-limit-priority", label: "Priority", type: "number" },
      { key: "transfer-limit", label: "Transfer cap", placeholder: "10G" },
      { key: "uptime-limit", label: "Uptime cap", placeholder: "1d" },
      { key: "comment", label: "Comment" },
    ],
  },
  {
    slug: "um-routers",
    label: "NAS Clients",
    idKey: "name",
    toggle: true,
    columns: [
      { key: "name", label: "Name" },
      { key: "address", label: "Address" },
      { key: "coa-port", label: "CoA" },
      { key: "_status", label: "Status" },
    ],
    fields: [
      { key: "name", label: "Name", required: true },
      { key: "address", label: "Address", required: true },
      { key: "shared-secret", label: "Shared secret", type: "password", required: true },
      { key: "coa-port", label: "CoA port", type: "number" },
      { key: "protocol", label: "Protocol" },
      { key: "comment", label: "Comment" },
      { key: "disabled", label: "Disabled", type: "bool" },
    ],
  },
  {
    slug: "um-user-profiles",
    label: "Assignments",
    idKey: ".id",
    addOnly: true,
    columns: [
      { key: "user", label: "User" },
      { key: "profile", label: "Profile" },
      { key: "state", label: "State" },
    ],
    fields: [
      { key: "user", label: "User", required: true },
      { key: "profile", label: "Profile", required: true },
    ],
  },
  {
    slug: "um-sessions",
    label: "Sessions",
    idKey: ".id",
    readonly: true,
    columns: [
      { key: "user", label: "User" },
      { key: "calling-station-id", label: "Caller" },
      { key: "started", label: "Started" },
      { key: "uptime", label: "Uptime" },
      { key: "status", label: "Status" },
    ],
    fields: [],
  },
];
const SETTINGS_TAB = { slug: "settings", label: "Settings" };

const sectionFor = (slug: string): Section | undefined => SECTIONS.find((s) => s.slug === slug);
const isOff = (r: Row): boolean => (r.flags ?? "").includes("X") || r.disabled === "yes";

// ── state ─────────────────────────────────────────────────────────────────────
const root = document.getElementById("app")!;
const app = new App({ name: "mikrotik-aaa", version: "1.0.0" });

let activeSlug = "radius";
let available = true;
let rows: Row[] = [];
let editing: string | null = null; // null | "new" | row id
let form: Row = {};
let settings: { radiusIncoming: Row; umAvailable: boolean; umSettings: Row } | null = null;
let busy = false;
let error: string | null = null;

// ── server-tool calls ─────────────────────────────────────────────────────────
function structured(res: unknown): Record<string, unknown> | undefined {
  return (res as { structuredContent?: Record<string, unknown> })?.structuredContent;
}
function adoptSection(sc: Record<string, unknown> | undefined): void {
  if (!sc || sc.__mikrotikView !== "aaa-section") return;
  if (typeof sc.slug === "string") activeSlug = sc.slug;
  available = sc.available !== false;
  rows = (sc.rows as Row[]) ?? [];
  const last = sc.lastOp as { ok: boolean; message: string } | undefined;
  error = last && !last.ok ? last.message : null;
}
function adoptSettings(sc: Record<string, unknown> | undefined): void {
  if (!sc || sc.__mikrotikView !== "aaa-settings") return;
  settings = {
    radiusIncoming: (sc.radiusIncoming as Row) ?? {},
    umAvailable: sc.umAvailable !== false,
    umSettings: (sc.umSettings as Row) ?? {},
  };
  const last = sc.lastOp as { ok: boolean; message: string } | undefined;
  error = last && !last.ok ? last.message : null;
}

async function loadSection(slug: string): Promise<void> {
  activeSlug = slug;
  editing = null;
  error = null;
  busy = true;
  render();
  try {
    const res = await app.callServerTool({ name: "get_aaa_section", arguments: { slug } });
    adoptSection(structured(res));
  } catch (e) {
    error = String(e);
  } finally {
    busy = false;
    render();
  }
}
async function loadSettings(): Promise<void> {
  activeSlug = "settings";
  error = null;
  busy = true;
  render();
  try {
    const res = await app.callServerTool({ name: "get_aaa_settings", arguments: {} });
    adoptSettings(structured(res));
  } catch (e) {
    error = String(e);
  } finally {
    busy = false;
    render();
  }
}
async function mutate(op: string, extra: Record<string, unknown>): Promise<void> {
  if (busy) return;
  busy = true;
  error = null;
  render();
  try {
    const res = await app.callServerTool({
      name: "aaa_mutate",
      arguments: { op, slug: activeSlug, ...extra },
    });
    adoptSection(structured(res));
    editing = null;
  } catch (e) {
    error = String(e);
  } finally {
    busy = false;
    render();
  }
}
async function saveSettings(target: string, fields: Row): Promise<void> {
  if (busy) return;
  busy = true;
  error = null;
  render();
  try {
    const res = await app.callServerTool({
      name: "set_aaa_settings",
      arguments: { target, fields },
    });
    adoptSettings(structured(res));
  } catch (e) {
    error = String(e);
  } finally {
    busy = false;
    render();
  }
}

// ── form rendering ────────────────────────────────────────────────────────────
function fieldInput(f: Field): HTMLElement {
  if (f.type === "bool" || f.type === "select") {
    const sel = h("select", { class: "aaa-input" }) as HTMLSelectElement;
    const opts = f.type === "bool" ? ["", "no", "yes"] : ["", ...(f.options ?? [])];
    for (const o of opts) {
      const opt = h("option", { value: o }, o || "—") as HTMLOptionElement;
      sel.append(opt);
    }
    sel.value = form[f.key] ?? "";
    sel.addEventListener("change", () => {
      form[f.key] = sel.value;
    });
    return sel;
  }
  const inp = h("input", {
    class: "aaa-input",
    type: f.type === "password" ? "password" : f.type === "number" ? "number" : "text",
    placeholder: f.placeholder ?? (f.type === "password" ? "(unchanged)" : ""),
  }) as HTMLInputElement;
  inp.value = form[f.key] ?? "";
  inp.addEventListener("input", () => {
    form[f.key] = inp.value;
  });
  return inp;
}

function renderForm(section: Section): HTMLElement {
  const grid = h(
    "div",
    { class: "aaa-form-grid" },
    ...section.fields.map((f) =>
      h(
        "label",
        { class: "aaa-field" },
        h(
          "span",
          { class: "aaa-field-label" },
          `${f.label}${f.required && editing === "new" ? " *" : ""}`,
        ),
        fieldInput(f),
      ),
    ),
  );
  const save = button(
    editing === "new" ? "Create" : "Save",
    () => {
      if (editing === "new") void mutate("add", { fields: { ...form } });
      else void mutate("update", { id: editing, fields: { ...form } });
    },
    { class: "primary" },
  );
  const cancel = button("Cancel", () => {
    editing = null;
    render();
  });
  return h(
    "div",
    { class: "aaa-form" },
    h(
      "div",
      { class: "aaa-form-title" },
      editing === "new" ? `New ${section.label}` : `Edit ${editing}`,
    ),
    grid,
    h("div", { class: "aaa-form-actions" }, save, cancel),
  );
}

// ── table rendering ───────────────────────────────────────────────────────────
function openEdit(section: Section, r: Row): void {
  editing = r[section.idKey];
  form = {};
  for (const f of section.fields) {
    if (f.type === "password") continue;
    if (f.key === "disabled") form.disabled = isOff(r) ? "yes" : "no";
    else if (r[f.key] != null) form[f.key] = r[f.key];
  }
  render();
}

function renderTable(section: Section): HTMLElement {
  const head = h(
    "div",
    { class: "aaa-row aaa-head" },
    ...section.columns.map((c) => h("span", {}, c.label)),
    h("span", { class: "aaa-actions" }, section.readonly ? "" : "Actions"),
  );
  const body = rows.map((r) => {
    const id = r[section.idKey];
    const off = isOff(r);
    const cells = section.columns.map((c) =>
      c.key === "_status"
        ? h(
            "span",
            {},
            h("span", { class: `aaa-badge ${off ? "off" : "on"}` }, off ? "disabled" : "enabled"),
          )
        : h("span", { class: "aaa-cell", title: r[c.key] ?? "" }, r[c.key] ?? ""),
    );
    const actions: Node[] = [];
    if (!section.readonly) {
      if (section.toggle)
        actions.push(
          button(off ? "Enable" : "Disable", () => void mutate("toggle", { id, enable: off })),
        );
      if (!section.addOnly) actions.push(button("Edit", () => openEdit(section, r)));
      actions.push(button("Remove", () => void mutate("remove", { id }), { class: "danger" }));
    }
    return h(
      "div",
      { class: `aaa-row${off ? " is-off" : ""}` },
      ...cells,
      h("span", { class: "aaa-actions" }, ...actions),
    );
  });
  return h("div", { class: "aaa-table", style: `--cols:${section.columns.length}` }, head, ...body);
}

// ── settings rendering ────────────────────────────────────────────────────────
function settingsForm(
  title: string,
  current: Row,
  fields: Field[],
  target: string,
  extra?: HTMLElement,
): HTMLElement {
  const local: Row = {};
  const grid = h(
    "div",
    { class: "aaa-form-grid" },
    ...fields.map((f) => {
      const wrap = h(
        "label",
        { class: "aaa-field" },
        h("span", { class: "aaa-field-label" }, f.label),
      );
      let el: HTMLElement;
      if (f.type === "bool") {
        const sel = h("select", { class: "aaa-input" }) as HTMLSelectElement;
        for (const o of ["", "no", "yes"])
          sel.append(h("option", { value: o }, o || "(unchanged)"));
        sel.addEventListener("change", () => {
          local[f.key] = sel.value;
        });
        el = sel;
      } else {
        const inp = h("input", {
          class: "aaa-input",
          type: f.type === "number" ? "number" : "text",
          placeholder: current[f.key] ?? f.placeholder ?? "",
        }) as HTMLInputElement;
        inp.addEventListener("input", () => {
          local[f.key] = inp.value;
        });
        el = inp;
      }
      wrap.append(el);
      return wrap;
    }),
  );
  const cur = h(
    "div",
    { class: "aaa-current" },
    fields.map((f) => `${f.label}: ${current[f.key] ?? "—"}`).join("  ·  "),
  );
  const actions = h(
    "div",
    { class: "aaa-form-actions" },
    button("Save", () => void saveSettings(target, local), { class: "primary" }),
    extra ?? null,
  );
  return h(
    "div",
    { class: "aaa-card" },
    h("div", { class: "aaa-form-title" }, title),
    cur,
    grid,
    actions,
  );
}

function renderSettings(): HTMLElement {
  if (!settings) return h("div", { class: "muted" }, "Loading settings…");
  const radius = settingsForm(
    "RADIUS Incoming (CoA listener)",
    settings.radiusIncoming,
    [
      { key: "accept", label: "Accept CoA", type: "bool" },
      { key: "port", label: "CoA port", type: "number", placeholder: "3799" },
    ],
    "radius-incoming",
    button("Reset counters", () => void saveSettings("radius-reset-counters", {})),
  );
  const um = settings.umAvailable
    ? settingsForm(
        "User Manager (built-in RADIUS server)",
        settings.umSettings,
        [
          { key: "enabled", label: "Enabled", type: "bool" },
          { key: "use-profiles", label: "Use profiles", type: "bool" },
          { key: "certificate", label: "Certificate" },
          { key: "authentication-port", label: "Auth port", type: "number" },
          { key: "accounting-port", label: "Acct port", type: "number" },
        ],
        "um-settings",
      )
    : h(
        "div",
        { class: "aaa-card" },
        h("div", { class: "aaa-form-title" }, "User Manager"),
        h("div", { class: "muted" }, "The user-manager package is not installed on this device."),
      );
  return h("div", { class: "aaa-settings" }, radius, um);
}

// ── render ────────────────────────────────────────────────────────────────────
function render(): void {
  const tabs = h(
    "div",
    { class: "aaa-tabs" },
    ...[...SECTIONS, SETTINGS_TAB].map((s) =>
      h("button", { class: `aaa-tab${activeSlug === s.slug ? " is-active" : ""}` }, s.label),
    ),
  );
  // Wire tab clicks (built above without inline handlers for clarity).
  [...tabs.children].forEach((node, i) => {
    const s = [...SECTIONS, SETTINGS_TAB][i];
    node.addEventListener("click", () => {
      if (s.slug === "settings") void loadSettings();
      else void loadSection(s.slug);
    });
  });

  const children: Node[] = [
    h(
      "header",
      { class: "aaa-titlebar" },
      h("h1", { class: "aaa-title" }, "RADIUS & User Manager"),
    ),
    tabs,
  ];
  if (error) children.push(h("div", { class: "aaa-error" }, error));

  if (activeSlug === "settings") {
    children.push(renderSettings());
  } else {
    const section = sectionFor(activeSlug);
    if (!section) {
      children.push(h("div", { class: "muted" }, "Unknown section."));
    } else if (!available) {
      children.push(
        h(
          "div",
          { class: "aaa-notice" },
          "User Manager is not installed on this device. Install the user-manager package (System → Packages) and reboot.",
        ),
      );
    } else {
      const bar = h("div", { class: "aaa-bar" });
      bar.append(h("span", { class: "muted" }, `${rows.length} row(s)`));
      bar.append(h("span", { class: "spacer" }));
      bar.append(button("↻ Refresh", () => void loadSection(activeSlug)));
      if (!section.readonly)
        bar.append(
          button(
            "+ Add",
            () => {
              editing = "new";
              form = {};
              render();
            },
            { class: "primary" },
          ),
        );
      children.push(bar);
      if (editing) children.push(renderForm(section));
      children.push(
        rows.length || !section ? renderTable(section) : h("div", { class: "muted" }, "No rows."),
      );
    }
  }

  root.replaceChildren(h("div", { class: "aaa-wrap" }, ...children));
}

// ── bridge ────────────────────────────────────────────────────────────────────
function adopt(structured: unknown): boolean {
  if (!structured || typeof structured !== "object") return false;
  const sc = structured as Record<string, unknown>;
  if (sc?.__mikrotikView === "aaa-settings") adoptSettings(sc);
  else if (sc.__mikrotikView === "aaa-section") adoptSection(sc);
  else return false;
  render();
  return true;
}
wireHostContext(app);

render();
void connectApp(app, "aaa", root, adopt);
