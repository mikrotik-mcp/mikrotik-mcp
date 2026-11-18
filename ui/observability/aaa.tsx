/**
 * AAA view — full management of the router's RADIUS client (`/radius`) and the
 * built-in User Manager RADIUS server (`/user-manager`).
 *
 * Talks to the dashboard's `/api/aaa/*` routes, which call the same shared
 * `aaa-data` layer the AAA MCP App view uses — so a change here and a change
 * from chat run identical RouterOS commands. The CRUD entities (RADIUS servers,
 * UM users/profiles/limitations/NAS clients/assignments) are all rendered by one
 * schema-driven {@link EntityManager}: a table with a row menu, and an add/edit
 * dialog. RADIUS-incoming (CoA) and UM global settings are singleton forms.
 */
import { LoadingState } from "./loading-state";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { format, isValid, parseISO } from "date-fns";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Eye,
  EyeOff,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { api, postJson } from "./api";
import { toast } from "./toast-action";
import type { DevicesPayload } from "./types";
import { UmReports } from "./um-reports";
import { clock, limitationRate } from "./format";
import { cn } from "@/lib/utils";
import { generateUserPassword, UserCreatedDialog } from "./aaa-user-credentials";
import type { CreatedUserReceipt } from "./aaa-user-credentials";
import { UserProfileField } from "./aaa-user-profile";
import { AaaSelect, compactBytes } from "./aaa-ui";
import {
  MonitorButton,
  MonitorDialog,
  MonitorEmpty,
  MonitorNote,
  MonitorPanel,
  MonitorSearch,
  MonitorTabs,
  PageIntro,
  RouterPicker,
  StatusBadge,
} from "./monitoring-ui";
import type { Tone } from "./monitoring-ui";
import {
  DetailBlock,
  DetailList,
  Field as KitField,
  NumberInput,
  RowDrawer,
  RowMenu,
  RowMore,
  SecretInput,
  TextInput,
} from "./kit";
import type { RowAction } from "./kit";
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
  /** Placeholder while editing, when it differs (secrets: "(unchanged)"). */
  editPlaceholder?: string;
  /** Required when creating (add). */
  required?: boolean;
}

interface EntityConfig {
  slug: string;
  /** The row column holding the stable id sent on mutations (`.id` or `name`). */
  idKey: string;
  /** Columns shown in the table. */
  columns: { key: string; label: string }[];
  /** CSS grid columns for the table, the action column included. */
  grid: string;
  /** Fields offered in the add/edit form. */
  fields: Field[];
  toggle?: boolean;
  /** Assignment-style entities support add + remove but not edit. */
  addOnly?: boolean;
  /** A short empty-state hint. */
  empty: string;
  /** Header and panel copy. */
  noun: [singular: string, plural: string];
  eyebrow: string;
  lead: string;
  add: string;
  panel: string;
  panelDescription: string;
}

// ── helpers ──────────────────────────────────────────────────────────────────
const isDisabled = (r: Row): boolean => (r.flags ?? "").includes("X") || r.disabled === "yes";

function rowLabel(r: Row, cfg: EntityConfig): string {
  return r[cfg.idKey] || r.name || r.address || r.user || "(row)";
}

/** Rows shown before "Show all". */
const PAGE = 10;

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

/** "2026-11-14 09:50:12" (router local time) as "Nov 14" and "09:50". */
function lastConnection(value: string): [string, string] {
  const date = parseISO(value.slice(0, 10));
  return [isValid(date) ? format(date, "MMM dd") : value.slice(0, 10), value.slice(11, 16)];
}

/** The page header (eyebrow, heading, lead, router + add) and the tab strip. */
function AaaHead({
  eyebrow,
  heading,
  lead,
  actions,
  tabs,
}: {
  eyebrow: string;
  heading: ReactNode;
  lead: ReactNode;
  actions?: ReactNode;
  tabs: ReactNode;
}): ReactNode {
  return (
    <div className="aaa-head">
      <PageIntro
        eyebrow={`RADIUS & User Manager · ${eyebrow}`}
        heading={heading}
        lead={lead}
        actions={actions}
      />
      {tabs}
    </div>
  );
}

/** One form field in the dialog: a label over an input or a select. */
function FormField({
  field,
  value,
  creating,
  disabled,
  onChange,
}: {
  field: Field;
  value: string;
  creating: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
}): ReactNode {
  const id = useId();
  const label = `${field.label}${field.required && creating ? " *" : ""}`;
  if (field.type === "bool" || field.type === "select")
    return (
      <div className="monitor-fl">
        <span className="monitor-label">{label}</span>
        <AaaSelect
          label={field.label}
          disabled={disabled}
          value={value}
          onChange={onChange}
          options={[
            { value: "", label: "—" },
            ...(field.type === "bool" ? ["no", "yes"] : (field.options ?? [])).map((o) => ({
              value: o,
              label: o,
            })),
          ]}
        />
      </div>
    );
  const placeholder =
    (!creating ? field.editPlaceholder : undefined) ??
    field.placeholder ??
    (field.type === "password" ? "(unchanged)" : "");
  return (
    <KitField label={label} className="monitor-fl" id={id}>
      {field.type === "number" ? (
        <NumberInput
          allowEmpty
          disabled={disabled}
          placeholder={placeholder}
          value={value === "" || !Number.isFinite(Number(value)) ? null : Number(value)}
          onChange={(n) => onChange(n == null ? "" : String(n))}
        />
      ) : field.type === "password" ? (
        <SecretInput
          disabled={disabled}
          autoComplete="off"
          placeholder={placeholder}
          value={value}
          onChange={onChange}
        />
      ) : (
        <TextInput
          disabled={disabled}
          placeholder={placeholder}
          value={value}
          onChange={onChange}
        />
      )}
    </KitField>
  );
}

