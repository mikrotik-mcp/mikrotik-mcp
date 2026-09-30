import { UnifiedDiff } from "./diff-view";
/**
 * Config editor shell. Owns the single working `cfg` object and the shared
 * safe-apply pipeline (validate → preview → save → countdown → keep/rollback,
 * plus per-device connection tests). A Form ↔ JSON mode switch renders either the
 * interactive card form (`ConfigForm`) or the raw `JsonEditor` — both mutate the
 * same `cfg`, so switching modes is lossless and the JSON always reflects the form.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Braces, LayoutGrid, X } from "lucide-react";
import { api, postJson } from "./api";
import { ConfigForm, DevicesForm } from "./config-form";
import { selectConfigScope, scopeConfigDraft } from "../../src/config-device-draft";
import type { ConfigScope } from "../../src/config-device-draft";
import { JsonEditor, ROLLBACK_OPTS } from "./config-studio";
import type { ConfigIssue, DiffSummary, SaveResp } from "./config-studio";
import { Button, Select } from "./geist";
import { toast } from "./toast-action";
import { testDeviceConnection } from "./config-connection";
import { cn } from "@/lib/utils";

type Cfg = Record<string, unknown>;
const asObj = (v: unknown): Cfg =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Cfg) : {};

export type DeviceTest = { ok: boolean; pending: boolean; label: string; fingerprint: string };

export function ConfigEditor({
  initial,
  onClose,
  onReload,
  scope = "server",
  initialSelection,
  original = initial,
}: {
  initial: unknown;
  onClose: () => void;
  onReload: () => void;
  scope?: ConfigScope;
  initialSelection?: { name: string; isNew: boolean };
  original?: unknown;
}): ReactNode {
  const [cfg, setCfg] = useState<Cfg>(() => asObj(initial));
  const [mode, setMode] = useState<"form" | "json">("form");
  const [jsonErr, setJsonErr] = useState<string | null>(null);
  const [errors, setErrors] = useState<ConfigIssue[]>([]);
  const [tests, setTests] = useState<Record<string, DeviceTest>>({});
  const testing = useRef(new Map<string, Promise<boolean>>());
  const [testingAll, setTestingAll] = useState(false);
  const [preview, setPreview] = useState<{ summary?: DiffSummary; unified?: string } | null>(null);
  const [pending, setPending] = useState<SaveResp | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [rollbackMs, setRollbackMs] = useState(60_000);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [baseline, setBaseline] = useState(() => asObj(original));
  const [discard, setDiscard] = useState(false);
  const [selection, setSelection] = useState(initialSelection);
  const dirty =
    JSON.stringify(selectConfigScope(cfg, scope)) !==
    JSON.stringify(selectConfigScope(baseline, scope));
  const endpoint = (path: string) => `${path}?scope=${scope}`;
  const change = (next: Cfg) => {
    setCfg(next);
    setPreview(null);
    setDiscard(false);
  };

  // Debounced schema validation of the working config (Zod is authoritative).
  useEffect(() => {
    let active = true;
    const t = setTimeout(() => {
      void postJson<{ ok: boolean; errors?: ConfigIssue[]; error?: string }>(
        `/api/config/validate?scope=${scope}`,
        cfg,
      )
        .then((r) => {
          if (active)
            setErrors(
              r.ok
                ? []
                : (r.errors ?? [{ path: "(root)", message: r.error ?? "Validation unavailable" }]),
            );
        })
        .catch(() => {
          if (active) setErrors([{ path: "(root)", message: "Validation unavailable" }]);
        });
    }, 350);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [cfg, scope]);

  // Rollback countdown while a save awaits confirmation.
  const onReloadRef = useRef(onReload);
  useLayoutEffect(() => {
    onReloadRef.current = onReload;
  }, [onReload]);
  useEffect(() => {
    if (!pending || (pending.rollbackMs ?? 0) <= 0) return;
    const t = setTimeout(
      () => {
        setCountdown(Math.max(0, countdown - 1));
        if (countdown > 1) return;
        setMsg("Auto-reverted — changes were not confirmed in time.");
        setPending(null);
        void api<Cfg>("/api/config")
          .then((value) => {
            setCfg(value);
            setBaseline(value);
          })
          .catch(() => {});
        onReloadRef.current();
      },
      countdown > 0 ? 1000 : 0,
    );
    return () => clearTimeout(t);
  }, [pending, countdown]);

  const valid = !jsonErr && errors.length === 0;

  const testDevice = (name: string): Promise<boolean> => {
    const existing = testing.current.get(name);
    if (existing) return existing;
    const dc = asObj(cfg.devices)[name];
    const fingerprint = JSON.stringify(dc);
    setTests((old) => ({
      ...old,
      [name]: { ok: false, pending: true, label: "Connecting…", fingerprint },
    }));
    const request = testDeviceConnection(name, dc, cfg.devices)
      .then(({ ok, label }) => {
        setTests((old) => ({ ...old, [name]: { ok, pending: false, label, fingerprint } }));
        return ok;
      })
      .finally(() => testing.current.delete(name));
    testing.current.set(name, request);
    return request;
  };

  const testDevices = async (): Promise<void> => {
    if (testingAll) return;
    const devices = asObj(cfg.devices);
    if (Object.keys(devices).length === 0) {
      setMsg("No devices configured to test — add one first.");
      toast.error("No devices to test");
      return;
    }
    setTestingAll(true);
    const out: boolean[] = [];
    try {
      for (const name of Object.keys(devices)) out.push(await testDevice(name));
    } finally {
      setTestingAll(false);
    }
    if (out.every(Boolean)) toast.success("Devices reachable");
    else toast.error("Some devices unreachable");
  };

  const doPreview = async (): Promise<void> => {
    setBusy(true);
    try {
      setPreview(await postJson(endpoint("/api/config/preview"), cfg));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Preview failed");
    } finally {
      setBusy(false);
    }
  };

  const doSave = async (next: Cfg = cfg): Promise<boolean> => {
    if (busy || pending) return false;
    setBusy(true);
    setMsg("Saving…");
    try {
      const r = await postJson<SaveResp & { config?: Cfg }>(endpoint("/api/config"), {
        config: next,
        rollbackMs,
      });
      setMsg(null);
      setPreview(null);
      if (!r.ok) {
        setErrors(r.errors ?? [{ path: "(root)", message: "save rejected" }]);
        toast.error(r.errors?.[0]?.message ?? "Config save rejected");
        return false;
      }
      setPending(r);
      if (r.config) {
        setCfg(r.config);
        setBaseline(r.config);
      }
      setCountdown(Math.round((r.rollbackMs ?? 0) / 1000));
      toast.success("Config applied");
      onReload();
      return true;
    } catch (e) {
      setMsg(null);
      toast.error(e instanceof Error ? e.message : "Save failed");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const doKeep = async (): Promise<void> => {
    if (!pending?.pendingId || busy) return;
    setBusy(true);
    try {
      const result = await postJson<{ kept: boolean }>("/api/config/keep", {
        pendingId: pending.pendingId,
      });
      if (!result.kept)
        throw new Error("This change is no longer pending. Refresh before trying again.");
      setPending(null);
      setMsg("Changes kept.");
      onReload();
      toast.success("Change kept");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Keep failed");
    } finally {
      setBusy(false);
    }
  };
  const doRollback = async (): Promise<void> => {
    if (!pending?.pendingId || busy) return;
    setBusy(true);
    try {
      const result = await postJson<{ rolledBack: boolean }>("/api/config/rollback", {
        pendingId: pending.pendingId,
      });
      if (!result.rolledBack)
        throw new Error("This change is no longer pending. Refresh before trying again.");
      setPending(null);
      const restored = await api<Cfg>("/api/config");
      setCfg(restored);
      setBaseline(restored);
      setMode("form");
      setSelection(undefined);
      setMsg("Reverted to the previous config.");
      onReload();
      toast.success("Change rolled back");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Rollback failed");
    } finally {
      setBusy(false);
    }
  };

  const deviceForm = (
    <DevicesForm
      cfg={cfg}
      onChange={(next) => {
        change(next);
        setSelection(undefined);
      }}
      tests={tests}
      onTest={(name) => void testDevice(name)}
      onSave={async (next) => {
        const saved = await doSave(next);
        if (saved) setSelection(undefined);
        return saved;
      }}
      saveNotice={
        rollbackMs > 0
          ? `Saves all pending device changes. Choose Keep changes within ${rollbackMs / 1000}s after saving, or they auto-revert.`
          : "Saves all pending device changes without an auto-revert window."
      }
      initialSelection={selection}
      onCancelStandalone={selection ? onClose : undefined}
    />
  );

  // Quick add/edit needs the safe-apply state, not the inventory panel behind it.
  // Reveal the manager only after accepting a draft or a save needing confirmation.
  if (scope === "devices" && selection) return deviceForm;

  return (
    <div
      className={cn(
        "flex flex-col gap-3.5",
        scope === "devices" && "device-config-editor devices-management",
      )}
      role={scope === "devices" ? "region" : undefined}
      aria-label={scope === "devices" ? "Manage routers" : undefined}
    >
      {scope === "server" && (
        <p className="text-xs text-muted-foreground">
          Router connections are managed on the{" "}
          <a className="text-primary underline underline-offset-4" href="#devices">
            Devices page
          </a>
          . This editor only changes server settings.
        </p>
      )}
      <div className="config-editor__toolbar flex flex-wrap items-center gap-2">
        <div className="border-border bg-muted inline-flex gap-0.5 rounded-md border p-0.5">
          <button
            disabled={busy || !!pending}
            className={cn(
              "flex cursor-pointer items-center gap-1.5 rounded-[6px] border-0 bg-transparent px-[11px] py-1 text-xs font-semibold",
              mode === "form" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground",
            )}
            onClick={() => {
              setJsonErr(null);
              setMode("form");
            }}
          >
            <LayoutGrid className="size-3.5" /> Form
          </button>
          <button
            disabled={busy || !!pending}
            className={cn(
              "flex cursor-pointer items-center gap-1.5 rounded-[6px] border-0 bg-transparent px-[11px] py-1 text-xs font-semibold",
              mode === "json" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground",
            )}
            onClick={() => {
              setSelection(undefined);
              setMode("json");
            }}
          >
            <Braces className="size-3.5" /> JSON
          </button>
        </div>
        <span
          className={cn(
            "rounded-full border px-2.5 py-1 font-mono text-[11px]",
            valid
              ? "border-success/40 bg-success/10 text-success"
              : "border-destructive/40 bg-destructive/10 text-destructive",
          )}
        >
          {jsonErr
            ? "invalid JSON"
            : errors.length
              ? `${errors.length} schema issue(s)`
              : "valid ✓"}
        </span>
        <span className="flex-1" />
        {scope === "devices" && (
          <Button
            size="sm"
            ghost
            disabled={testingAll || busy || !!pending}
            onClick={() => void testDevices()}
          >
            {testingAll ? "Testing devices…" : "Test devices"}
          </Button>
        )}
        <Button
          size="sm"
          ghost
          onClick={() => void doPreview()}
          disabled={!valid || busy || !!pending}
        >
          Preview diff
        </Button>
        <Select
          size="sm"
          disabled={busy || !!pending}
          value={String(rollbackMs)}
          onValueChange={(v) => setRollbackMs(Number(v))}
          options={ROLLBACK_OPTS.map(([label, v]) => ({ value: String(v), label }))}
          aria-label="Auto-revert window"
        />
        <Button
          size="sm"
          type="accent"
          onClick={() => void doSave()}
          disabled={!valid || !!pending || busy || testingAll}
        >
          {busy ? "Working…" : scope === "devices" ? "Save devices" : "Save"}
        </Button>
        <Button
          size="sm"
          ghost
          disabled={busy || !!pending}
          onClick={() => (dirty || jsonErr ? setDiscard(true) : onClose())}
        >
          Close
        </Button>
      </div>
      {discard && (
        <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs" role="alert">
          <p className="mb-2">Discard this unsaved draft? No saved settings will be changed.</p>
          <div className="flex gap-2">
            <Button size="sm" type="error" onClick={onClose}>
              Discard draft
            </Button>
            <Button size="sm" ghost onClick={() => setDiscard(false)}>
              Continue editing
            </Button>
          </div>
        </div>
      )}

      {msg && <div className="text-muted-foreground font-mono text-xs">{msg}</div>}

      {pending && (
        <div className="border-warning/40 bg-warning/10 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2.5 text-xs">
          <strong>Applied.</strong>{" "}
          {(pending.rollbackMs ?? 0) > 0 ? (
            <>
              Reverting in <span className="text-warning font-mono font-bold">{countdown}s</span>{" "}
              unless you keep it.
            </>
          ) : (
            <>Saved without an auto-revert window.</>
          )}
          {pending.devicesChanged && (
            <span className="text-warning text-[11px]">
              {" "}
              · device list changed — reconnect the MCP client to expose it to the model
            </span>
          )}
          <span className="flex-1" />
          <Button size="sm" type="accent" disabled={busy} onClick={() => void doKeep()}>
            Keep changes
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void doRollback()}>
            Revert now
          </Button>
        </div>
      )}

      {mode === "json" && Object.keys(tests).length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(tests)
            .filter(([name, r]) => r.fingerprint === JSON.stringify(asObj(cfg.devices)[name]))
            .map(([name, r]) => (
              <span
                key={name}
                className={cn(
                  "rounded-full border px-2.5 py-1 font-mono text-[11px]",
                  r.ok
                    ? "border-success/40 text-success"
                    : "border-destructive/40 text-destructive",
                )}
              >
                {r.ok ? "●" : "○"} {name}: {r.label}
              </span>
            ))}
        </div>
      )}

      <fieldset
        disabled={busy || !!pending}
        className="min-w-0 border-0 p-0 m-0 disabled:opacity-70"
      >
        {mode === "form" ? (
          scope === "devices" ? (
            deviceForm
          ) : (
            <ConfigForm cfg={cfg} onChange={change} />
          )
        ) : (
          <JsonEditor
            value={selectConfigScope(cfg, scope)}
            onChange={(o) => change(asObj(scopeConfigDraft(o, cfg, scope)))}
            onJsonError={setJsonErr}
          />
        )}
      </fieldset>

      {(jsonErr || errors.length > 0) && (
        <div className="flex flex-col gap-[3px]">
          {jsonErr ? (
            <div className="text-destructive font-mono text-[11px]">JSON: {jsonErr}</div>
          ) : (
            errors.slice(0, 12).map((e, i) => (
              <div className="text-destructive font-mono text-[11px]" key={i}>
                <code className="text-warning">{e.path}</code> — {e.message}
              </div>
            ))
          )}
        </div>
      )}

      {preview && (
        <div className="border-border overflow-hidden rounded-md border">
          <div className="bg-muted flex items-center gap-2 px-[13px] py-[9px] text-xs">
            <strong>Diff vs current</strong>
            <span className="text-muted-foreground text-[11px]">
              {preview.summary?.changed
                ? `+${preview.summary.added} / -${preview.summary.removed}`
                : "no changes"}
            </span>
            <span className="flex-1" />
            <Button
              size="sm"
              ghost
              icon={<X className="size-4" />}
              onClick={() => setPreview(null)}
              aria-label="Close preview"
            />
          </div>
          <UnifiedDiff unified={preview.unified || ""} maxHeight={320} />
        </div>
      )}
    </div>
  );
}
