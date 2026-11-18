/**
 * The "New scheduled audit" dialog, after the Mon-Schedules-JobEditor board.
 *
 * Saves through POST /api/schedules, which validates with the same JobSchema
 * as the add_schedule tool and refuses anything that is not READ.
 */
import { useMemo, useState } from "react";
import { useNow } from "./use-now";
import type { ReactNode } from "react";
import { postJson } from "./api";
import { describeCron, isValidCron, nextRun } from "../../src/schedule/model";
import { MonitorButton, MonitorDialog, MonitorNote, RiskBadge, Segmented } from "./monitoring-ui";
import { toast } from "./toast-action";
import { Check, Clock, Loader2, X } from "lucide-react";
import "./schedules.css";

const ID_RE = /^[a-z0-9][a-z0-9-]*$/i;
const NOTIFY = [
  { value: "new", label: "New findings" },
  { value: "worsened", label: "Worse findings" },
  { value: "resolved", label: "Resolved" },
  { value: "improved", label: "Improved" },
] as const;
type Notify = (typeof NOTIFY)[number]["value"];

/** "today 03:30", "tomorrow 03:30", "Mon 06:00", "Nov 6 06:00". */
export function runTime(ms: number, now: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const day = (offset: number): string => new Date(now + offset * 86_400_000).toDateString();
  if (d.toDateString() === day(0)) return `today ${time}`;
  if (d.toDateString() === day(1)) return `tomorrow ${time}`;
  if (Math.abs(ms - now) < 6 * 86_400_000)
    return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="monitor-fl">
      <span className="monitor-label">{label}</span>
      {children}
      {error ? (
        <span className="monitor-err">{error}</span>
      ) : (
        hint != null && <span className="monitor-hint">{hint}</span>
      )}
    </div>
  );
}

/** Mounted only while open, so every open starts from a clean form. */
export function ScheduleJobEditor(props: Parameters<typeof ScheduleJobEditorForm>[0]): ReactNode {
  return props.open ? <ScheduleJobEditorForm {...props} /> : null;
}