// ── one CRUD entity (table + add/edit dialog) ────────────────────────────────
function EntityManager({
  config,
  device,
  tabs,
  router,
}: {
  config: EntityConfig;
  device: string;
  tabs: ReactNode;
  router: ReactNode;
}): ReactNode {
  const showCounters = config.slug === "um-users";
  const counters = useUserCounters(device, showCounters);
  const passwordId = useId();
  const [data, setData] = useState<AaaList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const [showAll, setShowAll] = useState(false);
  // The form: null (closed), "new", or an existing row's id (editing).
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<Row>({});
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [profileReady, setProfileReady] = useState(false);
  const [createdUser, setCreatedUser] = useState<CreatedUserReceipt | null>(null);
  const [cloneNotice, setCloneNotice] = useState("");
  // The row drawer, by row id.
  const [inspect, setInspect] = useState<string | null>(null);
  const addButton = useRef<HTMLSpanElement>(null);
  const cloneRequest = useRef<AbortController | null>(null);
  useEffect(() => () => cloneRequest.current?.abort(), [device]);

  const load = useCallback((): Promise<void> => {
    const q = device ? `?device=${encodeURIComponent(device)}` : "";
    return api<AaaList>(`/api/aaa/list/${config.slug}${q}`)
      .then((next) => {
        setData(next);
        setError(null);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [config.slug, device]);

  const requestKey = `${config.slug}\0${device}`;
  const [loadedKey, setLoadedKey] = useState(requestKey);
  if (loadedKey !== requestKey) {
    setLoadedKey(requestKey);
    setData(null);
    setError(null);
    setEditing(null);
    setInspect(null);
  }
  useEffect(() => {
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
          setCloneNotice("");
        }
        if (!r.ok) {
          if (r.created || r.reviewRequired) {
            setEditing(null);
            setForm({});
            await load();
          }
          setError(r.message);
          toast.error(r.message || `${label} failed`);
          return false;
        }
        await load();
        toast.success(
          (path === "add" || path === "update") && config.slug === "um-users" ? r.message : label,
        );
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
    setPasswordVisible(false);
    setError(null);
    setEditing("new");
    setForm({});
    setCloneNotice("");
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
    setPasswordVisible(false);
    setError(null);
    setEditing(r[config.idKey]);
    setForm(fieldsFromRow(r));
    setCloneNotice("");
  };
  const closeForm = (): void => {
    setEditing(null);
    setForm({});
    setCloneNotice("");
  };
  const duplicateUser = async (r: Row): Promise<void> => {
    const controller = new AbortController();
    cloneRequest.current?.abort();
    cloneRequest.current = controller;
    setBusy(true);
    const draft = fieldsFromRow(r);
    const names = new Set((data?.rows ?? []).map((row) => row.name));
    let suffix = 1;
    draft.name = `${r.name}-copy`;
    while (names.has(draft.name)) draft.name = `${r.name}-copy-${++suffix}`;
    let notice = `Settings copied from ${r.name}. Choose a new name and password. Password, OTP and usage history are not copied.`;
    try {
      const assignments = await api<AaaList>(
        `/api/aaa/list/um-user-profiles?device=${encodeURIComponent(device)}`,
        controller.signal,
      );
      if (!assignments.available) throw new Error("Profiles unavailable");
      const profiles = [
        ...new Set(
          assignments.rows
            .filter((row) => row.user === r.name && row.profile)
            .map((row) => row.profile),
        ),
      ];
      if (profiles.length === 1) draft.profile = profiles[0];
      else if (profiles.length > 1)
        notice += " This user has multiple profiles; select one initial profile below.";
    } catch {
      notice += " Profile assignments could not be read; select the initial profile yourself.";
    } finally {
      if (!controller.signal.aborted) {
        setPasswordVisible(false);
        setError(null);
        setForm(draft);
        setCloneNotice(notice);
        setEditing("new");
        setBusy(false);
      }
    }
  };

  const save = async (): Promise<void> => {
    if (showCounters && form.profile && !profileReady) {
      setError("Wait for profiles to load or retry before saving a profile change.");
      return;
    }
    if (showCounters && editing === "new" && (!form.name?.trim() || !form.password)) {
      setError("Enter a name and password for the new user.");
      return;
    }
    const ok =
      editing === "new"
        ? await post("add", { fields: form })
        : await post("update", { id: editing, fields: form });
    if (ok) closeForm();
  };

  const rows = useMemo(() => {
    const all = data?.rows ?? [];
    const q = filter.trim().toLowerCase();
    if (!q) return all;
    return all.filter((r) =>
      config.columns.some((c) => (r[c.key] ?? "").toLowerCase().includes(q)),
    );
  }, [data, filter, config.columns]);
  const shown = showAll ? rows : rows.slice(0, PAGE);

  // ── header ──
  const [singular, plural] = config.noun;
  const total = data?.rows.length ?? 0;
  const enabled = data?.rows.filter((r) => !isDisabled(r)).length ?? 0;
  const connected = (() => {
    if (!showCounters || !counters.data || !data) return null;
    // Rows whose count is unknown say so in the table; the heading sums the rest.
    let sum: number | null = null;
    for (const r of data.rows) {
      const active = counters.rows.get(r.name)?.active;
      if (active != null) sum = (sum ?? 0) + active;
    }
    return sum;
  })();
  const heading = !data ? (
    `Reading ${plural}.`
  ) : !data.available ? (
    <span className="w">User Manager is not installed.</span>
  ) : (
    <>
      {total} {total === 1 ? singular : plural}.
      {showCounters && connected != null && (
        <>
          {" "}
          <span className="s">{connected} connected now.</span>
        </>
      )}
      {config.toggle && !showCounters && total > 0 && (
        <>
          {" "}
          <span className="s">{enabled} enabled.</span>
        </>
      )}
    </>
  );
  const head = (
    <AaaHead
      eyebrow={config.eyebrow}
      heading={heading}
      lead={config.lead}
      tabs={tabs}
      actions={
        <>
          {router}
          <span ref={addButton} className="contents">
            <MonitorButton
              variant="primary"
              icon={<Plus aria-hidden="true" />}
              disabled={busy || (data != null && !data.available)}
              onClick={openAdd}
            >
              {config.add}
            </MonitorButton>
          </span>
        </>
      }
    />
  );

  if (data && !data.available) {
    return (
      <>
        {head}
        <MonitorNote tone="warn">
          <b>User Manager is not installed.</b> This device doesn't have the{" "}
          <code>user-manager</code> package. Install it (System → Packages) and reboot to manage the
          built-in RADIUS server here.
        </MonitorNote>
      </>
    );
  }

  const live: { tone: Tone; text: string; pulse?: boolean } = counters.paused
    ? { tone: "default", text: "Updates paused" }
    : counters.error
      ? { tone: "warn", text: "Counters unavailable" }
      : counters.stale
        ? { tone: "warn", text: "Updates delayed" }
        : counters.data
          ? { tone: "good", text: "Live · 5s refresh", pulse: true }
          : { tone: "default", text: "Reading counters…" };
  const grid = { gridTemplateColumns: config.grid } as CSSProperties;
  /** The same actions the row menu always had, in the same order. */
  const rowActions = (r: Row): RowAction[] => {
    const id = r[config.idKey];
    const off = isDisabled(r);
    if (showCounters)
      return [
        {
          label: "Edit",
          icon: <Pencil aria-hidden="true" />,
          disabled: busy,
          onSelect: () => openEdit(r),
        },
        {
          label: "Duplicate",
          icon: <Copy aria-hidden="true" />,
          disabled: busy,
          onSelect: () => void duplicateUser(r),
        },
        {
          label: off ? "Enable" : "Disable",
          icon: <Power aria-hidden="true" />,
          disabled: busy,
          onSelect: () => void post("toggle", { id, enable: off }),
        },
        {
          label: "Remove",
          icon: <Trash2 aria-hidden="true" />,
          danger: true,
          disabled: busy,
          onSelect: () => void post("remove", { id }),
        },
      ];
    return [
      ...(!config.addOnly
        ? [
            {
              label: "Edit",
              icon: <Pencil aria-hidden="true" />,
              disabled: busy,
              onSelect: () => openEdit(r),
            },
          ]
        : []),
      ...(config.toggle
        ? [
            {
              label: off ? "Enable" : "Disable",
              icon: <Power aria-hidden="true" />,
              disabled: busy,
              onSelect: () => void post("toggle", { id, enable: off }),
            },
          ]
        : []),
      {
        label: "Remove",
        icon: <Trash2 aria-hidden="true" />,
        danger: true,
        disabled: busy,
        onSelect: () => void post("remove", { id }),
      },
    ];
  };
  const drawer = (() => {
    const keyOf = (r: Row) => r[config.idKey] || rowLabel(r, config);
    const at = shown.findIndex((r) => keyOf(r) === inspect);
    const r = at >= 0 ? shown[at]! : null;
    if (!r) return null;
    const off = isDisabled(r);
    const counter = counters.rows.get(r.name);
    const actions = rowActions(r);
    const label = showCounters ? r.name : rowLabel(r, config);
    return (
      <RowDrawer
        open
        onClose={() => setInspect(null)}
        label={`${singular[0]!.toUpperCase()}${singular.slice(1)} details: ${label}`}
        status={
          config.toggle || showCounters
            ? { tone: off ? "off" : "ok", label: off ? "disabled" : "enabled" }
            : undefined
        }
        title={label}
        meta={`${config.panel} · ${device}`}
        rowKey={keyOf(r)}
        nav={{
          index: at,
          total: shown.length,
          onPrev: at > 0 ? () => setInspect(keyOf(shown[at - 1]!)) : undefined,
          onNext: at < shown.length - 1 ? () => setInspect(keyOf(shown[at + 1]!)) : undefined,
        }}
        storageKey={`aaa-${config.slug}`}
        actions={actions
          .filter((a) => a.label !== "Edit")
          .map((a, i) => (
            <MonitorButton
              key={i}
              size="sm"
              variant={a.danger ? "danger" : "ghost"}
              disabled={a.disabled}
              onClick={a.onSelect}
            >
              {a.label}
            </MonitorButton>
          ))}
        primary={
          actions.some((a) => a.label === "Edit") ? (
            <MonitorButton
              size="sm"
              variant="primary"
              icon={<Pencil aria-hidden="true" />}
              disabled={busy}
              onClick={() => openEdit(r)}
            >
              Edit
            </MonitorButton>
          ) : undefined
        }
      >
        <DetailList
          items={config.columns
            .filter((c) => c.key !== "_status")
            .map((c) => ({
              label: c.label,
              value:
                config.slug === "um-limitations" &&
                (c.key === "rate-limit-rx" || c.key === "rate-limit-tx")
                  ? limitationRate(r[c.key])
                  : r[c.key] || "—",
            }))}
        />
        {showCounters && (
          <DetailBlock label="Usage" aside="User Manager totals">
            <DetailList
              items={[
                {
                  label: "Active connections",
                  value: counter?.active == null ? "Connection count unknown" : counter.active,
                },
                {
                  label: "Total connected",
                  value: counter?.seconds == null ? "—" : connectionTime(counter.seconds),
                  mono: true,
                },
                {
                  label: "Last connection",
                  value: counter?.lastConnection
                    ? lastConnection(counter.lastConnection).join(" ")
                    : "Unknown",
                  mono: true,
                },
                {
                  label: "↓ Download",
                  value: counter?.download == null ? "—" : compactBytes(counter.download),
                  mono: true,
                },
                {
                  label: "↑ Upload",
                  value: counter?.upload == null ? "—" : compactBytes(counter.upload),
                  mono: true,
                },
              ]}
            />
          </DetailBlock>
        )}
      </RowDrawer>
    );
  })();
  const creating = editing === "new";
  const fields = config.fields.filter((fd) => fd.key !== "comment");
  const comment = config.fields.find((fd) => fd.key === "comment");

  return (
    <>
      {head}
      {showCounters && (
        <section className="aaa-live glass" aria-label="Counter status">
          <span role="status">
            <StatusBadge tone={live.tone} pulse={live.pulse}>
              {live.text}
            </StatusBadge>
          </span>
          {counters.data && (
            <span className="text-muted-foreground">
              Last read <span className="aaa-mono-em">{clock(counters.data.collectedAt)}</span>
              {counters.stale ? " · showing last known values" : ""}
            </span>
          )}
          <span className="flex-1" />
          <span className="monitor-hint aaa-live-note">
            Cumulative User Manager totals, not the current connection only. Last connection uses
            router local time and refreshes every 30 s.
          </span>
          {counters.data?.lastConnections?.status === "unavailable" && (
            <span className="monitor-hint aaa-live-line text-warning">
              Last connection dates are unavailable. Other counters are unaffected.
            </span>
          )}
          {counters.data?.lastConnections?.status === "stale" && (
            <span className="monitor-hint aaa-live-line">
              Last connection dates are cached while the next read completes.
            </span>
          )}
          {counters.error && (
            <span role="alert" className="monitor-hint aaa-live-line text-warning">
              {counters.error}
            </span>
          )}
        </section>
      )}

      {error && !editing && (
        <MonitorNote tone="bad" role="alert">
          {error}
        </MonitorNote>
      )}

      <MonitorPanel
        flush
        title={config.panel}
        description={config.panelDescription}
        extra={
          <>
            <MonitorSearch
              className="aaa-filter"
              label={`Filter ${plural}`}
              placeholder="Filter"
              value={filter}
              onChange={setFilter}
            />
            <MonitorButton
              icon={<RefreshCw aria-hidden="true" />}
              onClick={() => {
                void load();
                counters.refresh();
              }}
            >
              Refresh
            </MonitorButton>
          </>
        }
      >
        {!data ? (
          !error && (
            <div className="aaa-loading">
              <LoadingState label="Loading RADIUS records" />
            </div>
          )
        ) : rows.length === 0 ? (
          <MonitorEmpty compact title={filter ? "No rows match the filter." : config.empty} />
        ) : (
          <>
            <div className="aaa-scroll">
              <table className="aaa-table">
                <thead>
                  <tr className="monitor-thead" style={grid}>
                    {config.columns.map((c) => (
                      <th key={c.key}>{c.label}</th>
                    ))}
                    {showCounters && (
                      <>
                        <th>Total connected</th>
                        <th title="Start of the latest retained accounting session · router local time">
                          Last connection
                        </th>
                        <th>↓ Download</th>
                        <th>↑ Upload</th>
                        <th>Status</th>
                      </>
                    )}
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => {
                    const id = r[config.idKey];
                    const off = isDisabled(r);
                    const counter = counters.rows.get(r.name);
                    const cells = (
                      <>
                        {config.columns.map((c) => (
                          <td
                            key={c.key}
                            data-col={c.key}
                            title={c.key === "_status" ? undefined : (r[c.key] ?? "")}
                            className={
                              c.key === config.columns[0].key ? "aaa-cell-main" : undefined
                            }
                          >
                            {c.key === "_status" ? (
                              <StatusBadge tone={off ? "default" : "good"} dot={false}>
                                {off ? "disabled" : "enabled"}
                              </StatusBadge>
                            ) : showCounters && c.key === "name" ? (
                              <span className="aaa-two">
                                <span className="p">{r.name}</span>
                                <span className="aaa-sub">
                                  {counter?.active == null
                                    ? "Connection count unknown"
                                    : `${counter.active} active connection${counter.active === 1 ? "" : "s"}`}
                                </span>
                              </span>
                            ) : config.slug === "um-limitations" &&
                              (c.key === "rate-limit-rx" || c.key === "rate-limit-tx") ? (
                              <span className="aaa-mono">{limitationRate(r[c.key])}</span>
                            ) : c.key === config.columns[0].key ? (
                              <span className="p">{r[c.key] ?? ""}</span>
                            ) : (
                              (r[c.key] ?? "")
                            )}
                          </td>
                        ))}
                        {showCounters && (
                          <>
                            <td title="Cumulative accounted connection time across this user's sessions">
                              <span className="aaa-mono">
                                {counter?.seconds == null ? "—" : connectionTime(counter.seconds)}
                              </span>
                            </td>
                            <td title="Latest retained session start · router local time (not browser time)">
                              {counter?.lastConnection ? (
                                <span className="aaa-two">
                                  <span className="aaa-mono-em">
                                    {lastConnection(counter.lastConnection)[0]}
                                  </span>
                                  <span className="aaa-mono aaa-sub">
                                    {lastConnection(counter.lastConnection)[1]}
                                  </span>
                                </span>
                              ) : (
                                <span className="aaa-sub">
                                  {counters.data?.lastConnections?.status === "pending"
                                    ? "Loading…"
                                    : "Unknown"}
                                </span>
                              )}
                            </td>
                            <td title="Total bytes downloaded by this user">
                              <span className="aaa-mono aaa-down">
                                {counter?.download == null ? "—" : compactBytes(counter.download)}
                              </span>
                            </td>
                            <td title="Total bytes uploaded by this user">
                              <span className="aaa-mono aaa-up">
                                {counter?.upload == null ? "—" : compactBytes(counter.upload)}
                              </span>
                            </td>
                            <td>
                              <StatusBadge tone={off ? "default" : "good"} dot={false}>
                                {off ? "disabled" : "enabled"}
                              </StatusBadge>
                            </td>
                          </>
                        )}
                      </>
                    );
                    const actions = rowActions(r);
                    const label = rowLabel(r, config);
                    return (
                      <RowMenu
                        key={showCounters ? `${device}:${id}` : id || label}
                        title={showCounters ? r.name : label}
                        sub={
                          off ? "disabled" : config.toggle || showCounters ? "enabled" : undefined
                        }
                        onOpen={() => setInspect(id || label)}
                        cells={Object.fromEntries(
                          config.columns
                            .filter((c) => c.key !== "_status")
                            .map((c) => [
                              c.key,
                              {
                                value: r[c.key] ?? "",
                                search: r[c.key] ? () => setFilter(r[c.key]!) : undefined,
                              },
                            ]),
                        )}
                        copies={[{ label: "Name", value: label }]}
                        row={r}
                        actions={actions}
                      >
                        <tr
                          className={cn("monitor-row", off && "aaa-off")}
                          style={grid}
                          tabIndex={0}
                          data-selected={inspect === (id || label) || undefined}
                          onClick={() => setInspect(id || label)}
                          onKeyDown={(e) => {
                            if (e.target !== e.currentTarget) return;
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setInspect(id || label);
                            }
                          }}
                        >
                          {cells}
                          <td className="aaa-cell-action">
                            <RowMore />
                          </td>
                        </tr>
                      </RowMenu>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="monitor-foot">
              <span>
                {rows.length} {rows.length === 1 ? "row" : "rows"} · right-click a row for the same
                menu
              </span>
              <span className="flex-1" />
              {rows.length > PAGE && (
                <MonitorButton
                  variant="ghost"
                  size="sm"
                  icon={
                    showAll ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />
                  }
                  onClick={() => setShowAll((v) => !v)}
                >
                  {showAll ? "Show fewer" : "Show all"}
                </MonitorButton>
              )}
            </div>
          </>
        )}
      </MonitorPanel>

      {drawer}

      <MonitorDialog
        open={editing != null}
        onOpenChange={(open) => {
          if (!open) closeForm();
        }}
        dismissible={false}
        closeDisabled={busy}
        width={640}
        title={
          creating
            ? showCounters
              ? "New User Manager user"
              : `New ${singular}`
            : `Edit ${editing}`
        }
        description={
          showCounters
            ? creating
              ? `Created on ${device}. You see the password once, right after it is saved.`
              : `Saved on ${device}. Leave the password empty to keep it.`
            : creating
              ? `Created on ${device}.`
              : `Saved on ${device}. Secrets left empty stay unchanged.`
        }
        footer={
          <>
            {creating && (
              <span className="monitor-hint">
                {showCounters ? "Name and password are required." : "Fields marked * are required."}
              </span>
            )}
            <span className="flex-1" />
            <MonitorButton variant="ghost" disabled={busy} onClick={closeForm}>
              Cancel
            </MonitorButton>
            <MonitorButton
              variant="primary"
              icon={<Check aria-hidden="true" />}
              aria-busy={busy}
              disabled={busy || (showCounters && !!form.profile && !profileReady)}
              onClick={() => void save()}
            >
              {creating ? (showCounters ? "Create user" : `Create ${singular}`) : "Save changes"}
            </MonitorButton>
          </>
        }
      >
        <div className="monitor-dialog-body aaa-form">
          {error && (
            <MonitorNote tone="bad" role="alert">
              {error}
            </MonitorNote>
          )}
          {cloneNotice && (
            <MonitorNote>
              <b>Duplicate user.</b> {cloneNotice}
            </MonitorNote>
          )}
          {showCounters && editing && (
            <UserProfileField
              key={`${device}:${editing}`}
              device={device}
              user={creating ? undefined : editing}
              value={form.profile ?? ""}
              onChange={(profile) => setForm((current) => ({ ...current, profile }))}
              onReadyChange={setProfileReady}
              disabled={busy}
            />
          )}
          <div className="aaa-grid">
            {fields.map((fd) =>
              showCounters && fd.key === "password" ? (
                <KitField
                  key={fd.key}
                  className="monitor-fl"
                  id={passwordId}
                  label={`Password${creating ? " *" : ""}`}
                >
                  <TextInput
                    wrapClassName="aaa-password"
                    type={passwordVisible ? "text" : "password"}
                    autoComplete="new-password"
                    disabled={busy}
                    placeholder={creating ? "Enter or generate a password" : "(unchanged)"}
                    value={form.password ?? ""}
                    onChange={(password) => setForm((current) => ({ ...current, password }))}
                    end={
                      <>
                        <button
                          type="button"
                          className="aaa-ib"
                          disabled={busy}
                          aria-label={passwordVisible ? "Hide password" : "Show password"}
                          aria-pressed={passwordVisible}
                          title={passwordVisible ? "Hide password" : "Show password"}
                          onClick={() => setPasswordVisible((visible) => !visible)}
                        >
                          {passwordVisible ? (
                            <Eye aria-hidden="true" />
                          ) : (
                            <EyeOff aria-hidden="true" />
                          )}
                        </button>
                        <button
                          type="button"
                          className="aaa-ib"
                          disabled={busy}
                          aria-label="Generate 8-character password"
                          title="Generate 8 characters: uppercase, lowercase, number and symbol"
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
                          <RefreshCw aria-hidden="true" />
                        </button>
                      </>
                    }
                  />
                </KitField>
              ) : (
                <FormField
                  key={fd.key}
                  field={fd}
                  creating={creating}
                  disabled={busy}
                  value={form[fd.key] ?? ""}
                  onChange={(v) => setForm((current) => ({ ...current, [fd.key]: v }))}
                />
              ),
            )}
          </div>
          {comment && (
            <FormField
              field={comment}
              creating={creating}
              disabled={busy}
              value={form.comment ?? ""}
              onChange={(v) => setForm((current) => ({ ...current, comment: v }))}
            />
          )}
        </div>
      </MonitorDialog>
      {createdUser && (
        <UserCreatedDialog
          user={createdUser}
          onClose={() => setCreatedUser(null)}
          onCloseAutoFocus={() => addButton.current?.querySelector("button")?.focus()}
        />
      )}
    </>
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

  const load = useCallback((): Promise<void> => {
    const q = device ? `?device=${encodeURIComponent(device)}` : "";

    return api<unknown>(`${getPath}${q}`)
      .then((payload) => {
        const { available: av, row: r } = unwrap(payload);
        setAvailable(av);
        setRow(r);
        setForm({});
        setLoadError("");
      })
      .catch((error) => {
        setLoadError(error instanceof Error ? error.message : "Settings could not be read.");
        setRow(null);
      });
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
      <MonitorNote tone="warn">
        <b>{title}</b> is not available on this device.
      </MonitorNote>
    );
  }
  if (loadError)
    return (
      <MonitorPanel title={title} description={loadError} tone="bad">
        <MonitorButton size="sm" onClick={() => void load()}>
          Retry
        </MonitorButton>
      </MonitorPanel>
    );
  return (
    <MonitorPanel
      title={title}
      description={
        row
          ? fields.map((f) => `${f.label}: ${row[f.key] ?? "—"}`).join(" · ")
          : "Reading settings."
      }
    >
      {!row ? (
        <LoadingState label={`Loading ${title}`} layout="form" />
      ) : (
        <>
          <div className="aaa-settings-grid">
            {fields.map((f) =>
              f.type === "bool" ? (
                <div key={f.key} className="monitor-fl">
                  <span className="monitor-label">{f.label}</span>
                  <AaaSelect
                    label={f.label}
                    value={form[f.key] ?? ""}
                    onChange={(v) => setForm({ ...form, [f.key]: v })}
                    options={[
                      { value: "", label: "(unchanged)" },
                      { value: "no", label: "no" },
                      { value: "yes", label: "yes" },
                    ]}
                  />
                </div>
              ) : (
                <FormField
                  key={f.key}
                  field={{ ...f, placeholder: f.placeholder ?? row[f.key] ?? "" }}
                  creating={false}
                  disabled={busy}
                  value={form[f.key] ?? ""}
                  onChange={(v) => setForm({ ...form, [f.key]: v })}
                />
              ),
            )}
          </div>
          <div className="aaa-settings-actions">
            <MonitorButton
              variant="primary"
              size="sm"
              aria-busy={busy}
              disabled={busy}
              onClick={() => void save()}
            >
              Save
            </MonitorButton>
            {extra}
            {msg && <span className="monitor-hint">{msg}</span>}
          </div>
        </>
      )}
    </MonitorPanel>
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
  grid: "minmax(0,1.2fr) minmax(0,1.4fr) 80px 80px 80px 90px 36px",
  empty: "No RADIUS servers configured.",
  noun: ["RADIUS server", "RADIUS servers"],
  eyebrow: "RADIUS servers",
  lead: "The servers this router asks to sign users in. Add, edit, disable or remove them here.",
  add: "Add server",
  panel: "RADIUS servers",
  panelDescription: "Address, services and ports per server.",
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
    { key: "disabled", label: "Disabled", type: "bool" },
    { key: "comment", label: "Comment" },
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
  ],
  grid: "minmax(0,1.3fr) 90px 60px 140px 110px 100px 90px 90px 36px",
  empty: "No RADIUS users.",
  noun: ["user", "users"],
  eyebrow: "users",
  lead: "Each account's lifetime totals, read live from User Manager. Create, duplicate, disable or remove users here.",
  add: "Add user",
  panel: "Users",
  panelDescription: "Name, group and counters per account.",
  fields: [
    { key: "name", label: "Name", required: true },
    { key: "password", label: "Password", type: "password", required: true },
    { key: "group", label: "Group", placeholder: "default" },
    { key: "shared-users", label: "Shared users", type: "number", placeholder: "1" },
    { key: "caller-id", label: "Caller ID (MAC)", placeholder: "AA:BB:CC:DD:EE:FF" },
    {
      key: "otp-secret",
      label: "OTP secret",
      type: "password",
      placeholder: "Leave empty for none",
      editPlaceholder: "(unchanged)",
    },
    { key: "attributes", label: "RADIUS attributes", placeholder: "Mikrotik-Rate-Limit:20M/5M" },
    { key: "disabled", label: "Disabled", type: "bool" },
    { key: "comment", label: "Comment", placeholder: "Who this account is for" },
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
  grid: "minmax(0,1.2fr) minmax(0,1.2fr) 110px 90px 110px 36px",
  empty: "No service profiles.",
  noun: ["profile", "profiles"],
  eyebrow: "profiles",
  lead: "Service plans you assign to users: how long each lasts and when it starts.",
  add: "Add profile",
  panel: "Profiles",
  panelDescription: "Validity, price and start rule per profile.",
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
    { key: "rate-limit-rx", label: "Rate ↓ (MB/s)" },
    { key: "rate-limit-tx", label: "Rate ↑ (MB/s)" },
    { key: "transfer-limit", label: "Transfer" },
    { key: "uptime-limit", label: "Uptime" },
  ],
  grid: "minmax(0,1.3fr) 140px 140px 120px 110px 36px",
  empty: "No limitation templates.",
  noun: ["limitation", "limitations"],
  eyebrow: "limitations",
  lead: "Rate, transfer and uptime limits that profiles apply to users.",
  add: "Add limitation",
  panel: "Limitations",
  panelDescription: "Rates and caps per limitation.",
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
  grid: "minmax(0,1fr) minmax(0,1fr) 90px 80px minmax(0,1.2fr) 90px 36px",
  empty: "No NAS clients registered.",
  noun: ["NAS client", "NAS clients"],
  eyebrow: "NAS clients",
  lead: "Routers allowed to ask User Manager to sign users in.",
  add: "Add NAS client",
  panel: "NAS clients",
  panelDescription: "Address, CoA port and protocol per client.",
  fields: [
    { key: "name", label: "Name", required: true },
    { key: "address", label: "Address", required: true, placeholder: "192.168.88.1" },
    { key: "shared-secret", label: "Shared secret", type: "password", required: true },
    { key: "coa-port", label: "CoA port", type: "number" },
    { key: "protocol", label: "Protocol", placeholder: "radius" },
    { key: "disabled", label: "Disabled", type: "bool" },
    { key: "comment", label: "Comment" },
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
  grid: "minmax(0,1fr) minmax(0,1fr) 160px 180px 36px",
  empty: "No profile assignments.",
  noun: ["assignment", "assignments"],
  eyebrow: "assignments",
  lead: "Which profile each user has, and its state. Add or remove assignments here.",
  add: "Add assignment",
  panel: "Assignments",
  panelDescription: "User, profile, state and end time per assignment.",
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
const TABS: { value: TabId; label: string }[] = [
  { value: "reports", label: "Reports & insights" },
  { value: "radius", label: "RADIUS servers" },
  { value: "users", label: "Users" },
  { value: "profiles", label: "Profiles" },
  { value: "limitations", label: "Limitations" },
  { value: "nas", label: "NAS clients" },
  { value: "assignments", label: "Assignments" },
  { value: "settings", label: "Settings" },
];
const ENTITY: Partial<Record<TabId, EntityConfig>> = {
  radius: RADIUS_CONFIG,
  users: UM_USERS_CONFIG,
  profiles: UM_PROFILES_CONFIG,
  limitations: UM_LIMITATIONS_CONFIG,
  nas: UM_ROUTERS_CONFIG,
  assignments: UM_ASSIGN_CONFIG,
};

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
  const id = useId();

  const load = useCallback((): Promise<void> => {
    return api<{ intervalMs: number }>("/api/usage/sampler")
      .then((r) => {
        setCurrent(r.intervalMs);
      })
      .catch(() => {
        setCurrent(null);
      });
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
    <MonitorPanel
      title="Usage sampling"
      description={`How often client traffic and User Manager sessions are written to the usage history. Now: ${current == null ? "…" : fmtInterval(current)} · default 1 min · 30 s to 6 h.`}
    >
      <div className="aaa-settings-grid">
        <KitField label="Interval (minutes)" className="monitor-fl" id={id}>
          <NumberInput
            allowEmpty
            step={0.5}
            min={0.5}
            placeholder={current ? String(current / 60_000) : "1"}
            value={minutes === "" || !Number.isFinite(Number(minutes)) ? null : Number(minutes)}
            onChange={(n) => setMinutes(n == null ? "" : String(n))}
          />
        </KitField>
      </div>
      <div className="aaa-settings-actions">
        <MonitorButton
          variant="primary"
          size="sm"
          aria-busy={busy}
          disabled={busy}
          onClick={() => void save()}
        >
          Save
        </MonitorButton>
        {[1, 5, 10, 30].map((m) => (
          <MonitorButton
            key={m}
            variant="ghost"
            size="sm"
            onClick={() => {
              setMinutes(String(m));
            }}
          >
            {m}m
          </MonitorButton>
        ))}
        {msg && <span className="monitor-hint">{msg}</span>}
      </div>
    </MonitorPanel>
  );
}

/** Human label for a sampling interval in ms (`45s`, `1 min`, `2.5 min`). */
function fmtInterval(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = ms / 60_000;
  return `${Number.isInteger(m) ? m : m.toFixed(1)} min`;
}

// Stable unwrap functions: SingletonForm reloads whenever `unwrap` changes.
const unwrapIncoming = (p: unknown): { available: boolean; row: Row } => ({
  available: true,
  row: (p as Row) ?? {},
});
const unwrapUmSettings = (p: unknown): { available: boolean; row: Row } => {
  const o = (p as { available?: boolean; settings?: Row }) ?? {};
  return { available: o.available !== false, row: o.settings ?? {} };
};

function SettingsTab({
  device,
  tabs,
  router,
}: {
  device: string;
  tabs: ReactNode;
  router: ReactNode;
}): ReactNode {
  return (
    <>
      <AaaHead
        eyebrow="settings"
        heading="Server settings."
        lead="The RADIUS CoA listener, User Manager's own settings, and how often the dashboard samples usage."
        actions={router}
        tabs={tabs}
      />
      <div className="aaa-settings">
        <SingletonForm
          device={device}
          getPath="/api/aaa/radius-incoming"
          setPath="/api/aaa/radius-incoming"
          title="RADIUS incoming (CoA listener)"
          fields={RADIUS_INCOMING_FIELDS}
          unwrap={unwrapIncoming}
          extra={
            <MonitorButton
              variant="ghost"
              size="sm"
              onClick={() =>
                void postJson("/api/aaa/radius-reset-counters", { device })
                  .then(() => toast.success("Counters reset"))
                  .catch(() => toast.error("Reset counters failed"))
              }
            >
              Reset RADIUS counters
            </MonitorButton>
          }
        />
        <SingletonForm
          device={device}
          getPath="/api/aaa/um-settings"
          setPath="/api/aaa/um-settings"
          title="User Manager (built-in RADIUS server)"
          fields={UM_SETTINGS_FIELDS}
          unwrap={unwrapUmSettings}
        />
        <SamplerSettings />
      </div>
    </>
  );
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
  const router =
    routerOptions.length > 0 ? (
      <RouterPicker
        value={device}
        onChange={setDevice}
        routers={routerOptions.map((d) => d.name)}
        defaultRouter={routers?.defaultDevice}
      />
    ) : null;
  const tabs = (
    <MonitorTabs label="RADIUS & User Manager sections" value={tab} onChange={setTab} tabs={TABS} />
  );
  const config = ENTITY[tab];

  return (
    <section className="aaa-page">
      {tab === "reports" ? (
        <UmReports key={device} device={device} tabs={tabs} router={router} />
      ) : tab === "settings" ? (
        <SettingsTab key={device} device={device} tabs={tabs} router={router} />
      ) : config ? (
        <EntityManager
          key={`${tab}:${device}`}
          config={config}
          device={device}
          tabs={tabs}
          router={router}
        />
      ) : null}
    </section>
  );
}
