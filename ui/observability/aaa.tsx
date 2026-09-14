/**
 * AAA view — full management of the router's RADIUS client (`/radius`) and the
 * built-in User Manager RADIUS server (`/user-manager`).
 *
 * Talks to the dashboard's `/api/aaa/*` routes, which call the same shared
 * `aaa-data` layer the AAA MCP App view uses — so a change here and a change
 * from chat run identical RouterOS commands. The CRUD entities (RADIUS servers,
 * UM users/profiles/limitations/NAS clients/assignments) are all rendered by one
 * schema-driven {@link EntityManager}; sessions are read-only; RADIUS-incoming
 * (CoA) and UM global settings are singleton forms.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { api, postJson } from "./api";
import { Panel } from "./atoms";
import { Badge, Button, Input, Note, Select } from "./geist";
import { toast } from "./toast-action";
import type { DevicesPayload } from "./types";
import { Heatmap, UsageHistoryChart } from "./usage-charts";

type Row = Record<string, string>;
interface AaaList {
  available: boolean;
  rows: Row[];
}
interface OpResult {
  ok: boolean;
  message: string;
}

/** A form/column field. `key` is the RouterOS attribute name (server whitelist). */
interface Field {
  key: string;
  label: string;
  type?: "text" | "number" | "password" | "bool" | "select";
  options?: string[];
  placeholder?: string;
  /** Required when creating (add). */
  required?: boolean;
}

interface EntityConfig {
  slug: string;
  /** The row column holding the stable id sent on mutations (`.id` or `name`). */
  idKey: string;
  /** Columns shown in the table. */
  columns: { key: string; label: string }[];
  /** Fields offered in the add/edit form. */
  fields: Field[];
  toggle?: boolean;
  /** Assignment-style entities support add + remove but not edit. */
  addOnly?: boolean;
  /** A short empty-state hint. */
  empty?: string;
}

// ── helpers ──────────────────────────────────────────────────────────────────
const isDisabled = (r: Row): boolean => (r.flags ?? "").includes("X") || r.disabled === "yes";

function rowLabel(r: Row, cfg: EntityConfig): string {
  return r[cfg.idKey] || r.name || r.address || r.user || "(row)";
}

// Shared surface for the inline add/edit and singleton forms.
const FORM_BOX = "mb-3.5 rounded-md border border-border bg-card p-3.5";
const FORM_TITLE = "mb-2.5 text-[13px] font-semibold";
const FORM_GRID = "grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-x-3.5 gap-y-2.5";
const FORM_ACTIONS = "mt-3.5 flex items-center gap-2.5";
const FIELD = "flex flex-col gap-1";
const FIELD_LABEL = "text-[11.5px] text-muted-foreground";

