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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Plus, RefreshCw, Shuffle } from "lucide-react";
import { Input as BeuiInput } from "@/components/beui/registry/components/motion/input";
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
import { Badge, Button, Input, Note, Select } from "./geist";
import { toast } from "./toast-action";
import type { DevicesPayload } from "./types";
import { UmReports } from "./um-reports";
import { bytes, clock } from "./format";
import { generateUserPassword, UserCreatedDialog } from "./aaa-user-credentials";
import type { CreatedUserReceipt } from "./aaa-user-credentials";
import type { OpResult } from "../../src/tools/aaa-data";
import type { UmUserCounters } from "../../src/observability/um-reports";

type Row = Record<string, string>;
interface AaaList {
  available: boolean;
  rows: Row[];
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

/** Poll only the visible Users tab, without overlapping reads or losing the edit draft. */
function useUserCounters(device: string, enabled: boolean) {
  const [data, setData] = useState<UmUserCounters | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(document.hidden);
  const [now, setNow] = useState(Date.now);
  const refreshRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!enabled || !device) return;
    const controller = new AbortController();
    let pending = false;
    const refresh = async () => {
      setNow(Date.now());
      if (pending || document.hidden || controller.signal.aborted) return;
      pending = true;
      try {
        const result = await api<UmUserCounters>(
          `/api/aaa/user-counters?device=${encodeURIComponent(device)}`,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (!result.available) throw new Error(result.error || "User counters are unavailable.");
        if (result.device !== device)
          throw new Error("Counters belong to a different device. Refresh to retry.");
        setData(result);
        setError(null);
        setNow(Date.now());
      } catch (e) {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "Unable to read user counters.");
      } finally {
        pending = false;
      }
    };
    refreshRef.current = () => {
      void refresh();
    };
    const visibility = () => {
      setPaused(document.hidden);
      void refresh();
    };
    document.addEventListener("visibilitychange", visibility);
    const timer = setInterval(() => {
      void refresh();
    }, 5000);
    void refresh();
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
      refreshRef.current = () => {};
    };
  }, [device, enabled]);
  const current = data?.device === device ? data : null;
  const rows = useMemo(() => new Map(current?.rows.map((r) => [r.name, r])), [current]);
  return {
    data: current,
    error,
    paused,
    rows,
    stale: !!current && (now - current.collectedAt > 15_000 || !!error),
    refresh: () => refreshRef.current(),
  };
}

function connectionTime(seconds: number): string {
  const whole = Math.floor(seconds);
  const days = Math.floor(whole / 86400);
  return `${days ? `${days}d ` : ""}${[Math.floor(whole / 3600) % 24, Math.floor(whole / 60) % 60, whole % 60].map((v) => String(v).padStart(2, "0")).join(":")}`;
}

/** Fetch only while creating a user; profiles belong to the currently selected router. */
function InitialProfileField({
  device,
  value,
  onChange,
  disabled,
}: {
  device: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}): ReactNode {
  const [profiles, setProfiles] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const q = device ? `?device=${encodeURIComponent(device)}` : "";
    void api<AaaList>(`/api/aaa/list/um-profiles${q}`, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (!result.available)
          throw new Error("User Manager profiles are unavailable on this device.");
        setProfiles(result.rows.filter((row) => row.name));
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "Unable to load profiles.");
      });
    return () => controller.abort();
  }, [device, attempt]);
  const selected = profiles?.find((row) => row.name === value);
  return (
    <div className="mb-3.5 grid gap-3 rounded-lg border border-brand/25 bg-brand/5 p-3.5 sm:grid-cols-2">
      <div>
        <div className="text-sm font-medium">
          Initial profile <span className="font-normal text-muted-foreground">· optional</span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Assign a service profile as part of creating this user.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Profile rules apply when User Manager’s “Use profiles” setting is enabled.
        </p>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <Select
          aria-label="Initial profile"
          className="w-full"
          value={value}
          onValueChange={onChange}
          disabled={disabled || profiles === null || !!error}
          options={[
            {
              value: "",
              label: !profiles && !error ? "Loading profiles…" : "No profile — assign later",
            },
            ...(profiles ?? []).map((row) => ({ value: row.name, label: row.name })),
          ]}
        />
        {error ? (
          <div className="text-xs text-destructive" role="alert">
            {error}
            <Button
              size="sm"
              ghost
              disabled={disabled}
              onClick={() => {
                setProfiles(null);
                setError(null);
                setAttempt((n) => n + 1);
              }}
              className="mt-2"
            >
              Retry profiles
            </Button>
          </div>
        ) : profiles?.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No profiles yet. Create one in the Profiles tab, or continue without one.
          </p>
        ) : selected ? (
          <p className="text-xs text-muted-foreground">
            {selected.validity && <>Validity: {selected.validity} · </>}
            {selected["starts-when"] === "first-auth"
              ? "Starts on first authentication"
              : selected["starts-when"] === "assigned"
                ? "Starts immediately when assigned"
                : "Uses the profile’s activation settings"}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Existing users and profiles are not changed.
          </p>
        )}
      </div>
    </div>
  );
}

