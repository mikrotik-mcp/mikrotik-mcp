/**
 * The "New alert rule" dialog, after the Mon-Alerts-RuleEditor board.
 *
 * Saves through POST /api/alerts/rules and checks a draft against the last day
 * of calls through POST /api/alerts/preview. The server validates both with
 * the same schema the config file uses.
 */
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { postJson } from "./api";
import { CHANNELS, parseDuration } from "../../src/alerts/model";
import type { Trigger } from "../../src/alerts/model";
import {
  MonitorButton,
  MonitorDialog,
  MonitorNote,
  MonitorSelect,
  Segmented,
} from "./monitoring-ui";
import { Checkbox, Field, MultiSelect, TextInput } from "./kit";
import { toast } from "./toast-action";
import { Check, Clock, Eye, Loader2, TriangleAlert, X } from "lucide-react";
import "./alerts.css";

type Severity = "low" | "medium" | "high" | "critical";
type Kind = "metric" | "event" | "absence";
type Result = "any" | "errors" | "ok";

const EVENTS = [
  "tool_call",
  "device_state",
  "drift",
  "rollout",
  "transaction",
  "policy",
  "audit",
  "attack",
] as const;
const METRICS = ["error_rate", "calls", "avg_duration_ms", "p95_duration_ms"] as const;
const ABSENCES = ["tool_call", "snapshot", "device_seen"] as const;
const RISKS = ["READ", "WRITE", "WRITE_IDEMPOTENT", "DESTRUCTIVE", "DANGEROUS"];
const ID_RE = /^[a-z0-9][a-z0-9-]*$/i;

/** A trigger as the one line a person can scan. */
export function describeTrigger(when: Trigger): string {
  if ("metric" in when) {
    const bound = when.above !== undefined ? `> ${String(when.above)}` : `< ${String(when.below)}`;
    return `${String(when.metric)} ${bound} over ${String(when.window)}${
      when.minCalls ? ` (min ${String(when.minCalls)} calls)` : ""
    }`;
  }
  if ("absence" in when) {
    const parts = [`no ${String(when.absence)} within ${String(when.within)}`];
    if (Array.isArray(when.device)) parts.push(`device ${when.device.join("/")}`);
    return parts.join(" · ");
  }
  const parts: string[] = [`on ${String(when.event)}`];
  if (when.to) parts[0] += ` → ${String(when.to)}`;
  if (Array.isArray(when.device)) parts.push(`device ${when.device.join("/")}`);
  if (Array.isArray(when.risk)) parts.push(`risk ${when.risk.join("/")}`);
  if (Array.isArray(when.tool)) parts.push(`tool ${when.tool.join("/")}`);
  if (when.isError !== undefined) parts.push(when.isError ? "errors only" : "successes only");
  return parts.join(" · ");
}

/** The board's chip field: values as removable chips, type and press Enter to add one. */
function ChipField({
  label,
  values,
  onChange,
  suggestions,
  placeholder,
  upper = false,
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  suggestions: string[];
  placeholder: string;
  upper?: boolean;
}): ReactNode {
  return (
    <MultiSelect
      label={label}
      value={values}
      onChange={(next) => onChange([...new Set(upper ? next.map((v) => v.toUpperCase()) : next)])}
      options={suggestions.map((s) => ({ value: s, label: s }))}
      placeholder={placeholder}
      allowCustom
    />
  );
}

interface Preview {
  key: string;
  fires: number;
  resolves: number;
  matched: number;
  sampled: number;
  hours: number;
  noHistory?: boolean;
  error?: string;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const times = (n: number): string => (n === 1 ? "once" : `${n} times`);

/** Mounted only while open, so every open starts from a clean form. */
export function AlertRuleEditor(props: Parameters<typeof AlertRuleEditorForm>[0]): ReactNode {
  return props.open ? <AlertRuleEditorForm {...props} /> : null;
}

function AlertRuleEditorForm({
  open,
  onOpenChange,
  channels,
  devices,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The configured channels, as /api/alerts reports them. */
  channels: Record<string, { configured: boolean }>;
  devices: string[];
  onSaved: (id: string) => void;
}): ReactNode {
  const [id, setId] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<Kind>("event");
  const [event, setEvent] = useState<(typeof EVENTS)[number]>("tool_call");
  const [to, setTo] = useState("");
  const [device, setDevice] = useState<string[]>([]);
  const [risk, setRisk] = useState<string[]>([]);
  const [result, setResult] = useState<Result>("any");
  const [metric, setMetric] = useState<(typeof METRICS)[number]>("error_rate");
  const [windowText, setWindowText] = useState("10m");
  const [bound, setBound] = useState<"above" | "below">("above");
  const [threshold, setThreshold] = useState("");
  const [minCalls, setMinCalls] = useState("");
  const [absence, setAbsence] = useState<(typeof ABSENCES)[number]>("snapshot");
  const [within, setWithin] = useState("24h");
  const [severity, setSeverity] = useState<Severity>("medium");
  const [holdFor, setHoldFor] = useState("");
  const [cooldown, setCooldown] = useState("15m");
  const [sendTo, setSendTo] = useState<string[]>([]);
  const [busy, setBusy] = useState<"preview" | "save" | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);