function ScheduleJobEditorForm({
  open,
  onOpenChange,
  auditors,
  devices,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The schedulable auditors /api/schedules lists. */
  auditors: { tool: string; summary: string }[];
  devices: string[];
  onSaved: (id: string) => void;
}): ReactNode {
  const [id, setId] = useState("");
  const [cron, setCron] = useState("");
  const [tool, setTool] = useState(auditors[0]?.tool ?? "");
  const [scope, setScope] = useState<"all" | "pick">("all");
  const [picked, setPicked] = useState<string[]>([]);
  const [retain, setRetain] = useState("90");
  const [notifyOn, setNotifyOn] = useState<Notify[]>(["new", "worsened"]);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);

  const now = useNow(60_000);
  const cronOk = isValidCron(cron.trim());
  const cronHint = useMemo(() => {
    if (!cronOk) return "Five fields: minute, hour, day, month, weekday.";
    const next = nextRun(cron.trim(), now);
    return `${capitalize(describeCron(cron.trim()))}${next !== null ? ` · next run ${runTime(next, now)}` : ""}`;
  }, [cron, cronOk, now]);

  const errors = {
    id: !id.trim()
      ? "Give the job an ID."
      : !ID_RE.test(id.trim())
        ? "Use letters, digits and hyphens."
        : null,
    cron: !cron.trim() ? "Set a timer." : !cronOk ? "Not a valid 5-field cron expression." : null,
    tool: tool ? null : "Pick an auditor.",
    devices: scope === "pick" && picked.length === 0 ? "Pick at least one device." : null,
    retain: Number(retain) >= 1 ? null : "Keep at least 1 day.",
  };
  const valid = Object.values(errors).every((e) => e === null);
  const shown = (e: string | null): string | null => (tried ? e : null);

  const save = async (): Promise<void> => {
    setTried(true);
    setSaveError(null);
    if (!valid) return;
    setBusy(true);
    try {
      const res = await postJson<{ job?: { id: string }; replaced?: boolean; error?: string }>(
        "/api/schedules",
        {
          id: id.trim(),
          cron: cron.trim(),
          tool,
          devices: scope === "all" ? "all" : picked,
          notifyOn,
          retainDays: Number(retain),
          enabled: true,
        },
      );
      if (res.error || !res.job) {
        setSaveError(res.error ?? "The server did not save the job.");
        return;
      }
      toast.success(res.replaced ? `Replaced ${res.job.id}` : `Saved ${res.job.id}`);
      onOpenChange(false);
      onSaved(res.job.id);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <MonitorDialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        onOpenChange(next);
      }}
      title="New scheduled audit"
      description="Pick an auditor and a timer. Each run is compared with the one before it."
      width={620}
      dismissible={false}
      closeDisabled={busy}
      footer={
        <>
          <span className="sched-dialog-foot-note">
            Runs on its own from the next match of the timer.
          </span>
          <MonitorButton variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </MonitorButton>
          <MonitorButton
            variant="primary"
            disabled={busy}
            icon={
              busy ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <Check aria-hidden="true" />
              )
            }
            onClick={() => void save()}
          >
            Save job
          </MonitorButton>
        </>
      }
    >
      <form
        className="monitor-dialog-body sched-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="sched-form-grid" data-cols="2">
          <Field
            label="Job ID"
            hint="Letters, digits and hyphens. An existing ID is replaced."
            error={shown(errors.id)}
          >
            <input
              className="monitor-input sched-mono"
              aria-label="Job ID"
              aria-invalid={!!shown(errors.id) || undefined}
              placeholder="nightly-firewall"
              value={id}
              onChange={(e) => setId(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field label="When" hint={cronHint} error={shown(errors.cron)}>
            <label className="monitor-input" aria-invalid={!!shown(errors.cron) || undefined}>
              <Clock aria-hidden="true" className="sched-field-icon" />
              <input
                className="sched-bare sched-mono"
                aria-label="When (cron)"
                placeholder="30 3 * * *"
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                spellCheck={false}
              />
            </label>
          </Field>
        </div>

        <Field
          label="Auditor"
          hint="Only READ auditors can be scheduled."
          error={shown(errors.tool)}
        >
          <div className="sched-auditors" role="radiogroup" aria-label="Auditor">
            {auditors.length === 0 ? (
              <span className="monitor-hint">The server lists no auditors.</span>
            ) : (
              auditors.map((a) => (
                <button
                  key={a.tool}
                  type="button"
                  role="radio"
                  aria-checked={tool === a.tool}
                  className="monitor-choice sched-auditor"
                  onClick={() => setTool(a.tool)}
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="sched-mono text-foreground truncate">{a.tool}</span>
                    <small>{a.summary}</small>
                  </span>
                  <RiskBadge risk="READ" />
                </button>
              ))
            )}
          </div>
        </Field>

        <div className="sched-form-grid" data-cols="devices">
          <Field label="Devices" error={shown(errors.devices)}>
            <div className="flex flex-col gap-2">
              <Segmented
                label="Devices"
                value={scope}
                onChange={setScope}
                options={[
                  { value: "all", label: "All devices" },
                  { value: "pick", label: "Pick devices" },
                ]}
              />
              {scope === "all" ? (
                <span className="monitor-hint">
                  {devices.length === 0
                    ? "Every device the server knows when the job runs."
                    : `${devices.length} device${devices.length === 1 ? "" : "s"} today: ${devices.join(", ")}`}
                </span>
              ) : (
                <div className="sched-picks" role="group" aria-label="Devices to audit">
                  {devices.map((d) => (
                    <label key={d} className="monitor-check">
                      <input
                        type="checkbox"
                        checked={picked.includes(d)}
                        onChange={(e) =>
                          setPicked(
                            e.target.checked ? [...picked, d] : picked.filter((x) => x !== d),
                          )
                        }
                      />
                      <span className="sched-mono">{d}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </Field>
          <Field label="Keep history" error={shown(errors.retain)}>
            <label className="monitor-input">
              <input
                className="sched-bare sched-retain"
                aria-label="Keep history, in days"
                inputMode="numeric"
                value={retain}
                onChange={(e) => setRetain(e.target.value.replace(/\D/g, ""))}
              />
              <span className="text-muted-foreground">days</span>
            </label>
          </Field>
        </div>

        <Field label="Alert on" hint="Unchanged findings stay quiet.">
          <div className="sched-notify" role="group" aria-label="Alert on">
            {NOTIFY.map((n) => (
              <label key={n.value} className="monitor-check">
                <input
                  type="checkbox"
                  checked={notifyOn.includes(n.value)}
                  onChange={(e) =>
                    setNotifyOn(
                      e.target.checked
                        ? [...notifyOn, n.value]
                        : notifyOn.filter((x) => x !== n.value),
                    )
                  }
                />
                <span>{n.label}</span>
              </label>
            ))}
          </div>
        </Field>

        {saveError && (
          <MonitorNote tone="bad" icon={<X aria-hidden="true" />} role="alert">
            {saveError}
          </MonitorNote>
        )}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </MonitorDialog>
  );
}