// ── one CRUD entity (table + inline add/edit form) ───────────────────────────
function EntityManager({ config, device }: { config: EntityConfig; device: string }): ReactNode {
  const [data, setData] = useState<AaaList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  // The form: null (closed), "new", or an existing row's id (editing).
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<Row>({});

  const load = useCallback(async (): Promise<void> => {
    try {
      const q = device ? `?device=${encodeURIComponent(device)}` : "";
      setData(await api<AaaList>(`/api/aaa/list/${config.slug}${q}`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [config.slug, device]);

  useEffect(() => {
    setData(null);
    setEditing(null);
    void load();
  }, [load]);

  const post = useCallback(
    async (path: string, payload: Record<string, unknown>): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        const r = await postJson<OpResult>(`/api/aaa/${path}`, {
          device,
          slug: config.slug,
          ...payload,
        });
        const label =
          path === "add"
            ? "Entry added"
            : path === "update"
              ? "Entry saved"
              : path === "remove"
                ? "Entry removed"
                : path === "toggle"
                  ? payload.enable
                    ? "Entry enabled"
                    : "Entry disabled"
                  : "Done";
        if (!r.ok) {
          setError(r.message);
          toast.error(r.message || `${label} failed`);
          return false;
        }
        await load();
        toast.success(label);
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        toast.error(e instanceof Error ? e.message : "Action failed");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [device, config.slug, load],
  );

  const openAdd = (): void => {
    setEditing("new");
    setForm({});
  };
  const openEdit = (r: Row): void => {
    setEditing(r[config.idKey]);
    // Prefill non-secret fields; secrets are redacted, so leave blank = unchanged.
    const f: Row = {};
    for (const fd of config.fields) {
      if (fd.type === "password") continue;
      if (fd.key === "disabled") f.disabled = isDisabled(r) ? "yes" : "no";
      else if (r[fd.key] != null) f[fd.key] = r[fd.key];
    }
    setForm(f);
  };

  const save = async (): Promise<void> => {
    const ok =
      editing === "new"
        ? await post("add", { fields: form })
        : await post("update", { id: editing, fields: form });
    if (ok) setEditing(null);
  };

  const rows = useMemo(() => {
    const all = data?.rows ?? [];
    const q = filter.trim().toLowerCase();
    if (!q) return all;
    return all.filter((r) =>
      config.columns.some((c) => (r[c.key] ?? "").toLowerCase().includes(q)),
    );
  }, [data, filter, config.columns]);

  if (data && !data.available) {
    return (
      <Note type="warning" label="User Manager not installed">
        This device doesn't have the <code>user-manager</code> package. Install it (System →
        Packages) and reboot to manage the built-in RADIUS server here.
      </Note>
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center gap-2.5">
        <Input
          className="w-[200px]"
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="text-muted-foreground text-[11px]">{rows.length} rows</span>
        <span className="flex-1" />
        <Button size="sm" ghost icon={<RefreshCw />} onClick={() => void load()}>
          Refresh
        </Button>
        <Button size="sm" type="accent" icon={<Plus />} onClick={openAdd}>
          Add
        </Button>
      </div>

      {error && (
        <Note type="error" className="mb-2.5">
          {error}
        </Note>
      )}

      {editing && (
        <div className={FORM_BOX}>
          <div className={FORM_TITLE}>
            {editing === "new" ? `New ${config.slug}` : `Edit ${editing}`}
          </div>
          <div className={FORM_GRID}>
            {config.fields.map((fd) => (
              <label key={fd.key} className={FIELD}>
                <span className={FIELD_LABEL}>
                  {fd.label}
                  {fd.required && editing === "new" ? " *" : ""}
                </span>
                {fd.type === "bool" ? (
                  <Select
                    value={form[fd.key] ?? ""}
                    onValueChange={(v) => setForm({ ...form, [fd.key]: v })}
                    options={[
                      { value: "", label: "—" },
                      { value: "no", label: "no" },
                      { value: "yes", label: "yes" },
                    ]}
                  />
                ) : fd.type === "select" ? (
                  <Select
                    value={form[fd.key] ?? ""}
                    onValueChange={(v) => setForm({ ...form, [fd.key]: v })}
                    options={[
                      { value: "", label: "—" },
                      ...(fd.options ?? []).map((o) => ({ value: o, label: o })),
                    ]}
                  />
                ) : (
                  <Input
                    type={
                      fd.type === "password" ? "password" : fd.type === "number" ? "number" : "text"
                    }
                    placeholder={fd.placeholder ?? (fd.type === "password" ? "(unchanged)" : "")}
                    value={form[fd.key] ?? ""}
                    onChange={(e) => setForm({ ...form, [fd.key]: e.target.value })}
                  />
                )}
              </label>
            ))}
          </div>
          <div className={FORM_ACTIONS}>
            <Button size="sm" type="accent" loading={busy} onClick={() => void save()}>
              {editing === "new" ? "Create" : "Save"}
            </Button>
            <Button size="sm" ghost onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {!data ? (
        <div className="text-muted-foreground text-[11px]">loading…</div>
      ) : rows.length === 0 ? (
        <div className="px-1 py-5 text-muted-foreground text-[11px]">
          {config.empty ?? "Nothing here yet."}
        </div>
      ) : (
        <Table className="text-[13px]">
          <TableHeader>
            <TableRow>
              {config.columns.map((c) => (
                <TableHead key={c.key}>{c.label}</TableHead>
              ))}
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const id = r[config.idKey];
              const off = isDisabled(r);
              return (
                <TableRow key={id || rowLabel(r, config)}>
                  {config.columns.map((c) => (
                    <TableCell
                      key={c.key}
                      className={cn(off && "text-muted-foreground")}
                      title={r[c.key] ?? ""}
                    >
                      {c.key === "_status" ? (
                        <Badge type={off ? "secondary" : "success"}>
                          {off ? "disabled" : "enabled"}
                        </Badge>
                      ) : (
                        (r[c.key] ?? "")
                      )}
                    </TableCell>
                  ))}
                  <TableCell className="text-right">
                    <span className="flex justify-end gap-1.5">
                      {config.toggle && (
                        <Button
                          size="sm"
                          ghost
                          disabled={busy}
                          onClick={() => void post("toggle", { id, enable: off })}
                        >
                          {off ? "Enable" : "Disable"}
                        </Button>
                      )}
                      {!config.addOnly && (
                        <Button size="sm" ghost disabled={busy} onClick={() => openEdit(r)}>
                          Edit
                        </Button>
                      )}
                      <Button
                        size="sm"
                        type="error"
                        ghost
                        disabled={busy}
                        onClick={() => void post("remove", { id })}
                      >
                        Remove
                      </Button>
                    </span>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

// ── read-only sessions table ─────────────────────────────────────────────────
const SESSION_COLS = [
  "user",
  "calling-station-id",
  "nas-ip-address",
  "started",
  "ended",
  "uptime",
  "download",
  "upload",
  "status",
];
function SessionsTable({ device }: { device: string }): ReactNode {
  const [data, setData] = useState<AaaList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const load = useCallback(async (): Promise<void> => {
    try {
      const q = device ? `?device=${encodeURIComponent(device)}` : "";
      setData(await api<AaaList>(`/api/aaa/list/um-sessions${q}`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [device]);
  useEffect(() => {
    setData(null);
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [load]);

  if (data && !data.available) {
    return (
      <Note type="warning" label="User Manager not installed">
        The <code>user-manager</code> package isn't installed on this device.
      </Note>
    );
  }
  const rows = (data?.rows ?? []).filter(
    (r) => !filter.trim() || (r.user ?? "").toLowerCase().includes(filter.trim().toLowerCase()),
  );
  return (
    <div>
      <div className="mb-3 flex items-center gap-2.5">
        <Input
          className="w-[200px]"
          placeholder="Filter by user…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="text-muted-foreground text-[11px]">{rows.length} sessions</span>
        <span className="flex-1" />
        <Button size="sm" ghost icon={<RefreshCw />} onClick={() => void load()}>
          Refresh
        </Button>
      </div>
      {error && <Note type="error">{error}</Note>}
      {!data ? (
        <div className="text-muted-foreground text-[11px]">loading…</div>
      ) : rows.length === 0 ? (
        <div className="px-1 py-5 text-muted-foreground text-[11px]">
          No accounting sessions recorded.
        </div>
      ) : (
        <Table className="text-[13px]">
          <TableHeader>
            <TableRow>
              {SESSION_COLS.map((c) => (
                <TableHead key={c}>{c.replace(/-/g, " ")}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={r[".id"] || i}>
                {SESSION_COLS.map((c) => (
                  <TableCell key={c} title={r[c] ?? ""}>
                    {r[c] ?? ""}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

// ── singleton settings forms (RADIUS incoming / UM global) ───────────────────
function SingletonForm({
  device,
  getPath,
  setPath,
  fields,
  title,
  unwrap,
  extra,
}: {
  device: string;
  getPath: string;
  setPath: string;
  fields: Field[];
  title: string;
  /** Pull the row out of the GET payload (UM settings nests under `settings`). */
  unwrap: (payload: unknown) => { available: boolean; row: Row };
  extra?: ReactNode;
}): ReactNode {
  const [row, setRow] = useState<Row | null>(null);
  const [available, setAvailable] = useState(true);
  const [form, setForm] = useState<Row>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    const q = device ? `?device=${encodeURIComponent(device)}` : "";
    const payload = await api<unknown>(`${getPath}${q}`).catch(() => null);
    const { available: av, row: r } = unwrap(payload);
    setAvailable(av);
    setRow(r);
    setForm({});
  }, [device, getPath, unwrap]);
  useEffect(() => {
    void load();
  }, [load]);

  const save = async (): Promise<void> => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await postJson<OpResult>(setPath, { device, fields: form });
      setMsg(r.message);
      if (r.ok) {
        await load();
        toast.success("Settings saved");
      } else {
        toast.error(r.message || "Save failed");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  if (!available) {
    return (
      <Note type="warning" label="Not available">
        {title} is not available on this device.
      </Note>
    );
  }
  return (
    <div className={FORM_BOX}>
      <div className={FORM_TITLE}>{title}</div>
      {row && (
        <div className="mb-3 text-muted-foreground text-xs">
          {fields.map((f) => `${f.label}: ${row[f.key] ?? "—"}`).join("  ·  ")}
        </div>
      )}
      <div className={FORM_GRID}>
        {fields.map((f) => (
          <label key={f.key} className={FIELD}>
            <span className={FIELD_LABEL}>{f.label}</span>
            {f.type === "bool" ? (
              <Select
                value={form[f.key] ?? ""}
                onValueChange={(v) => setForm({ ...form, [f.key]: v })}
                options={[
                  { value: "", label: "(unchanged)" },
                  { value: "no", label: "no" },
                  { value: "yes", label: "yes" },
                ]}
              />
            ) : (
              <Input
                type={f.type === "number" ? "number" : "text"}
                placeholder={f.placeholder ?? row?.[f.key] ?? ""}
                value={form[f.key] ?? ""}
                onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
              />
            )}
          </label>
        ))}
      </div>
      <div className={FORM_ACTIONS}>
        <Button size="sm" type="accent" loading={busy} onClick={() => void save()}>
          Save
        </Button>
        {extra}
        {msg && <span className="text-muted-foreground text-[11px]">{msg}</span>}
      </div>
    </div>
  );
}

// ── entity schemas (mirror the server's allowed-field whitelist) ─────────────
const RADIUS_CONFIG: EntityConfig = {
  slug: "radius",
  idKey: ".id",
  toggle: true,
  columns: [
    { key: "address", label: "Address" },
    { key: "service", label: "Service" },
    { key: "authentication-port", label: "Auth" },
    { key: "accounting-port", label: "Acct" },
    { key: "protocol", label: "Proto" },
    { key: "_status", label: "Status" },
  ],
  empty: "No RADIUS servers configured.",
  fields: [
    { key: "address", label: "Address", required: true, placeholder: "1.2.3.4 or host" },
    { key: "secret", label: "Secret", type: "password", required: true },
    {
      key: "service",
      label: "Service",
      required: true,
      placeholder: "login,ppp,hotspot,wireless,dhcp,ipsec,dot1x",
    },
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
};

const UM_USERS_CONFIG: EntityConfig = {
  slug: "um-users",
  idKey: "name",
  toggle: true,
  columns: [
    { key: "name", label: "Name" },
    { key: "group", label: "Group" },
    { key: "shared-users", label: "Shared" },
    { key: "caller-id", label: "Caller ID" },
    { key: "comment", label: "Comment" },
    { key: "_status", label: "Status" },
  ],
  empty: "No RADIUS users.",
  fields: [
    { key: "name", label: "Name", required: true },
    { key: "password", label: "Password", type: "password", required: true },
    { key: "group", label: "Group" },
    { key: "shared-users", label: "Shared users", type: "number", placeholder: "1" },
    { key: "attributes", label: "RADIUS attributes" },
    { key: "caller-id", label: "Caller ID (MAC)" },
    { key: "otp-secret", label: "OTP secret", type: "password" },
    { key: "comment", label: "Comment" },
    { key: "disabled", label: "Disabled", type: "bool" },
  ],
};

const UM_PROFILES_CONFIG: EntityConfig = {
  slug: "um-profiles",
  idKey: "name",
  columns: [
    { key: "name", label: "Name" },
    { key: "name-for-users", label: "Display" },
    { key: "validity", label: "Validity" },
    { key: "price", label: "Price" },
    { key: "starts-when", label: "Starts" },
  ],
  empty: "No service profiles.",
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
    { key: "override-shared-users", label: "Override shared-users" },
    { key: "comment", label: "Comment" },
  ],
};

const UM_LIMITATIONS_CONFIG: EntityConfig = {
  slug: "um-limitations",
  idKey: "name",
  columns: [
    { key: "name", label: "Name" },
    { key: "rate-limit-rx", label: "Rate ↓" },
    { key: "rate-limit-tx", label: "Rate ↑" },
    { key: "transfer-limit", label: "Transfer" },
    { key: "uptime-limit", label: "Uptime" },
  ],
  empty: "No limitation templates.",
  fields: [
    { key: "name", label: "Name", required: true },
    { key: "rate-limit-rx", label: "Download rate", placeholder: "10M" },
    { key: "rate-limit-tx", label: "Upload rate", placeholder: "10M" },
    { key: "rate-limit-min-rx", label: "Min download (CIR)", placeholder: "2M" },
    { key: "rate-limit-min-tx", label: "Min upload (CIR)", placeholder: "2M" },
    { key: "rate-limit-burst-rx", label: "Burst download", placeholder: "20M" },
    { key: "rate-limit-burst-tx", label: "Burst upload", placeholder: "20M" },
    { key: "rate-limit-burst-threshold-rx", label: "Burst thr. ↓" },
    { key: "rate-limit-burst-threshold-tx", label: "Burst thr. ↑" },
    { key: "rate-limit-burst-time-rx", label: "Burst time ↓", placeholder: "10s" },
    { key: "rate-limit-burst-time-tx", label: "Burst time ↑", placeholder: "10s" },
    { key: "rate-limit-priority", label: "Priority (1-8)", type: "number" },
    { key: "download-limit", label: "Download cap", placeholder: "5G" },
    { key: "upload-limit", label: "Upload cap", placeholder: "5G" },
    { key: "transfer-limit", label: "Total transfer cap", placeholder: "10G" },
    { key: "uptime-limit", label: "Uptime cap", placeholder: "1d" },
    { key: "reset-counters-interval", label: "Reset interval" },
    { key: "reset-counters-start-time", label: "Reset start time" },
    { key: "comment", label: "Comment" },
  ],
};

const UM_ROUTERS_CONFIG: EntityConfig = {
  slug: "um-routers",
  idKey: "name",
  toggle: true,
  columns: [
    { key: "name", label: "Name" },
    { key: "address", label: "Address" },
    { key: "coa-port", label: "CoA port" },
    { key: "protocol", label: "Proto" },
    { key: "comment", label: "Comment" },
    { key: "_status", label: "Status" },
  ],
  empty: "No NAS clients registered.",
  fields: [
    { key: "name", label: "Name", required: true },
    { key: "address", label: "Address", required: true, placeholder: "192.168.88.1" },
    { key: "shared-secret", label: "Shared secret", type: "password", required: true },
    { key: "coa-port", label: "CoA port", type: "number" },
    { key: "protocol", label: "Protocol", placeholder: "radius" },
    { key: "comment", label: "Comment" },
    { key: "disabled", label: "Disabled", type: "bool" },
  ],
};

const UM_ASSIGN_CONFIG: EntityConfig = {
  slug: "um-user-profiles",
  idKey: ".id",
  addOnly: true,
  columns: [
    { key: "user", label: "User" },
    { key: "profile", label: "Profile" },
    { key: "state", label: "State" },
    { key: "end-time", label: "Ends" },
  ],
  empty: "No profile assignments.",
  fields: [
    { key: "user", label: "User", required: true },
    { key: "profile", label: "Profile", required: true },
  ],
};

// ── tabs ─────────────────────────────────────────────────────────────────────
type TabId =
  | "radius"
  | "users"
  | "profiles"
  | "limitations"
  | "nas"
  | "assignments"
  | "sessions"
  | "usage"
  | "settings";
const TABS: { id: TabId; label: string }[] = [
  { id: "radius", label: "RADIUS Servers" },
  { id: "users", label: "Users" },
  { id: "profiles", label: "Profiles" },
  { id: "limitations", label: "Limitations" },
  { id: "nas", label: "NAS Clients" },
  { id: "assignments", label: "Assignments" },
  { id: "sessions", label: "Sessions" },
  { id: "usage", label: "Usage & Heatmap" },
  { id: "settings", label: "Settings" },
];

const RADIUS_INCOMING_FIELDS: Field[] = [
  { key: "accept", label: "Accept CoA", type: "bool" },
  { key: "port", label: "CoA port", type: "number", placeholder: "3799" },
];
const UM_SETTINGS_FIELDS: Field[] = [
  { key: "enabled", label: "Enabled", type: "bool" },
  { key: "use-profiles", label: "Use profiles", type: "bool" },
  { key: "certificate", label: "Certificate" },
  { key: "authentication-port", label: "Auth port", type: "number" },
  { key: "accounting-port", label: "Acct port", type: "number" },
];

/**
 * Usage & heatmap tab: per-user 3-month download/upload (from persisted User
 * Manager sessions) and a GitHub-style connection heatmap (per-day VPN/RADIUS
 * connection counts), both backed by the local usage database.
 */
function UsageTab({ device }: { device: string }): ReactNode {
  const [users, setUsers] = useState<string[] | null>(null);
  const [user, setUser] = useState<string>("");

  useEffect(() => {
    const q = device ? `?device=${encodeURIComponent(device)}` : "";
    void api<{ users: string[] }>(`/api/usage/um-users${q}`)
      .then((r) => {
        setUsers(r.users);
        setUser((cur) => cur || r.users[0] || "");
      })
      .catch(() => setUsers([]));
  }, [device]);

  const dev = device ? `&device=${encodeURIComponent(device)}` : "";

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <span className="text-muted-foreground text-[11px]">User</span>
        <Select
          value={user}
          onValueChange={setUser}
          aria-label="User"
          options={
            users && users.length > 0
              ? users.map((u) => ({ value: u, label: u }))
              : [{ value: "", label: "— no sessions recorded yet —" }]
          }
        />
      </div>

      {users && users.length === 0 ? (
        <Note type="secondary" label="No data yet">
          No User Manager sessions have been recorded yet. The dashboard ingests sessions on a
          configurable interval (1 minute by default — change it under the Settings tab) and keeps
          them forever, so usage and the heatmap fill in over time.
        </Note>
      ) : (
        user && (
          <>
            <div className="mt-4">
              <div className="mb-2 text-xs font-semibold text-muted-foreground">
                Download / upload · last 3 months
              </div>
              <UsageHistoryChart
                endpoint={`/api/usage/um-user?user=${encodeURIComponent(user)}${dev}&days=90`}
                days={90}
              />
            </div>
            <div className="mt-4">
              <div className="mb-2 text-xs font-semibold text-muted-foreground">
                Connection heatmap · {user}
              </div>
              <Heatmap
                endpoint={`/api/usage/heatmap?user=${encodeURIComponent(user)}${dev}&days=371`}
                label={`${user} — connections`}
              />
            </div>
            <div className="mt-4">
              <div className="mb-2 text-xs font-semibold text-muted-foreground">
                All users · connections
              </div>
              <Heatmap endpoint={`/api/usage/heatmap?days=371${dev}`} label="All users" />
            </div>
          </>
        )
      )}
    </div>
  );
}

/**
 * Usage-sampling cadence — how often the dashboard snapshots client traffic and
 * ingests User Manager sessions into the local usage database. Dashboard-level
 * (not a device command), so it has its own GET/POST `/api/usage/sampler` route.
 */
function SamplerSettings(): ReactNode {
  const [minutes, setMinutes] = useState("");
  const [current, setCurrent] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await api<{ intervalMs: number }>("/api/usage/sampler");
      setCurrent(r.intervalMs);
    } catch {
      setCurrent(null);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const save = async (): Promise<void> => {
    const mins = Number(minutes);
    if (!Number.isFinite(mins) || mins <= 0) {
      setMsg("Enter a positive number of minutes.");
      toast.error("Enter a positive number of minutes");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const r = await postJson<{ intervalMs: number }>("/api/usage/sampler", {
        intervalMs: Math.round(mins * 60_000),
      });
      setCurrent(r.intervalMs);
      setMinutes("");
      setMsg(`Now sampling every ${fmtInterval(r.intervalMs)}.`);
      toast.success(`Now sampling every ${fmtInterval(r.intervalMs)}`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-border bg-card p-3.5">
      <div className={FORM_TITLE}>Usage sampling</div>
      <div className="mb-3 text-muted-foreground text-xs">
        How often client traffic + User Manager sessions are recorded into the usage history.
        Current: {current == null ? "…" : fmtInterval(current)} · default 1 minute · range 30s–6h.
      </div>
      <div className={FORM_GRID}>
        <label className={FIELD}>
          <span className={FIELD_LABEL}>Interval (minutes)</span>
          <Input
            type="number"
            step="0.5"
            min="0.5"
            placeholder={current ? String(current / 60_000) : "1"}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
          />
        </label>
      </div>
      <div className={FORM_ACTIONS}>
        <Button size="sm" type="accent" loading={busy} onClick={() => void save()}>
          Save
        </Button>
        {[1, 5, 10, 30].map((m) => (
          <Button
            key={m}
            size="sm"
            ghost
            onClick={() => {
              setMinutes(String(m));
            }}
          >
            {m}m
          </Button>
        ))}
        {msg && <span className="text-muted-foreground text-[11px]">{msg}</span>}
      </div>
    </div>
  );
}

/** Human label for a sampling interval in ms (`45s`, `1 min`, `2.5 min`). */
function fmtInterval(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = ms / 60_000;
  return `${Number.isInteger(m) ? m : m.toFixed(1)} min`;
}

/** RADIUS client + User Manager (built-in RADIUS server) management. */
export function AaaView(): ReactNode {
  const [routers, setRouters] = useState<DevicesPayload | null>(null);
  const [device, setDevice] = useState("");
  const [tab, setTab] = useState<TabId>("radius");

  useEffect(() => {
    void api<DevicesPayload>("/api/devices")
      .then((r) => {
        setRouters(r);
        setDevice((cur) => cur || r.defaultDevice || r.devices[0]?.name || "");
      })
      .catch(() => setRouters({ server: "", defaultDevice: "", devices: [] }));
  }, []);

  const routerOptions = routers?.devices ?? [];

  return (
    <section className="grid content-start gap-[18px]">
      <Panel
        title="RADIUS & User Manager"
        className="reveal"
        extra={
          routerOptions.length > 1 ? (
            <Select
              value={device}
              onValueChange={setDevice}
              aria-label="Router"
              options={routerOptions.map((d) => ({
                value: d.name,
                label: `${d.name}${d.isDefault ? " (default)" : ""}`,
              }))}
            />
          ) : undefined
        }
      >
        <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)}>
          <TabsList className="mb-3.5 h-auto w-full flex-wrap justify-start border-b border-border">
            {TABS.map((t) => (
              <TabsTrigger key={t.id} value={t.id}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="radius">
            <EntityManager config={RADIUS_CONFIG} device={device} />
          </TabsContent>
          <TabsContent value="users">
            <EntityManager config={UM_USERS_CONFIG} device={device} />
          </TabsContent>
          <TabsContent value="profiles">
            <EntityManager config={UM_PROFILES_CONFIG} device={device} />
          </TabsContent>
          <TabsContent value="limitations">
            <EntityManager config={UM_LIMITATIONS_CONFIG} device={device} />
          </TabsContent>
          <TabsContent value="nas">
            <EntityManager config={UM_ROUTERS_CONFIG} device={device} />
          </TabsContent>
          <TabsContent value="assignments">
            <EntityManager config={UM_ASSIGN_CONFIG} device={device} />
          </TabsContent>
          <TabsContent value="sessions">
            <SessionsTable device={device} />
          </TabsContent>
          <TabsContent value="usage">
            <UsageTab device={device} />
          </TabsContent>
          <TabsContent value="settings">
            <div className="flex flex-col gap-2">
              <SingletonForm
                device={device}
                getPath="/api/aaa/radius-incoming"
                setPath="/api/aaa/radius-incoming"
                title="RADIUS Incoming (CoA listener)"
                fields={RADIUS_INCOMING_FIELDS}
                unwrap={(p) => ({ available: true, row: (p as Row) ?? {} })}
                extra={
                  <Button
                    size="sm"
                    ghost
                    onClick={() =>
                      void postJson("/api/aaa/radius-reset-counters", { device })
                        .then(() => toast.success("Counters reset"))
                        .catch(() => toast.error("Reset counters failed"))
                    }
                  >
                    Reset RADIUS counters
                  </Button>
                }
              />
              <SingletonForm
                device={device}
                getPath="/api/aaa/um-settings"
                setPath="/api/aaa/um-settings"
                title="User Manager (built-in RADIUS server)"
                fields={UM_SETTINGS_FIELDS}
                unwrap={(p) => {
                  const o = (p as { available?: boolean; settings?: Row }) ?? {};
                  return { available: o.available !== false, row: o.settings ?? {} };
                }}
              />
              <SamplerSettings />
            </div>
          </TabsContent>
        </Tabs>
      </Panel>
    </section>
  );
}
