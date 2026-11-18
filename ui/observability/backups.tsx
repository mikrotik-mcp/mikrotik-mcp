/**
 * Backups (the Rec-Backups board): the host-side vault of `.rsc` exports.
 * Create, upload, view, download, rename, delete, and restore through Safe
 * Mode. Restore opens a dialog (Rec-Backups-Restore) with a dry-run first.
 * Under 640px the vault turns into cards (Rec-Backups-Phone).
 */
import "./backups.css";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Check,
  ChevronDown,
  Download,
  Ellipsis,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import { api, postJson, withToken } from "./api";
import { LoadingState } from "./loading-state";
import {
  Metric,
  MetricStrip,
  MonitorButton,
  MonitorDialog,
  MonitorEmpty,
  MonitorNote,
  MonitorPanel,
  PageIntro,
  StatusDot,
} from "./monitoring-ui";
import type { Tone } from "./monitoring-ui";
import { toast } from "./toast-action";

interface BackupItem {
  name: string;
  bytes: number;
  modified: number;
  device?: string;
}

interface BackupsData {
  dir: string;
  devices: string[];
  backups: BackupItem[];
}

type Opts = { show_sensitive: boolean; verbose: boolean; compact: boolean; terse: boolean };

const DAY = 86_400_000;

function size(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "2026-11-17 11:58". */
function stamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function ago(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / DAY)}d ago`;
}

function daysAgo(ms: number): string {
  const days = Math.floor((Date.now() - ms) / DAY);
  if (days < 1) return "today";
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/** How fresh a router's last backup is: a day is fine, four days is stale. */
function ageTone(ms: number | undefined): Tone {
  if (ms === undefined) return "bad";
  const age = Date.now() - ms;
  if (age < DAY) return "good";
  if (age < 4 * DAY) return "warn";
  return "bad";
}

/** "core-router-01-pre-upgrade-20261117-1158.rsc" → "pre-upgrade". */
function labelOf(b: BackupItem): string {
  let n = b.name.replace(/\.rsc$/, "");
  if (b.device && n.startsWith(`${b.device}-`)) n = n.slice(b.device.length + 1);
  n = n.replace(/-?\d{8}-\d{4,6}$/, "");
  return n || b.name;
}

const OPTIONS: [keyof Opts, string, string][] = [
  ["show_sensitive", "show-sensitive", "Include secrets (keys, passwords)"],
  ["verbose", "verbose", "Include every parameter, even defaults"],
  ["compact", "compact", "Only non-default values (ignored with verbose)"],
  ["terse", "terse", "One machine-readable line per item"],
];

function IconSelect({
  value,
  onChange,
  options,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  label: string;
}): ReactNode {
  return (
    <span className="monitor-select bk-select">
      <Server aria-hidden="true" className="bk-icon" />
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown aria-hidden="true" />
    </span>
  );
}

function RestoreDialog({
  backup,
  devices,
  onClose,
}: {
  backup: BackupItem;
  devices: string[];
  onClose: () => void;
}): ReactNode {
  const [target, setTarget] = useState(backup.device ?? devices[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; applied?: number; message?: string } | null>(
    null,
  );

  const restore = async (confirm: boolean): Promise<void> => {
    setBusy(true);
    const r = await postJson<{
      ok?: boolean;
      committed?: boolean;
      applied?: number;
      message?: string;
    }>("/api/backups/restore", { name: backup.name, device: target || undefined, confirm }).catch(
      (): { ok?: boolean; committed?: boolean; applied?: number; message?: string } => ({
        ok: false,
        message: "request failed",
      }),
    );
    setBusy(false);
    setResult({ ok: !!r.ok, applied: r.applied, message: r.message });
    if (r.ok) toast.success(r.committed ? "Backup restored" : "Dry-run restore OK");
    else toast.error(`Restore failed: ${r.message}`);
    if (r.ok && confirm) onClose();
  };

  return (
    <MonitorDialog
      open
      onOpenChange={(open) => !open && !busy && onClose()}
      width={600}
      title="Restore a backup"
      description="Runs through Safe Mode. If the router locks you out, it reverts by itself."
      dismissible={false}
      closeDisabled={busy}
      footer={
        <>
          <MonitorButton variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </MonitorButton>
          <span className="flex-1" />
          <MonitorButton
            variant="ghost"
            icon={<Play aria-hidden="true" />}
            disabled={busy || !target}
            onClick={() => void restore(false)}
          >
            {result?.ok ? "Dry-run again" : "Dry-run"}
          </MonitorButton>
          <MonitorButton
            variant="danger"
            icon={<Upload aria-hidden="true" />}
            disabled={busy || !target}
            onClick={() => void restore(true)}
          >
            Restore (commit)
          </MonitorButton>
        </>
      }
    >
      <div className="bk-dialog flex flex-col gap-4">
        <dl className="monitor-facts">
          <dt>Backup</dt>
          <dd className="mono">{backup.name}</dd>
          <dt>Captured</dt>
          <dd>
            {stamp(backup.modified)} · {size(backup.bytes)}
          </dd>
          <dt>From</dt>
          <dd>
            {backup.device ? (
              <span className="flex items-center gap-2.5">
                <StatusDot tone={ageTone(backup.modified)} />
                <span className="mono">{backup.device}</span>
              </span>
            ) : (
              "uploaded file"
            )}
          </dd>
        </dl>
        <div className="monitor-fl">
          <span className="monitor-label">Restore onto</span>
          <IconSelect
            value={target}
            onChange={setTarget}
            label="Restore target device"
            options={devices.map((d) => ({ value: d, label: d }))}
          />
          <span className="monitor-hint">
            Pick the same router unless you are moving a config on purpose.
          </span>
        </div>
        {result &&
          (result.ok ? (
            <MonitorNote tone="good" icon={<Check aria-hidden="true" />}>
              <b>Dry-run OK.</b> {result.applied ?? 0} commands applied, then rolled back. Nothing
              changed. Restore (commit) applies it for real.
            </MonitorNote>
          ) : (
            <MonitorNote tone="bad" icon={<TriangleAlert aria-hidden="true" />} role="alert">
              <b>Restore failed.</b> {result.message}
            </MonitorNote>
          ))}
        <MonitorNote tone="warn" icon={<TriangleAlert aria-hidden="true" />}>
          Restoring replaces the matching config on the router. Take a fresh backup first if you may
          want today’s state back.
        </MonitorNote>
      </div>
    </MonitorDialog>
  );
}

/** Manage the host-side backup vault: create, download, upload, rename, restore, delete. */
export function BackupsView(): ReactNode {
  const [data, setData] = useState<BackupsData | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [restoreName, setRestoreName] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ name: string; value: string } | null>(null);
  const [more, setMore] = useState<string | null>(null);
  const [device, setDevice] = useState("");
  const [body, setBody] = useState<{ name: string; content: string } | null>(null);
  const [dirEdit, setDirEdit] = useState<string | null>(null);
  // /export options (mirror RouterOS flags) applied to "Create backup".
  const [label, setLabel] = useState("");
  const [opts, setOpts] = useState<Opts>({
    show_sensitive: false,
    verbose: false,
    compact: false,
    terse: false,
  });
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(() => {
    void api<BackupsData>("/api/backups")
      .then((d) => {
        setData(d);
        setDevice((cur) => cur || d.devices[0] || "");
      })
      .catch(() => setData({ dir: "", devices: [], backups: [] }));
  }, []);

  useEffect(() => load(), [load]);

  type R = { ok?: boolean; error?: string; name?: string };
  const post = (path: string, b: unknown): Promise<R> =>
    postJson<R>(path, b).catch((): R => ({ error: "request failed" }));

  const create = async (): Promise<void> => {
    setBusy(true);
    const r = await postJson<{ ok?: boolean; name?: string; bytes?: number; error?: string }>(
      "/api/backups/create",
      {
        device: device || undefined,
        label: label.trim() || undefined,
        show_sensitive: opts.show_sensitive,
        // `compact` is meaningless when `verbose` is on: don't send both.
        verbose: opts.verbose,
        compact: opts.verbose ? false : opts.compact,
        terse: opts.terse,
      },
    ).catch((): { ok?: boolean; name?: string; bytes?: number; error?: string } => ({
      error: "request failed",
    }));
    setBusy(false);
    if (r.ok) {
      toast.success("Backup created");
      load();
    } else toast.error(`Create failed: ${r.error}`);
  };

  const toggle = (k: keyof Opts): void => setOpts((o) => ({ ...o, [k]: !o[k] }));

  const upload = async (file: File): Promise<void> => {
    const content = await file.text();
    const r = await post("/api/backups/upload", { name: file.name, content });
    if (r.ok) {
      toast.success("Backup uploaded");
      load();
    } else toast.error(`Upload failed: ${r.error}`);
  };

  const del = async (name: string): Promise<void> => {
    setConfirmDel(null);
    const r = await post("/api/backups/delete", { name });
    if (r.ok) {
      toast.success("Backup deleted");
      load();
    } else toast.error(`Delete failed: ${r.error}`);
  };

  const rename = async (): Promise<void> => {
    if (!renaming) return;
    const { name, value } = renaming;
    setRenaming(null);
    if (!value || value === name) return;
    const r = await post("/api/backups/rename", { name, new_name: value });
    if (r.ok) {
      toast.success("Backup renamed");
      load();
    } else toast.error(`Rename failed: ${r.error}`);
  };

  const viewBody = (name: string): void => {
    void api<{ name: string; content: string }>(`/api/backups/get?name=${encodeURIComponent(name)}`)
      .then(setBody)
      .catch(() => {});
  };

  const saveDir = async (): Promise<void> => {
    if (dirEdit === null) return;
    const dir = dirEdit.trim();
    if (!dir || dir === data?.dir) {
      setDirEdit(null);
      return;
    }
    setBusy(true);
    type DirResp = {
      ok?: boolean;
      dir?: string;
      persisted?: boolean;
      warning?: string;
      error?: string;
    };
    const r = await postJson<DirResp>("/api/backups/dir", { dir }).catch((): DirResp => ({
      error: "request failed",
    }));
    setBusy(false);
    setDirEdit(null);
    if (r.ok) {
      // A path that could not be saved to the config still applies until restart.
      toast.success(
        r.persisted ? "Backup directory updated" : (r.warning ?? "Backup directory updated"),
      );
    } else {
      toast.error(`Path change failed: ${r.error}`);
    }
    if (r.ok) load();
  };

  if (!data) return <LoadingState label="Loading backups" />;

  const backups = [...data.backups].sort((a, b) => b.modified - a.modified);
  const newest = backups[0];
  const total = backups.reduce((n, b) => n + b.bytes, 0);
  const uploaded = backups.filter((b) => !b.device).length;
  const lastBy = new Map<string, number>();
  const countBy = new Map<string, number>();
  for (const b of backups) {
    if (!b.device) continue;
    if (!lastBy.has(b.device)) lastBy.set(b.device, b.modified);
    countBy.set(b.device, (countBy.get(b.device) ?? 0) + 1);
  }
  const routers = [...new Set([...data.devices, ...lastBy.keys()])];
  const covered = routers.filter((d) => lastBy.has(d)).length;
  const maxCount = Math.max(1, ...countBy.values());
  // The router whose newest backup is oldest: the one to worry about.
  const stalest = [...routers].sort((a, b) => (lastBy.get(a) ?? 0) - (lastBy.get(b) ?? 0))[0];
  const stalestAt = stalest ? lastBy.get(stalest) : undefined;
  const stale = stalest !== undefined && ageTone(stalestAt) !== "good";
  const [totalNum, totalUnit] = size(total).split(" ");
  const restoring = backups.find((b) => b.name === restoreName);
  const n = backups.length;
  const count = `${n} backup${n === 1 ? "" : "s"}.`;

  const lastText =
    stalestAt === undefined ? "has never been saved" : `last saved ${daysAgo(stalestAt)}`;

  const deviceOptions =
    data.devices.length === 0
      ? [{ value: "", label: "no devices" }]
      : data.devices.map((d) => ({ value: d, label: d }));

  const rowActions = (b: BackupItem): ReactNode =>
    confirmDel === b.name ? (
      <>
        <span className="bk-ask">Delete?</span>
        <MonitorButton
          variant="danger"
          size="sm"
          icon={<Check aria-hidden="true" />}
          onClick={() => void del(b.name)}
        >
          Delete
        </MonitorButton>
        <MonitorButton
          variant="ghost"
          size="sm"
          icon={<X aria-hidden="true" />}
          onClick={() => setConfirmDel(null)}
        >
          Keep
        </MonitorButton>
      </>
    ) : renaming?.name === b.name ? (
      <>
        <input
          className="monitor-input"
          aria-label="New name"
          value={renaming.value}
          autoFocus
          onChange={(e) => setRenaming({ name: b.name, value: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") void rename();
            if (e.key === "Escape") setRenaming(null);
          }}
        />
        <button
          type="button"
          className="monitor-icon-btn"
          aria-label="Save name"
          onClick={() => void rename()}
        >
          <Check aria-hidden="true" />
        </button>
        <button
          type="button"
          className="monitor-icon-btn"
          aria-label="Cancel rename"
          onClick={() => setRenaming(null)}
        >
          <X aria-hidden="true" />
        </button>
      </>
    ) : (
      <>
        <MonitorButton variant="ghost" size="sm" onClick={() => viewBody(b.name)}>
          View
        </MonitorButton>
        <a
          className="monitor-icon-btn"
          href={withToken(`/api/backups/raw?name=${encodeURIComponent(b.name)}`)}
          download={b.name}
          aria-label="Download"
          title="Download"
        >
          <Download aria-hidden="true" />
        </a>
        <MonitorButton
          variant="ghost"
          size="sm"
          onClick={() => setRenaming({ name: b.name, value: b.name })}
        >
          Rename
        </MonitorButton>
        <MonitorButton
          size="sm"
          icon={<Upload aria-hidden="true" />}
          onClick={() => setRestoreName(b.name)}
        >
          Restore
        </MonitorButton>
        <button
          type="button"
          className="monitor-icon-btn"
          aria-label="Delete"
          title="Delete"
          onClick={() => setConfirmDel(b.name)}
        >
          <Trash2 aria-hidden="true" />
        </button>
      </>
    );

  return (
    <section className="bk grid content-start gap-[18px]">
      <PageIntro
        eyebrow={
          <>
            <span className="bk-wide">Backups · local config vault</span>
            <span className="bk-narrow">Backups · local vault</span>
          </>
        }
        verdict={
          n === 0 ? (
            "No backups yet."
          ) : stale ? (
            <>
              {count} <span className="w">{stalest}</span>
              {stalestAt !== undefined && <span className="bk-wide"> was</span>} {lastText}.
            </>
          ) : (
            <>
              {count} <span className="s">Every router</span> was saved today.
            </>
          )
        }
        lead={
          <>
            <span className="bk-wide bk-path">
              {dirEdit === null ? (
                <>
                  <span>
                    Stored in <span className="mono">{data.dir}</span>
                  </span>
                  <button
                    type="button"
                    className="bk-link"
                    title="Change backup directory"
                    onClick={() => setDirEdit(data.dir)}
                  >
                    <Pencil aria-hidden="true" />
                    edit path
                  </button>
                </>
              ) : (
                <>
                  <input
                    className="monitor-input"
                    aria-label="Backup directory"
                    value={dirEdit}
                    autoFocus
                    spellCheck={false}
                    placeholder="~/.mikrotik-mcp/backups"
                    onChange={(e) => setDirEdit(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void saveDir();
                      if (e.key === "Escape") setDirEdit(null);
                    }}
                  />
                  <MonitorButton
                    variant="primary"
                    size="sm"
                    disabled={busy}
                    onClick={() => void saveDir()}
                  >
                    Save path
                  </MonitorButton>
                  <MonitorButton variant="ghost" size="sm" onClick={() => setDirEdit(null)}>
                    Cancel
                  </MonitorButton>
                </>
              )}
            </span>
            <span className="bk-narrow monitor-hint mono">{data.dir}</span>
          </>
        }
      />

      <MetricStrip label="Vault counts" className="bk-kpis">
        <Metric label="Backups" value={String(n)} hint="in the vault" />
        <Metric
          label="Routers covered"
          value={
            <>
              {covered}
              <small>/{routers.length}</small>
            </>
          }
          hint={
            uploaded > 0
              ? `plus ${uploaded} uploaded file${uploaded === 1 ? "" : "s"}`
              : "no uploaded files"
          }
          tone={covered < routers.length ? "warn" : "default"}
        />
        <Metric
          label="Newest"
          value={newest ? ago(newest.modified) : "—"}
          hint={
            newest ? (
              <>
                {newest.device ?? "uploaded"}
                <span className="bk-wide"> · {labelOf(newest)}</span>
              </>
            ) : (
              "none"
            )
          }
        />
        <Metric
          label="Vault size"
          value={
            <>
              {totalNum}
              <small>{totalUnit}</small>
            </>
          }
          hint="plain-text .rsc exports"
        />
      </MetricStrip>

      <div className="bk-cols">
        <MonitorPanel
          title="Create a backup"
          description={
            <span className="bk-wide">
              Captures the router's <span className="mono">/export</span> into the vault.
            </span>
          }
          bodyClassName="flex flex-col gap-3.5"
        >
          <div className="bk-create-row">
            <IconSelect
              value={device}
              onChange={setDevice}
              label="Device"
              options={deviceOptions}
            />
            <label className="bk-field">
              <Pencil aria-hidden="true" />
              <input
                className="monitor-input"
                aria-label="Label"
                value={label}
                spellCheck={false}
                placeholder="label (optional), e.g. pre-upgrade"
                onChange={(e) => setLabel(e.target.value)}
              />
            </label>
          </div>
          <div className="monitor-fl">
            <span className="monitor-label bk-hide-phone">Export options</span>
            <div className="bk-chips">
              {OPTIONS.map(([k, lbl, tip]) => {
                const disabled = k === "compact" && opts.verbose;
                return (
                  <button
                    key={k}
                    type="button"
                    className="bk-chip"
                    aria-pressed={opts[k]}
                    disabled={disabled}
                    title={tip}
                    onClick={() => toggle(k)}
                  >
                    {opts[k] && <Check aria-hidden="true" />}
                    {lbl}
                  </button>
                );
              })}
            </div>
            <span className="monitor-hint bk-hide-phone">
              compact keeps only non-default values. verbose adds every parameter and turns compact
              off. show-sensitive includes keys and passwords.
            </span>
          </div>
          <div className="bk-create-buttons flex flex-wrap items-center gap-2">
            <MonitorButton
              variant="primary"
              icon={<Plus aria-hidden="true" />}
              disabled={busy || !device}
              aria-busy={busy || undefined}
              onClick={() => void create()}
            >
              Create backup
            </MonitorButton>
            <MonitorButton
              variant="ghost"
              icon={<Upload aria-hidden="true" />}
              onClick={() => fileRef.current?.click()}
            >
              Upload .rsc
            </MonitorButton>
            <span className="bk-hide-phone">
              <MonitorButton variant="ghost" icon={<RefreshCw aria-hidden="true" />} onClick={load}>
                Refresh
              </MonitorButton>
            </span>
            <input
              ref={fileRef}
              type="file"
              accept=".rsc,text/plain"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
                e.currentTarget.value = "";
              }}
            />
          </div>
        </MonitorPanel>

        <div className="bk-hide-phone">
          <MonitorPanel
            title="Last backup per router"
            description="Bar length: how many backups the vault keeps for it."
          >
            {routers.length === 0 ? (
              <MonitorEmpty compact title="No routers yet" />
            ) : (
              routers.map((d) => {
                const at = lastBy.get(d);
                const tone = ageTone(at);
                const pct = ((countBy.get(d) ?? 0) / maxCount) * 100;
                return (
                  <div key={d} className="bk-cover">
                    <span className="flex min-w-0 items-center gap-2.5">
                      <StatusDot tone={tone} />
                      <span className="mono p trunc text-foreground">{d}</span>
                    </span>
                    <span className="monitor-bar">
                      <span data-tone={tone} style={{ width: `${pct}%` }} />
                    </span>
                    <span
                      className={`mono text-right ${tone === "bad" ? "text-destructive" : "text-muted-foreground"}`}
                    >
                      {at === undefined ? "never" : ago(at)}
                    </span>
                  </div>
                );
              })
            )}
          </MonitorPanel>
        </div>
      </div>

      <div className="bk-hide-phone">
        <MonitorPanel title="Vault" description="Newest first. Restore runs in Safe Mode." flush>
          {n === 0 ? (
            <MonitorEmpty compact title="No backups yet">
              Press Create backup to capture a router's config, or upload a .rsc file.
            </MonitorEmpty>
          ) : (
            <>
              <div className="monitor-thead bk-table">
                <span>Name</span>
                <span>Device</span>
                <span>Size</span>
                <span>Captured</span>
                <span />
              </div>
              {backups.map((b) => (
                <div
                  key={b.name}
                  className="monitor-row bk-table"
                  data-failed={confirmDel === b.name || undefined}
                >
                  <span className="mono p trunc" title={b.name}>
                    {b.name}
                  </span>
                  {b.device ? (
                    <span className="flex min-w-0 items-center gap-2.5">
                      <StatusDot tone={ageTone(lastBy.get(b.device))} />
                      <span className="mono p trunc">{b.device}</span>
                    </span>
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                  <span className="mono">{size(b.bytes)}</span>
                  <span className="mono text-muted-foreground">{stamp(b.modified)}</span>
                  <span className="bk-actions">{rowActions(b)}</span>
                </div>
              ))}
            </>
          )}
        </MonitorPanel>
      </div>

      <div className="bk-vault-head">
        <span className="monitor-label flex-1">Vault · newest first</span>
        <MonitorButton
          variant="ghost"
          size="sm"
          icon={<RefreshCw aria-hidden="true" />}
          onClick={load}
        >
          Refresh
        </MonitorButton>
      </div>
      <div className="bk-cards">
        {n === 0 && <MonitorEmpty compact title="No backups yet" />}
        {backups.map((b) => (
          <div key={b.name} className="glass bk-card">
            <span className="mono bk-card-name">{b.name}</span>
            <div className="flex items-center gap-2.5 text-[12px]">
              {b.device ? (
                <span className="flex min-w-0 items-center gap-2.5">
                  <StatusDot tone={ageTone(lastBy.get(b.device))} />
                  <span className="mono trunc">{b.device}</span>
                </span>
              ) : (
                <span className="text-faint">uploaded</span>
              )}
              <span className="flex-1" />
              <span className="mono text-muted-foreground">{size(b.bytes)}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="mono flex-1 text-[11px] text-faint">{stamp(b.modified)}</span>
              <MonitorButton
                size="sm"
                icon={<Upload aria-hidden="true" />}
                onClick={() => setRestoreName(b.name)}
              >
                Restore
              </MonitorButton>
              <button
                type="button"
                className="monitor-icon-btn"
                aria-label="More"
                aria-expanded={more === b.name}
                onClick={() => setMore((m) => (m === b.name ? null : b.name))}
              >
                <Ellipsis aria-hidden="true" />
              </button>
            </div>
            {more === b.name && <div className="bk-actions justify-start">{rowActions(b)}</div>}
          </div>
        ))}
      </div>

      {body && (
        <MonitorPanel
          title={`Backup · ${body.name}`}
          description={(() => {
            const b = backups.find((x) => x.name === body.name);
            return b ? `${size(b.bytes)} · captured ${stamp(b.modified)}` : undefined;
          })()}
          extra={
            <MonitorButton
              variant="ghost"
              size="sm"
              icon={<X aria-hidden="true" />}
              onClick={() => setBody(null)}
            >
              Close
            </MonitorButton>
          }
        >
          <pre className="monitor-pre bk-export">{body.content || "(empty)"}</pre>
        </MonitorPanel>
      )}

      {restoring && (
        <RestoreDialog
          backup={restoring}
          devices={data.devices}
          onClose={() => setRestoreName(null)}
        />
      )}
    </section>
  );
}
