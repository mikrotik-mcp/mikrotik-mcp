import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Check, Download, Pencil, Plus, RefreshCw, Trash2, Upload, X } from "lucide-react";
import { api, postJson, withToken } from "./api";
import { Panel } from "./atoms";
import { bytes } from "./format";
import { Button, Input, Select } from "./geist";
import { toast } from "./toast-action";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

// ── Local backup vault view ──────────────────────────────────────────────────
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

/** Manage the host-side backup vault: create, download, upload, rename, restore, delete. */
export function BackupsView(): ReactNode {
  const [data, setData] = useState<BackupsData | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [restoreName, setRestoreName] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ name: string; value: string } | null>(null);
  const [device, setDevice] = useState("");
  const [body, setBody] = useState<{ name: string; content: string } | null>(null);
  const [dirEdit, setDirEdit] = useState<string | null>(null);
  // /export options (mirror RouterOS flags) applied to "Create backup".
  const [label, setLabel] = useState("");
  const [opts, setOpts] = useState({
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
    setMsg("Capturing /export…");
    const r = await postJson<{ ok?: boolean; name?: string; bytes?: number; error?: string }>(
      "/api/backups/create",
      {
        device: device || undefined,
        label: label.trim() || undefined,
        show_sensitive: opts.show_sensitive,
        // `compact` is meaningless when `verbose` is on — don't send both.
        verbose: opts.verbose,
        compact: opts.verbose ? false : opts.compact,
        terse: opts.terse,
      },
    ).catch((): { ok?: boolean; name?: string; bytes?: number; error?: string } => ({
      error: "request failed",
    }));
    setBusy(false);
    setMsg(r.ok ? `Created ${r.name} (${r.bytes} bytes)` : `Create failed: ${r.error}`);
    if (r.ok) {
      toast.success("Backup created");
      load();
    } else toast.error(`Create failed: ${r.error}`);
  };
  const toggle = (k: keyof typeof opts): void => setOpts((o) => ({ ...o, [k]: !o[k] }));
  const upload = async (file: File): Promise<void> => {
    const content = await file.text();
    const r = await post("/api/backups/upload", { name: file.name, content });
    setMsg(r.ok ? `Uploaded ${r.name}` : `Upload failed: ${r.error}`);
    if (r.ok) {
      toast.success("Backup uploaded");
      load();
    } else toast.error(`Upload failed: ${r.error}`);
  };
  const del = async (name: string): Promise<void> => {
    setConfirmDel(null);
    const r = await post("/api/backups/delete", { name });
    setMsg(r.ok ? `Deleted ${name}` : `Delete failed: ${r.error}`);
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
    setMsg(r.ok ? `Renamed to ${r.name}` : `Rename failed: ${r.error}`);
    if (r.ok) {
      toast.success("Backup renamed");
      load();
    } else toast.error(`Rename failed: ${r.error}`);
  };
  const restore = async (confirm: boolean): Promise<void> => {
    if (!restoreName) return;
    setBusy(true);
    setMsg(confirm ? "Restoring in Safe Mode…" : "Dry-run restore in Safe Mode…");
    const r = await postJson<{
      ok?: boolean;
      committed?: boolean;
      applied?: number;
      message?: string;
    }>("/api/backups/restore", { name: restoreName, device: device || undefined, confirm }).catch(
      (): { ok?: boolean; committed?: boolean; applied?: number; message?: string } => ({
        ok: false,
        message: "request failed",
      }),
    );
    setBusy(false);
    setMsg(
      r.ok
        ? r.committed
          ? `Restored ${restoreName} → ${device}: ${r.message}`
          : `Dry-run OK (${r.applied} cmds, rolled back). Click “Restore (commit)” to apply for real.`
        : `Restore failed: ${r.message}`,
    );
    if (r.ok) toast.success(r.committed ? "Backup restored" : "Dry-run restore OK");
    else toast.error(`Restore failed: ${r.message}`);
    if (r.ok && confirm) setRestoreName(null);
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
      setMsg(
        r.persisted ? `Backup path saved → ${r.dir}` : (r.warning ?? `Path applied → ${r.dir}`),
      );
      toast.success("Backup directory updated");
    } else {
      setMsg(`Path change failed: ${r.error}`);
      toast.error(`Path change failed: ${r.error}`);
    }
    if (r.ok) load();
  };

  if (!data) return <div className="text-muted-foreground text-[11px]">loading backups…</div>;

  const deviceOptions =
    data.devices.length === 0
      ? [{ value: "", label: "no devices" }]
      : data.devices.map((d) => ({ value: d, label: d }));

  return (
    <section className="grid content-start gap-[18px]">
      <Panel
        title="Local backup vault"
        className="reveal"
        extra={
          dirEdit === null ? (
            <span className="inline-flex max-w-[min(60vw,520px)] items-center gap-2 text-muted-foreground text-[11px]">
              <span className="truncate" title={data.dir}>
                {data.dir}
              </span>
              <button
                type="button"
                className="inline-flex items-center gap-1 whitespace-nowrap text-brand hover:underline"
                title="Change backup directory"
                onClick={() => setDirEdit(data.dir)}
              >
                <Pencil className="size-3" /> edit path
              </button>
            </span>
          ) : (
            <span className="inline-flex items-center gap-2">
              <Input
                className="w-[min(48vw,380px)] text-xs"
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
              <Button type="accent" size="sm" onClick={() => void saveDir()} disabled={busy}>
                Save path
              </Button>
              <Button type="secondary" size="sm" ghost onClick={() => setDirEdit(null)}>
                Cancel
              </Button>
            </span>
          )
        }
      >
        {msg && <div className="mb-3 font-mono text-xs text-muted-foreground">{msg}</div>}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Select
            value={device}
            onValueChange={setDevice}
            aria-label="Device"
            options={deviceOptions}
          />
          <Button
            type="accent"
            size="sm"
            icon={<Plus />}
            onClick={() => void create()}
            disabled={busy || !device}
          >
            Create backup
          </Button>
          <Button size="sm" icon={<Upload />} onClick={() => fileRef.current?.click()}>
            Upload .rsc
          </Button>
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
          <Button size="sm" icon={<RefreshCw />} onClick={load}>
            Refresh
          </Button>
        </div>

        {/* /export options applied to "Create backup" */}
        <div className="mb-3 flex flex-wrap items-center gap-2.5">
          <Input
            className="max-w-[200px] text-xs"
            value={label}
            spellCheck={false}
            placeholder="label (optional), e.g. pre-upgrade"
            onChange={(e) => setLabel(e.target.value)}
          />
          {(
            [
              ["show_sensitive", "show-sensitive", "Include secrets (keys/passwords)"],
              ["verbose", "verbose", "Include every parameter, even defaults"],
              ["compact", "compact", "Only non-default values (ignored if verbose)"],
              ["terse", "terse", "One machine-readable line per item"],
            ] as const
          ).map(([k, lbl, tip]) => {
            const disabled = k === "compact" && opts.verbose;
            return (
              <label
                key={k}
                className={cn(
                  "inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1.5 font-mono text-[11px] select-none",
                  opts[k]
                    ? "border-brand/55 bg-brand/10 text-foreground"
                    : "border-border bg-muted/40 text-muted-foreground",
                  disabled && "cursor-not-allowed opacity-45",
                )}
                title={tip}
              >
                <input
                  type="checkbox"
                  className="accent-brand"
                  checked={opts[k]}
                  disabled={disabled}
                  onChange={() => toggle(k)}
                />
                {lbl}
              </label>
            );
          })}
        </div>

        {restoreName && (
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-warning/45 bg-warning/10 px-3 py-2.5 text-xs">
            <strong>Restore {restoreName}</strong> onto{" "}
            <Select
              value={device}
              onValueChange={setDevice}
              size="sm"
              aria-label="Restore target device"
              options={data.devices.map((d) => ({ value: d, label: d }))}
            />{" "}
            via Safe Mode (auto-reverts on lock-out).
            <span className="flex-1" />
            <Button
              type="secondary"
              size="sm"
              ghost
              onClick={() => void restore(false)}
              disabled={busy}
            >
              Dry-run
            </Button>
            <Button type="accent" size="sm" onClick={() => void restore(true)} disabled={busy}>
              Restore (commit)
            </Button>
            <Button type="secondary" size="sm" ghost onClick={() => setRestoreName(null)}>
              Cancel
            </Button>
          </div>
        )}

        {data.backups.length === 0 ? (
          <div className="p-3 text-muted-foreground text-[11px]">
            No backups yet. Click “Create backup” to capture this device’s config, or upload a
            `.rsc`.
          </div>
        ) : (
          <div className="max-h-[60vh] overflow-auto rounded-lg border border-border">
            {/*
              `table-fixed` + explicit widths: backup names are arbitrarily long
              filenames, and with auto layout a single long one starved every other
              column. The name cell truncates instead; `min-w` makes the container
              scroll horizontally rather than crushing the action buttons.
            */}
            <Table className="min-w-[980px] table-fixed">
              <TableHeader className="bg-card sticky top-0 z-10">
                <TableRow>
                  <TableHead>name</TableHead>
                  <TableHead className="w-[130px]">device</TableHead>
                  <TableHead className="w-[90px] text-right">size</TableHead>
                  <TableHead className="w-[170px]">captured</TableHead>
                  {/* Sized for the widest state: the rename input plus its
                      confirm/cancel buttons alongside view/download/delete. */}
                  <TableHead className="w-[380px]">actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.backups.map((b) => (
                  <TableRow
                    key={b.name}
                    data-state={body?.name === b.name ? "selected" : undefined}
                  >
                    <TableCell className="truncate font-mono" title={b.name}>
                      {b.name}
                    </TableCell>
                    <TableCell className="truncate">{b.device ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{bytes(b.bytes)}</TableCell>
                    <TableCell className="tabular-nums whitespace-nowrap">
                      {new Date(b.modified).toLocaleString(undefined, { hour12: false })}
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-1.5">
                        <Button size="sm" onClick={() => viewBody(b.name)}>
                          view
                        </Button>
                        <a
                          className="inline-flex items-center rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
                          href={withToken(`/api/backups/raw?name=${encodeURIComponent(b.name)}`)}
                          download={b.name}
                          title="Download"
                        >
                          <Download className="size-3.5" />
                        </a>
                        {renaming?.name === b.name ? (
                          <>
                            <Input
                              className="inline-block w-[120px] text-xs"
                              value={renaming.value}
                              autoFocus
                              onChange={(e) => setRenaming({ name: b.name, value: e.target.value })}
                              onKeyDown={(e) => e.key === "Enter" && void rename()}
                            />
                            <Button
                              type="accent"
                              size="sm"
                              icon={<Check />}
                              onClick={() => void rename()}
                            />
                            <Button
                              type="secondary"
                              size="sm"
                              ghost
                              icon={<X />}
                              onClick={() => setRenaming(null)}
                            />
                          </>
                        ) : (
                          <>
                            <Button
                              size="sm"
                              onClick={() => setRenaming({ name: b.name, value: b.name })}
                            >
                              rename
                            </Button>
                            <Button type="accent" size="sm" onClick={() => setRestoreName(b.name)}>
                              restore
                            </Button>
                          </>
                        )}
                        {confirmDel === b.name ? (
                          <>
                            <Button
                              type="error"
                              size="sm"
                              ghost
                              icon={<Check />}
                              onClick={() => void del(b.name)}
                            />
                            <Button
                              type="secondary"
                              size="sm"
                              ghost
                              icon={<X />}
                              onClick={() => setConfirmDel(null)}
                            />
                          </>
                        ) : (
                          <Button
                            type="error"
                            size="sm"
                            ghost
                            icon={<Trash2 />}
                            onClick={() => setConfirmDel(b.name)}
                          />
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>

      {body && (
        <Panel
          title={`Backup · ${body.name}`}
          className="reveal"
          extra={
            <Button type="secondary" size="sm" icon={<X />} onClick={() => setBody(null)}>
              Close
            </Button>
          }
        >
          <pre
            className="m-0 overflow-auto rounded border border-border bg-background p-3 font-mono text-xs break-words whitespace-pre-wrap"
            style={{ maxHeight: 460 }}
          >
            {body.content || "(empty)"}
          </pre>
        </Panel>
      )}
    </section>
  );
}