  const trigger = useMemo((): Trigger => {
    if (kind === "metric") {
      const n = Number(threshold);
      return {
        metric,
        window: windowText.trim(),
        ...(bound === "above" ? { above: n } : { below: n }),
        minCalls: Number(minCalls) || 0,
      };
    }
    if (kind === "absence") {
      return {
        absence,
        within: within.trim(),
        ...(device.length > 0 ? { device } : {}),
      };
    }
    return {
      event,
      ...(event !== "tool_call" && to.trim() ? { to: to.trim() } : {}),
      ...(device.length > 0 ? { device } : {}),
      ...(event === "tool_call" && risk.length > 0 ? { risk } : {}),
      ...(event === "tool_call" && result !== "any" ? { isError: result === "errors" } : {}),
    };
  }, [
    kind,
    metric,
    windowText,
    bound,
    threshold,
    minCalls,
    absence,
    within,
    device,
    event,
    to,
    risk,
    result,
  ]);

  const rule = useMemo(
    () => ({
      id: id.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      when: trigger,
      severity,
      channels: sendTo,
      ...(holdFor.trim() ? { for: holdFor.trim() } : {}),
      cooldown: cooldown.trim() || "15m",
      enabled: true,
    }),
    [id, description, trigger, severity, sendTo, holdFor, cooldown],
  );
  const ruleKey = JSON.stringify(rule);

  const errors = {
    id: !id.trim()
      ? "Give the rule an ID."
      : !ID_RE.test(id.trim())
        ? "Use letters, digits and hyphens."
        : null,
    threshold:
      kind === "metric" && (threshold.trim() === "" || !Number.isFinite(Number(threshold)))
        ? "Enter a number."
        : null,
    window:
      kind === "metric" && parseDuration(windowText) === null ? "Use 30s, 5m, 2h or 1d." : null,
    within: kind === "absence" && parseDuration(within) === null ? "Use 30s, 5m, 2h or 1d." : null,
    holdFor: holdFor.trim() && parseDuration(holdFor) === null ? "Use 30s, 5m, 2h or 1d." : null,
    cooldown: cooldown.trim() && parseDuration(cooldown) === null ? "Use 30s, 5m, 2h or 1d." : null,
    sendTo: sendTo.length === 0 ? "Pick at least one channel." : null,
  };
  const valid = Object.values(errors).every((e) => e === null);
  const shown = (e: string | null): string | null => (tried ? e : null);
  // The server replays stored tool calls only; other triggers would always say 0.
  const canPreview = kind === "event" && event === "tool_call";