// ── one CRUD entity (table + inline add/edit form) ───────────────────────────
function EntityManager({ config, device }: { config: EntityConfig; device: string }): ReactNode {
  const showCounters = config.slug === "um-users";
  const counters = useUserCounters(device, showCounters);
  const [data, setData] = useState<AaaList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  // The form: null (closed), "new", or an existing row's id (editing).
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<Row>({});
  const [createdUser, setCreatedUser] = useState<CreatedUserReceipt | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);

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
    setError(null);
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
        if (path === "add" && config.slug === "um-users" && (r.ok || r.created)) {
          const fields = payload.fields as Row;
          setCreatedUser({
            device,
            name: fields.name,
            password: fields.password ?? "",
            warning: r.ok ? undefined : r.message,
            details: [
              [
                "Initial profile",
                fields.profile
                  ? `${fields.profile}${r.ok ? "" : " · unconfirmed"}`
                  : "None assigned",
              ],
              ["Group", fields.group || "Router default"],
              ["Shared users", fields["shared-users"] || "Router default"],
              ["Status", fields.disabled === "yes" ? "Disabled" : "Enabled"],
              ...(["caller-id", "attributes", "comment"] as const)
                .filter((key) => fields[key])
                .map((key): [string, string] => [
                  key === "caller-id"
                    ? "Caller ID"
                    : key === "attributes"
                      ? "RADIUS attributes"
                      : "Comment",
                  fields[key],
                ]),
            ],
          });
          setEditing(null);
          setForm({});
        }
        if (!r.ok) {
          if (r.created) {
            setEditing(null);
            setForm({});
            await load();
          }
          setError(r.message);
          toast.error(r.message || `${label} failed`);
          return false;
        }
        await load();
        toast.success(path === "add" && config.slug === "um-users" ? r.message : label);
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
  const fieldsFromRow = (r: Row): Row => {
    // Prefill non-secret fields; secrets are redacted, so leave blank = unchanged.
    const f: Row = {};
    for (const fd of config.fields) {
      if (fd.type === "password") continue;
      if (fd.key === "disabled") f.disabled = isDisabled(r) ? "yes" : "no";
      else if (r[fd.key] != null) f[fd.key] = r[fd.key];
    }
    return f;
  };
  const openEdit = (r: Row): void => {
    setEditing(r[config.idKey]);
    setForm(fieldsFromRow(r));
  };
  const save = async (): Promise<void> => {
    if (showCounters && editing === "new" && (!form.name?.trim() || !form.password)) {
      setError("Enter a name and password for the new user.");
      return;
    }
    const ok =
      editing === "new"
        ? await post("add", { fields: form })
        : await post("update", { id: editing, fields: form });
    if (ok) {
      setEditing(null);
      setForm({});
    }
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
    <div className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <Input
          className="w-[200px]"
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="text-muted-foreground text-[11px]">{rows.length} rows</span>
        <span className="flex-1" />
        <Button
          size="sm"
          ghost
          icon={<RefreshCw />}
          onClick={() => {
            void load();
            counters.refresh();
          }}
        >
          Refresh
        </Button>
        <Button
          ref={addButton}
          size="sm"
          type="accent"
          icon={<Plus />}
          disabled={busy}
          onClick={openAdd}
        >
          Add
        </Button>
      </div>

      {showCounters && (
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-card px-3 py-2 text-xs">
          <span
            role="status"
            className={cn(
              "font-medium",
              counters.stale || counters.error ? "text-warning" : "text-muted-foreground",
            )}
          >
            {counters.paused
              ? "Updates paused"
              : counters.error
                ? "Counters unavailable"
                : counters.stale
                  ? "Updates delayed"
                  : counters.data
                    ? "Live · 5s refresh"
                    : "Reading counters…"}
          </span>
          {counters.data && (
            <span className="text-muted-foreground">
              Last read {clock(counters.data.collectedAt)}
              {counters.stale ? " · showing last known values" : ""}
            </span>
          )}
          <span className="basis-full text-muted-foreground">
            Cumulative User Manager totals, not the current connection only. Values update when the
            NAS sends RADIUS accounting; refresh does not reset counters.
          </span>
          {counters.error && (
            <span role="alert" className="basis-full text-warning">
              {counters.error}
            </span>
          )}
        </div>
      )}

      {error && (
        <Note type="error" className="mb-2.5">
          {error}
        </Note>
      )}

      {editing && (
        <div className={FORM_BOX}>
          <div className={FORM_TITLE}>
            {editing === "new"
              ? showCounters
                ? "New User Manager user"
                : `New ${config.slug}`
              : `Edit ${editing}`}
          </div>
          {editing === "new" && config.slug === "um-users" && (
            <InitialProfileField
              key={device}
              device={device}
              value={form.profile ?? ""}
              onChange={(profile) => setForm((current) => ({ ...current, profile }))}
              disabled={busy}
            />
          )}
          <div className={FORM_GRID}>
            {config.fields.map((fd) =>
              showCounters && fd.key === "password" ? (
                <BeuiInput
                  key={fd.key}
                  label={`Password${editing === "new" ? " *" : ""}`}
                  type="password"
                  autoComplete="new-password"
                  disabled={busy}
                  placeholder={editing === "new" ? "Enter or generate a password" : "(unchanged)"}
                  value={form.password ?? ""}
                  onChange={(password) => setForm((current) => ({ ...current, password }))}
                  classNames={{
                    label: FIELD_LABEL,
                    field: "h-9 rounded-xl",
                    input: "pr-10 text-[13px] leading-5",
                    rightIcon: "[&_button]:size-9",
                  }}
                  rightIcon={
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        aria-label="Generate 8-character password"
                        title="Generate 8 characters: uppercase, lowercase, number and symbol"
                        className="rounded-lg text-brand transition-colors hover:bg-brand/10 focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2 disabled:opacity-50"
                        onClick={() => {
                          try {
                            const password = generateUserPassword();
                            setForm((current) => ({ ...current, password }));
                          } catch {
                            setError(
                              "Secure password generation is unavailable. Enter a password manually.",
                            );
                          }
                        }}
                      >
                        <Shuffle aria-hidden="true" />
                      </button>
                    </>
                  }
                />
              ) : (
                <label key={fd.key} className={FIELD}>
                  <span className={FIELD_LABEL}>
                    {fd.label}
                    {fd.required && editing === "new" ? " *" : ""}
                  </span>
                  {fd.type === "bool" ? (
                    <Select
                      disabled={busy}
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
                      disabled={busy}
                      value={form[fd.key] ?? ""}
                      onValueChange={(v) => setForm({ ...form, [fd.key]: v })}
                      options={[
                        { value: "", label: "—" },
                        ...(fd.options ?? []).map((o) => ({ value: o, label: o })),
                      ]}
                    />
                  ) : (
                    <Input
                      disabled={busy}
                      type={
                        fd.type === "password"
                          ? "password"
                          : fd.type === "number"
                            ? "number"
                            : "text"
                      }
                      placeholder={fd.placeholder ?? (fd.type === "password" ? "(unchanged)" : "")}
                      value={form[fd.key] ?? ""}
                      onChange={(e) => setForm({ ...form, [fd.key]: e.target.value })}
                    />
                  )}
                </label>
              ),
            )}
          </div>
          <div className={FORM_ACTIONS}>
            <Button size="sm" type="accent" loading={busy} onClick={() => void save()}>
              {editing === "new" ? "Create" : "Save"}
            </Button>
            <Button
              size="sm"
              ghost
              disabled={busy}
              onClick={() => {
                setEditing(null);
                setForm({});
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {!data ? (
        !error && (
          <div className="text-muted-foreground text-[11px]" role="status">
            Loading…
          </div>
        )
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
              {showCounters && (
                <>
                  <TableHead className="text-right">Total connected time</TableHead>
                  <TableHead className="text-right text-chart-1">↓ Download</TableHead>
                  <TableHead className="text-right text-chart-2">↑ Upload</TableHead>
                </>
              )}
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const id = r[config.idKey];
              const off = isDisabled(r);
              const counter = counters.rows.get(r.name);
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
                      ) : showCounters && c.key === "name" ? (
                        <div className="grid gap-1">
                          <span className="font-medium">{r.name}</span>
                          <span className="text-[10px] text-muted-foreground">
                            {counter?.active == null
                              ? "Connection count unknown"
                              : `${counter.active} active connection${counter.active === 1 ? "" : "s"}`}
                          </span>
                        </div>
                      ) : (
                        (r[c.key] ?? "")
                      )}
                    </TableCell>
                  ))}
                  {showCounters && (
                    <>
                      <TableCell
                        className="text-right font-mono tabular-nums"
                        title="Cumulative accounted connection time across this user's sessions"
                      >
                        {counter?.seconds == null ? "—" : connectionTime(counter.seconds)}
                      </TableCell>
                      <TableCell
                        className="text-right font-mono tabular-nums text-chart-1"
                        title="Total bytes downloaded by this user"
                      >
                        {counter?.download == null ? "—" : bytes(counter.download)}
                      </TableCell>
                      <TableCell
                        className="text-right font-mono tabular-nums text-chart-2"
                        title="Total bytes uploaded by this user"
                      >
                        {counter?.upload == null ? "—" : bytes(counter.upload)}
                      </TableCell>
                    </>
                  )}
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
      {createdUser && (
        <UserCreatedDialog
          user={createdUser}
          onClose={() => setCreatedUser(null)}
          onCloseAutoFocus={() => addButton.current?.focus()}
        />
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
  const [loadError, setLoadError] = useState("");
  const [available, setAvailable] = useState(true);
  const [form, setForm] = useState<Row>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    const q = device ? `?device=${encodeURIComponent(device)}` : "";
    try {
      const payload = await api<unknown>(`${getPath}${q}`);
      const { available: av, row: r } = unwrap(payload);
      setAvailable(av);
      setRow(r);
      setForm({});
      setLoadError("");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Settings could not be read.");
      setRow(null);
    }
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
  if (loadError)
    return (
      <Note type="error" label={title}>
        {loadError}{" "}
        <Button size="sm" ghost onClick={() => void load()}>
          Retry
        </Button>
      </Note>
    );
  if (!row)
    return (
      <p className="text-xs text-muted-foreground" role="status">
        Loading {title}…
      </p>
    );
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
  | "reports"
  | "settings";
const TABS: { id: TabId; label: string }[] = [
  { id: "reports", label: "Reports & insights" },
  { id: "radius", label: "RADIUS Servers" },
  { id: "users", label: "Users" },
  { id: "profiles", label: "Profiles" },
  { id: "limitations", label: "Limitations" },
  { id: "nas", label: "NAS Clients" },
  { id: "assignments", label: "Assignments" },
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
  const [tab, setTab] = useState<TabId>("reports");

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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">RADIUS & User Manager workspace</span>
        {routerOptions.length > 0 ? (
          <Select
            value={device}
            onValueChange={setDevice}
            aria-label="Router"
            options={routerOptions.map((d) => ({
              value: d.name,
              label: `${d.name}${d.isDefault ? " (default)" : ""}`,
            }))}
          />
        ) : null}
      </div>
      <Tabs key={device} value={tab} onValueChange={(v) => setTab(v as TabId)}>
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
        <TabsContent value="reports">
          <UmReports key={device} device={device} />
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
    </section>
  );
}