  const runPreview = async (): Promise<void> => {
    setTried(true);
    if (!valid) return;
    setBusy("preview");
    try {
      const res = await postJson<Omit<Preview, "key">>("/api/alerts/preview?hours=24", rule);
      setPreview({ ...res, key: ruleKey });
    } catch (e) {
      setPreview({
        key: ruleKey,
        fires: 0,
        resolves: 0,
        matched: 0,
        sampled: 0,
        hours: 24,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(null);
    }
  };

  const save = async (): Promise<void> => {
    setTried(true);
    setSaveError(null);
    if (!valid) return;
    setBusy("save");
    try {
      const res = await postJson<{ ok?: boolean; id?: string; error?: string }>(
        "/api/alerts/rules",
        rule,
      );
      if (!res.ok) {
        setSaveError(res.error ?? "The server did not save the rule.");
        return;
      }
      toast.success(`Saved ${rule.id}. The server is checking it now.`);
      onOpenChange(false);
      onSaved(rule.id);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const current = preview?.key === ruleKey ? preview : null;
  const previewNote = current ? (
    current.error ? (
      <MonitorNote tone="bad" icon={<TriangleAlert aria-hidden="true" />} role="alert">
        Preview failed: {current.error}
      </MonitorNote>
    ) : current.noHistory ? (
      <MonitorNote tone="warn" icon={<TriangleAlert aria-hidden="true" />}>
        No stored calls to replay. Turn on the dashboard event store to preview rules.
      </MonitorNote>
    ) : (
      <MonitorNote tone="good" icon={<Check aria-hidden="true" />} role="status">
        <b>Would have fired {times(current.fires)}</b> and resolved {times(current.resolves)} in the
        last {current.hours} h. {plural(current.sampled, "call")} replayed, {current.matched}{" "}
        matched.
      </MonitorNote>
    )
  ) : null;

  // Configured channels first, in config order, then the ones not set up.
  const channelNames = [...new Set([...Object.keys(channels), ...CHANNELS])];

  return (
    <MonitorDialog
      open={open}
      onOpenChange={(next) => {
        if (busy === "save") return;
        onOpenChange(next);
      }}
      title="New alert rule"
      description="Say when to reach out and where. Check it against the last day of calls before you save."
      width={680}
      dismissible={false}
      closeDisabled={busy === "save"}
      footer={
        <>
          <span className="alerts-dialog-foot-note">
            The server starts checking it as soon as you save.
          </span>
          <MonitorButton
            variant="ghost"
            disabled={busy === "save"}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </MonitorButton>
          <MonitorButton
            disabled={busy !== null || !canPreview}
            title={canPreview ? undefined : "Preview replays tool calls only."}
            icon={
              busy === "preview" ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <Eye aria-hidden="true" />
              )
            }
            onClick={() => void runPreview()}
          >
            Preview 24 h
          </MonitorButton>
          <MonitorButton
            variant="primary"
            disabled={busy !== null}
            icon={
              busy === "save" ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <Check aria-hidden="true" />
              )
            }
            onClick={() => void save()}
          >
            Save rule
          </MonitorButton>
        </>
      }
    >
      <form
        className="monitor-dialog-body alerts-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="alerts-form-grid" data-cols="id">
          <Field label="Rule ID" help="Letters, digits and hyphens." error={shown(errors.id)}>
            <TextInput
              label="Rule ID"
              mono
              placeholder="lab-write-errors"
              value={id}
              onChange={setId}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field label="Description">
            <TextInput
              label="Description"
              placeholder="What it means, in a sentence"
              value={description}
              onChange={setDescription}
            />
          </Field>
        </div>

        <Field label="Trigger">
          <div className="alerts-kinds" role="radiogroup" aria-label="Trigger">
            {(
              [
                ["metric", "Metric", "Error rate, calls or latency over a window"],
                ["event", "Event", "A tool call, device state, drift, attack…"],
                ["absence", "Absence", "Something expected did not happen"],
              ] as const
            ).map(([value, title, text]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={kind === value}
                className="monitor-choice"
                onClick={() => setKind(value)}
              >
                <b className="font-semibold">{title}</b>
                <small>{text}</small>
              </button>
            ))}
          </div>
        </Field>

        {kind === "event" && (
          <div className="alerts-form-grid" data-cols="2">
            <Field label="Event">
              <span className="alerts-select">
                <MonitorSelect
                  label="Event"
                  value={event}
                  onChange={(v) => setEvent(v as (typeof EVENTS)[number])}
                  options={EVENTS.map((e) => ({ value: e, label: e }))}
                />
              </span>
            </Field>
            <Field label="Device">
              <ChipField
                label="Device"
                values={device}
                onChange={setDevice}
                suggestions={devices}
                placeholder="Any device"
              />
            </Field>
            {event === "tool_call" ? (
              <>
                <Field label="Risk">
                  <ChipField
                    label="Risk"
                    values={risk}
                    onChange={setRisk}
                    suggestions={RISKS}
                    placeholder="Any risk"
                    upper
                  />
                </Field>
                <Field label="Result">
                  <Segmented
                    label="Result"
                    value={result}
                    onChange={setResult}
                    options={[
                      { value: "any", label: "Any" },
                      { value: "errors", label: "Errors only" },
                      { value: "ok", label: "Successes only" },
                    ]}
                  />
                </Field>
              </>
            ) : (
              <Field
                label="State"
                help="For device_state the state entered, for drift detected or resolved."
              >
                <TextInput label="State" mono placeholder="Any" value={to} onChange={setTo} />
              </Field>
            )}
          </div>
        )}

        {kind === "metric" && (
          <div className="alerts-form-grid" data-cols="2">
            <Field label="Metric">
              <span className="alerts-select">
                <MonitorSelect
                  label="Metric"
                  value={metric}
                  onChange={(v) => setMetric(v as (typeof METRICS)[number])}
                  options={METRICS.map((m) => ({ value: m, label: m }))}
                />
              </span>
            </Field>
            <Field label="Window" error={shown(errors.window)}>
              <TextInput
                label="Window"
                mono
                icon={<Clock aria-hidden="true" />}
                placeholder="10m"
                value={windowText}
                onChange={setWindowText}
              />
            </Field>
            <Field label="Fire when" error={shown(errors.threshold)}>
              <span className="alerts-inline">
                <Segmented
                  label="Fire when"
                  value={bound}
                  onChange={setBound}
                  options={[
                    { value: "above", label: "Above" },
                    { value: "below", label: "Below" },
                  ]}
                />
                <TextInput
                  aria-label="Threshold"
                  mono
                  wrapClassName="min-w-0 flex-1"
                  inputMode="decimal"
                  placeholder="0.05"
                  value={threshold}
                  onChange={setThreshold}
                />
              </span>
            </Field>
            <Field label="Min calls" help="Stops one failure on an idle server from firing.">
              <TextInput
                label="Min calls"
                mono
                inputMode="numeric"
                placeholder="0"
                value={minCalls}
                onChange={(v) => setMinCalls(v.replace(/\D/g, ""))}
              />
            </Field>
          </div>
        )}

        {kind === "absence" && (
          <div className="alerts-form-grid" data-cols="2">
            <Field label="Missing">
              <span className="alerts-select">
                <MonitorSelect
                  label="Missing"
                  value={absence}
                  onChange={(v) => setAbsence(v as (typeof ABSENCES)[number])}
                  options={ABSENCES.map((a) => ({ value: a, label: a }))}
                />
              </span>
            </Field>
            <Field label="Within" error={shown(errors.within)}>
              <TextInput
                label="Within"
                mono
                icon={<Clock aria-hidden="true" />}
                placeholder="24h"
                value={within}
                onChange={setWithin}
              />
            </Field>
            <Field label="Device">
              <ChipField
                label="Device"
                values={device}
                onChange={setDevice}
                suggestions={devices}
                placeholder="Any device"
              />
            </Field>
          </div>
        )}

        <div className="alerts-form-grid" data-cols="sev">
          <Field label="Severity">
            <Segmented
              label="Severity"
              value={severity}
              onChange={setSeverity}
              options={(["low", "medium", "high", "critical"] as const).map((s) => ({
                value: s,
                label: s,
              }))}
            />
          </Field>
          <Field label="Hold for" help="Fire only if it lasts." error={shown(errors.holdFor)}>
            <TextInput
              label="Hold for"
              mono
              icon={<Clock aria-hidden="true" />}
              placeholder="0s"
              value={holdFor}
              onChange={setHoldFor}
            />
          </Field>
          <Field label="Cooldown" help="No repeat inside this." error={shown(errors.cooldown)}>
            <TextInput
              label="Cooldown"
              mono
              icon={<Clock aria-hidden="true" />}
              placeholder="15m"
              value={cooldown}
              onChange={setCooldown}
            />
          </Field>
        </div>

        <Field label="Send to" error={shown(errors.sendTo)}>
          <div className="alerts-send-to" role="group" aria-label="Send to">
            {channelNames.map((name) => {
              const ready = channels[name]?.configured === true;
              return (
                <Checkbox
                  key={name}
                  checked={sendTo.includes(name)}
                  onCheckedChange={(on) =>
                    setSendTo(on ? [...sendTo, name] : sendTo.filter((c) => c !== name))
                  }
                  label={
                    <span className={ready ? undefined : "text-muted-foreground"}>
                      {ready ? name : `${name} · not set up`}
                    </span>
                  }
                />
              );
            })}
          </div>
        </Field>

        <div className="monitor-pre">
          <span className="text-brand">when</span> {describeTrigger(trigger)}
        </div>

        {canPreview ? (
          previewNote
        ) : (
          <MonitorNote>
            Preview replays tool calls only, so it can't check this trigger.
          </MonitorNote>
        )}

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
