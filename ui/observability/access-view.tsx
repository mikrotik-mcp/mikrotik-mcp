import { LoadingState } from "./loading-state";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Check,
  CheckCheck,
  ChevronRight,
  Clock3,
  Eye,
  Pencil,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  ShieldOff,
  Undo2,
  X,
} from "lucide-react";
import type { AccessConfig } from "../../src/config";
import type { AccessPreview, AccessSettings } from "../../src/observability/access-settings";
import { withToken } from "./api";
import {
  Metric,
  MetricStrip,
  MonitorButton,
  MonitorDialog,
  MonitorEmpty,
  MonitorNote,
  MonitorPanel,
  MonitorSearch,
  MonitorSelect,
  MonitorSwitch,
  PageIntro,
  RiskBadge,
  Ring,
  Segmented,
  StatusBadge,
  StatusDot,
} from "./monitoring-ui";
import type { Tone } from "./monitoring-ui";
import { AccessToolPicker } from "./access-tool-picker";
import { DetailList, RowDrawer, RowMenu, RowMore, TextInput } from "./kit";
import "./monitoring.css";
import "./access-view.css";

const ENDPOINT = "/api/access/settings";
const splitPatterns = (text: string) => [...new Set(text.split(/[\s,]+/).filter(Boolean))];
const riskOptions = [
  { value: "", label: "No risk ceiling" },
  { value: "READ", label: "Read only · inspect & diagnose" },
  { value: "WRITE", label: "Write · create & update" },
  { value: "WRITE_IDEMPOTENT", label: "Idempotent write · same write ceiling" },
  { value: "DESTRUCTIVE", label: "Destructive · includes removal" },
  { value: "DANGEROUS", label: "Dangerous · highest risk" },
];

/** Time-bounded, authenticated requests; failures are never rendered as an empty policy. */
async function request<T>(suffix: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(withToken(ENDPOINT + suffix), {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(12_000)])
      : AbortSignal.timeout(12_000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.error)
    throw new Error(
      data?.error ?? `Could not load access settings (${res.status}). Check the server and retry.`,
    );
  return data as T;
}

/** The operator configures the base policy; the running process keeps its own narrowing. */
export function AccessView(): ReactNode {
  const [data, setData] = useState<AccessSettings | null>(null);
  const [draft, setDraft] = useState<AccessConfig | null>(null);
  const [allowText, setAllowText] = useState("");
  const [denyText, setDenyText] = useState("");
  const [deviceMode, setDeviceMode] = useState("all");
  const [query, setQuery] = useState("");
  const [probeDevice, setProbeDevice] = useState("");
  const [probeTool, setProbeTool] = useState("");
  const [toolQuery, setToolQuery] = useState("");
  const [preview, setPreview] = useState<AccessPreview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [review, setReview] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [routerOpen, setRouterOpen] = useState<string>();
  const [denialOpen, setDenialOpen] = useState<number>();
  const alive = useRef(true);
  const loadController = useRef<AbortController | null>(null);
  const accept = useCallback((next: AccessSettings) => {
    setData(next);
    setDraft(next.configured);
    setAllowText(next.configured.tools.join("\n"));
    setDenyText(next.configured.denyTools.join("\n"));
    setDeviceMode(next.configured.devices.length ? "selected" : "all");
    setProbeDevice((prev) =>
      next.devices.some((d) => d.name === prev)
        ? prev
        : (next.devices.find((d) => !d.disabled)?.name ?? ""),
    );
    setProbeTool((prev) =>
      next.tools.some((t) => t.name === prev)
        ? prev
        : (next.tools.find((t) => t.risk === "READ")?.name ?? ""),
    );
    setPreview(null);
    setNow(Date.now());
  }, []);
  const load = useCallback(() => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    return request<AccessSettings>("", undefined, controller.signal)
      .then((next) => {
        if (!Array.isArray(next.tools) || !next.configured)
          throw new Error(
            "This server does not support access settings yet. Restart it with the updated build.",
          );
        if (alive.current && !controller.signal.aborted) {
          accept(next);
          setError("");
        }
      })
      .catch((e) => {
        if (alive.current && !controller.signal.aborted)
          setError(e instanceof Error ? e.message : "Access settings unavailable.");
      })
      .finally(() => {
        if (alive.current && !controller.signal.aborted) setLoading(false);
      });
  }, [accept]);
  const reload = () => {
    setLoading(true);
    setError("");
    void load();
  };
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      loadController.current?.abort();
    };
  }, [load]);

  const access = useMemo(
    () =>
      draft
        ? {
            ...draft,
            devices: deviceMode === "all" ? [] : draft.devices,
            tools: splitPatterns(allowText),
            denyTools: splitPatterns(denyText),
          }
        : null,
    [draft, deviceMode, allowText, denyText],
  );
  const dirty = !!data && !!access && JSON.stringify(access) !== JSON.stringify(data.configured);
  const invalid =
    deviceMode === "selected" && !draft?.devices.length
      ? "Choose at least one allowed router, or explicitly select All configured routers."
      : "";
  const pending = data?.pending;
  const locked = saving || loading || !!pending;

  useEffect(() => {
    if (!pending?.expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pending?.expiresAt]);
  const expiredId = useRef("");
  useEffect(() => {
    if (pending?.expiresAt && now >= pending.expiresAt && expiredId.current !== pending.id) {
      expiredId.current = pending.id;
      setNotice("Confirmation window ended. Reloading the server's current policy…");
      void load();
    }
  }, [pending, now, load]);

  const previewKey = JSON.stringify([
    data?.revision,
    access,
    invalid,
    pending,
    loading,
    probeDevice,
    probeTool,
  ]);
  const [lastPreviewKey, setLastPreviewKey] = useState(previewKey);
  if (lastPreviewKey !== previewKey) {
    setLastPreviewKey(previewKey);
    setPreview(null);
    setPreviewError("");
  }
  useEffect(() => {
    if (!data || !access || invalid || pending || loading) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void request<{ preview: AccessPreview }>(
        "/preview",
        {
          revision: data.revision,
          access,
          device: probeDevice || undefined,
          tool: probeTool || undefined,
        },
        controller.signal,
      )
        .then((r) => {
          if (!controller.signal.aborted) setPreview(r.preview);
        })
        .catch((e: unknown) => {
          if (!controller.signal.aborted)
            setPreviewError(e instanceof Error ? e.message : "Preview unavailable");
        });
    }, 300);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [data, access, invalid, pending, loading, probeDevice, probeTool]);

  const update = (patch: Partial<AccessConfig>) =>
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  const toggle = (key: "devices" | "denyDevices", name: string, enabled: boolean) => {
    if (!draft) return;
    update({
      [key]: enabled ? [...new Set([...draft[key], name])] : draft[key].filter((v) => v !== name),
    });
  };
  const apply = async () => {
    if (!data || !access || invalid) return;
    setSaving(true);
    setError("");
    try {
      const r = await request<{ settings: AccessSettings }>("/apply", {
        revision: data.revision,
        access,
      });
      if (alive.current) {
        accept(r.settings);
        setReview(false);
        setNotice(
          "Policy applied to subsequent calls. Keep it within 60 seconds or it will revert.",
        );
      }
    } catch (e) {
      if (alive.current)
        setError(
          e instanceof Error ? e.message : "Apply failed. Refresh to verify the current policy.",
        );
    } finally {
      if (alive.current) setSaving(false);
    }
  };
  const settle = async (action: "keep" | "rollback") => {
    if (!pending?.owned) return;
    setSaving(true);
    setError("");
    try {
      const r = await request<{ settings: AccessSettings }>(`/${action}`, {
        pendingId: pending.id,
      });
      if (alive.current) {
        accept(r.settings);
        setNotice(
          action === "keep"
            ? "Access settings saved. Router configuration was not changed."
            : "Previous access settings restored.",
        );
      }
    } catch (e) {
      if (alive.current)
        setError(
          e instanceof Error ? e.message : "Could not confirm the result. Refresh to verify.",
        );
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  const filteredTools =
    data?.tools.filter((t) => t.name.toLowerCase().includes(toolQuery.toLowerCase())) ?? [];
  const toolOptions = filteredTools.slice(0, 80).map((t) => ({ value: t.name, label: t.name }));
  if (probeTool && !toolOptions.some((t) => t.value === probeTool))
    toolOptions.unshift({ value: probeTool, label: probeTool });
  const deviceNames = [
    ...new Set([
      ...(data?.devices.map((d) => d.name) ?? []),
      ...(draft?.devices ?? []),
      ...(draft?.denyDevices ?? []),
    ]),
  ];
  const scope = data?.effective.scope;
  const seconds = Math.max(0, Math.ceil(((pending?.expiresAt ?? now) - now) / 1000));
  const summarize = (value: unknown) =>
    Array.isArray(value)
      ? value.join(", ") || "All / no exclusions"
      : typeof value === "boolean"
        ? value
          ? "On"
          : "Off"
        : typeof value === "string" && value
          ? value
          : "Not set";
  const changes =
    data && access
      ? (Object.keys(access) as (keyof AccessConfig)[]).filter(
          (key) => JSON.stringify(access[key]) !== JSON.stringify(data.configured[key]),
        )
      : [];

  const levels = ["READ", "WRITE", "WRITE_IDEMPOTENT", "DESTRUCTIVE", "DANGEROUS"];
  const ceiling = data?.effective.enabled ? scope?.maxRisk : undefined;
  const above = ceiling
    ? levels
        .slice(levels.indexOf(ceiling) + 1)
        .filter((l) => l !== "WRITE_IDEMPOTENT" || ceiling === "READ")
    : [];
  const configured = data?.devices ?? [];
  const inScope = configured.filter(
    (d) =>
      !d.disabled &&
      !(draft?.denyDevices ?? []).includes(d.name) &&
      (deviceMode === "all" || (draft?.devices ?? []).includes(d.name)),
  ).length;
  const blockedCount = configured.filter((d) => (draft?.denyDevices ?? []).includes(d.name)).length;
  const disabledNames = configured.filter((d) => d.disabled).map((d) => d.name);
  // Denials over the last hour in 12 five-minute buckets, for the KPI sparkline.
  const denialSpark = (() => {
    const list = data?.denials ?? [];
    if (!list.length) return undefined;
    const bucket = 5 * 60_000;
    const end = Math.max(now, ...list.map((d) => d.ts));
    const out = Array.from({ length: 12 }, () => 0);
    for (const d of list) {
      const i = 11 - Math.floor((end - d.ts) / bucket);
      if (i >= 0) out[i] += 1;
    }
    return out;
  })();
  const routerRows = deviceNames.filter((name) => name.toLowerCase().includes(query.toLowerCase()));
  const routerState = (
    name: string,
  ): { tone: Tone; state: string; denied: boolean; allowPressed: boolean; known: boolean } => {
    const device = data?.devices.find((d) => d.name === name);
    const denied = (draft?.denyDevices ?? []).includes(name);
    const listed = (draft?.devices ?? []).includes(name);
    const allowed = !denied && !device?.disabled && (deviceMode === "all" || listed);
    const tone: Tone = denied ? "bad" : allowed ? "good" : "default";
    const state = !device
      ? "No longer configured · remove from rules"
      : device.disabled
        ? "Disabled in server config"
        : denied
          ? "Explicitly blocked"
          : deviceMode === "all" || listed
            ? "Inside allowed group"
            : "Outside allowed group";
    const allowPressed =
      deviceMode === "selected" ? listed && !denied : !denied && !device?.disabled;
    return { tone, state, denied, allowPressed, known: !!device };
  };
  const allowRouter = (name: string): void => {
    const denied = (draft?.denyDevices ?? []).includes(name);
    if (denied) toggle("denyDevices", name, false);
    if (deviceMode === "selected")
      toggle("devices", name, denied || !(draft?.devices ?? []).includes(name));
  };
  const routerIndex = routerOpen === undefined ? -1 : routerRows.indexOf(routerOpen);
  const routerInfo = routerOpen === undefined ? undefined : routerState(routerOpen);
  const denialRow = denialOpen === undefined ? undefined : data?.denials[denialOpen];

  return (
    <div className="access-workspace flex min-w-0 flex-col gap-[18px]">
      <PageIntro
        eyebrow="MCP permission boundary"
        verdict={
          <>
            Give your agent room.
            <br />
            <span className="s">Keep the boundaries yours.</span>
          </>
        }
        lead="Choose which routers and tools this server may use. Preview the decision, then apply it with a 60-second safety window. No JSON needed."
        aside={
          <div className="glass access-current" aria-label="Current enforcement">
            <div className="flex items-center gap-2">
              <StatusDot
                tone={data ? (data.effective.enabled ? "good" : "default") : "warn"}
                pulse={!!data?.effective.enabled}
              />
              <b className="text-[13px] font-semibold text-foreground">
                {!data
                  ? loading
                    ? "Connecting…"
                    : "Status unavailable"
                  : data.effective.enabled
                    ? "Access enforced"
                    : "Access scope off"}
              </b>
              <span className="flex-1" />
              <MonitorButton
                size="sm"
                variant="ghost"
                icon={<RefreshCw aria-hidden="true" className={loading ? "animate-spin" : ""} />}
                onClick={reload}
                disabled={saving || (dirty && !error)}
                aria-label="Refresh access settings"
              />
            </div>
            <span className="monitor-hint">
              {data
                ? `${data.configured.label ? `${data.configured.label} · ` : ""}${
                    data.narrowed
                      ? "Includes runtime session restrictions"
                      : "Operator-configured policy"
                  }`
                : "Waiting for the server's policy"}
            </span>
          </div>
        }
      />

      {error && (
        <MonitorNote tone="bad" role="alert" icon={<ShieldOff aria-hidden="true" />}>
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              <b>{error}</b>
              <p className="monitor-hint mt-1">
                Unsaved edits are not applied. If a save request timed out, refresh to verify its
                outcome.
              </p>
            </div>
            <MonitorButton
              size="sm"
              onClick={() => {
                setReview(false);
                reload();
              }}
            >
              Reload saved policy
            </MonitorButton>
          </div>
        </MonitorNote>
      )}
      {notice && (
        <MonitorNote tone="good" role="status" icon={<Check aria-hidden="true" />}>
          {notice}
        </MonitorNote>
      )}
      {!data && !error && <LoadingState label="Loading permission settings" layout="form" />}

      {data && access && draft && (
        <>
          <MetricStrip label="Access summary" minCell={200}>
            <Metric
              label="Tools allowed"
              tone="good"
              value={
                <>
                  {preview?.allowed ?? "—"}
                  <small>/{data.tools.length}</small>
                </>
              }
              hint={`for ${probeDevice || "the default router"}`}
            />
            <Metric
              label="Routers in scope"
              value={
                <>
                  {inScope}
                  <small>/{configured.length}</small>
                </>
              }
              hint={
                [
                  blockedCount ? `${blockedCount} blocked` : "",
                  disabledNames.length
                    ? `${disabledNames.length === 1 ? disabledNames[0] : disabledNames.length} disabled`
                    : "",
                ]
                  .filter(Boolean)
                  .join(", ") || "No exceptions"
              }
            />
            <Metric
              label="Risk ceiling"
              tone={ceiling ? "warn" : "default"}
              value={data.effective.enabled ? (ceiling ?? "None") : "Off"}
              hint={above.length ? `${above.join(" and ")} blocked` : "No risk ceiling"}
            />
            <Metric
              label="Blocked calls"
              tone={data.denials.length ? "bad" : "default"}
              value={data.denials.length}
              hint="In this process, since restart"
              spark={denialSpark}
            />
          </MetricStrip>

          {pending && (
            <section className="access-pending" aria-label="Pending access change">
              {pending.owned ? (
                <Ring
                  value={(seconds / 60) * 100}
                  size={58}
                  stroke={5}
                  tone="warn"
                  label="Time left"
                  tip={{
                    title: "Safety window",
                    sub: "auto-revert",
                    led: "warn",
                    rows: [
                      { label: "Time left", value: `${seconds} s`, color: "var(--warning)" },
                      { label: "Window", value: "60 s" },
                    ],
                  }}
                >
                  {`${seconds}s`}
                </Ring>
              ) : (
                <Clock3 aria-hidden="true" className="size-6 text-warning" />
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
                <b className="text-[15px] text-foreground">
                  {pending.owned
                    ? "Your policy is applied, but not yet permanent."
                    : "A Config Studio change is awaiting confirmation."}
                </b>
                <span className="monitor-hint">
                  {pending.owned
                    ? "Keep these settings to finish, or restore the previous configuration. The server handles auto-revert even if this tab closes."
                    : "Keep or revert that change in Config Studio, then refresh this page."}
                </span>
              </div>
              {pending.owned && (
                <div className="flex flex-wrap gap-2">
                  <MonitorButton
                    icon={<Undo2 aria-hidden="true" />}
                    disabled={saving || seconds === 0}
                    onClick={() => void settle("rollback")}
                  >
                    Revert now
                  </MonitorButton>
                  <MonitorButton
                    variant="primary"
                    icon={<CheckCheck aria-hidden="true" />}
                    onClick={() => void settle("keep")}
                    disabled={saving || seconds === 0}
                  >
                    Keep changes
                  </MonitorButton>
                </div>
              )}
            </section>
          )}

          <div className="access-layout">
            <div className="flex min-w-0 flex-col gap-3.5">
              <MonitorPanel title="Enforcement" description="The ceiling you set as the operator.">
                <fieldset disabled={locked} className="access-fieldset">
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5">
                      <MonitorSwitch
                        label="Enable access enforcement"
                        checked={draft.enabled}
                        onChange={(enabled) => update({ enabled })}
                        disabled={locked}
                      />
                    </span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <b className="text-[13px] font-semibold text-foreground">
                        Enable access enforcement
                      </b>
                      <span className="monitor-hint">
                        {draft.enabled
                          ? "Rules below are checked before each MCP tool call."
                          : "Rules are saved but inactive until enabled. Session restrictions and server read-only mode still apply."}
                      </span>
                    </span>
                  </div>
                  <div className="grid gap-3.5 sm:grid-cols-2">
                    <label className="monitor-fl">
                      <span className="monitor-label">Policy label · optional</span>
                      <TextInput
                        label="Policy label"
                        value={draft.label ?? ""}
                        maxLength={200}
                        placeholder="e.g. Production maintenance"
                        onChange={(v) => update({ label: v || undefined })}
                      />
                    </label>
                    <div className="monitor-fl">
                      <span className="monitor-label">Maximum risk</span>
                      <span className="access-risk-select">
                        {draft.maxRisk && <RiskBadge risk={draft.maxRisk} short />}
                        <MonitorSelect
                          label="Maximum risk"
                          value={draft.maxRisk ?? ""}
                          options={riskOptions}
                          onChange={(v) =>
                            update({ maxRisk: (v || undefined) as AccessConfig["maxRisk"] })
                          }
                        />
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="monitor-label">Quick ceiling</span>
                    <MonitorButton
                      size="sm"
                      icon={<Eye aria-hidden="true" />}
                      onClick={() => update({ enabled: true, maxRisk: "READ" })}
                    >
                      Read only
                    </MonitorButton>
                    <MonitorButton
                      size="sm"
                      icon={<Pencil aria-hidden="true" />}
                      onClick={() => update({ enabled: true, maxRisk: "WRITE" })}
                    >
                      Routine changes
                    </MonitorButton>
                  </div>
                  <p className="monitor-hint">
                    Idempotent writes share the WRITE ceiling: safe to retry does not mean
                    read-only. Quick ceilings keep your router and tool rules.
                  </p>
                </fieldset>
              </MonitorPanel>

              <MonitorPanel
                title="Router boundaries"
                description="Allow a group, carve out exceptions. Explicit blocks always win."
              >
                <fieldset disabled={locked} className="access-fieldset gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Segmented
                      label="Allowed router scope"
                      value={deviceMode}
                      onChange={setDeviceMode}
                      options={[
                        { value: "all", label: "All configured routers" },
                        { value: "selected", label: "Only selected routers" },
                      ]}
                    />
                    <span className="flex-1" />
                    <MonitorSearch
                      className="w-full sm:w-60"
                      label="Search routers"
                      placeholder="Find a configured router…"
                      value={query}
                      onChange={setQuery}
                    />
                  </div>
                  <div className="access-router-list">
                    {routerRows.map((name) => {
                      const r = routerState(name);
                      return (
                        <RowMenu
                          key={name}
                          title={name}
                          sub={r.state}
                          onOpen={() => setRouterOpen(name)}
                          cells={{
                            router: { value: name, kind: "router", search: () => setQuery(name) },
                            state: { value: r.state },
                          }}
                          copies={[{ label: "Router name", value: name }]}
                          actions={
                            locked
                              ? []
                              : [
                                  { label: `Allow ${name}`, onSelect: () => allowRouter(name) },
                                  {
                                    label: `Block ${name}`,
                                    onSelect: () => toggle("denyDevices", name, !r.denied),
                                  },
                                ]
                          }
                        >
                          <div
                            className="access-router cursor-pointer"
                            data-tone={r.tone}
                            data-selected={routerOpen === name || undefined}
                            onClick={() => setRouterOpen(name)}
                          >
                            <span data-col="router" className="flex min-w-0 items-center gap-2.5">
                              <StatusDot tone={r.tone} />
                              <span className="truncate font-mono text-xs font-medium text-foreground">
                                {name}
                              </span>
                            </span>
                            <span
                              data-col="state"
                              className="access-router-state text-xs"
                              data-tone={r.tone}
                            >
                              {r.state}
                            </span>
                            <span
                              className="monitor-seg w-fit"
                              role="group"
                              aria-label={name}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <button
                                type="button"
                                className="monitor-seg-item"
                                aria-label={`Allow ${name}`}
                                aria-pressed={r.allowPressed}
                                disabled={locked}
                                onClick={() => allowRouter(name)}
                              >
                                Allow
                              </button>
                              <button
                                type="button"
                                className="monitor-seg-item"
                                aria-label={`Block ${name}`}
                                aria-pressed={r.denied}
                                disabled={locked}
                                onClick={() => toggle("denyDevices", name, !r.denied)}
                              >
                                Block
                              </button>
                            </span>
                            <RowMore />
                          </div>
                        </RowMenu>
                      );
                    })}
                    {!deviceNames.length && (
                      <p className="monitor-hint py-4">
                        No routers configured. Add devices in Config before defining router-specific
                        rules.
                      </p>
                    )}
                    {!!deviceNames.length && !routerRows.length && (
                      <p className="monitor-hint py-4">No routers match this search.</p>
                    )}
                  </div>
                  {invalid && (
                    <p role="alert" className="monitor-err">
                      {invalid}
                    </p>
                  )}
                  <p className="monitor-hint">
                    “All” includes routers you add later. Router state here comes from the config,
                    not a connectivity check.
                  </p>
                </fieldset>
              </MonitorPanel>

              <MonitorPanel
                title="Tool rules"
                description="Pick tools from the catalog, or add a * pattern that also covers future tools."
              >
                <fieldset disabled={locked} className="access-fieldset">
                  <div className="grid gap-3.5 md:grid-cols-2">
                    <AccessToolPicker
                      kind="allow"
                      values={access.tools}
                      tools={data.tools}
                      onChange={(values) => setAllowText(values.join("\n"))}
                      disabled={locked}
                    />
                    <AccessToolPicker
                      kind="block"
                      values={access.denyTools}
                      tools={data.tools}
                      onChange={(values) => setDenyText(values.join("\n"))}
                      disabled={locked}
                    />
                  </div>
                  <p className="monitor-hint">
                    Patterns match tool names, not commands or arguments, and ignore case. The risk
                    ceiling also applies to allowed tools.
                  </p>
                </fieldset>
              </MonitorPanel>
            </div>

            <div className="flex min-w-0 flex-col gap-3.5">
              <MonitorPanel title="Permission lens" description="A decision preview. Nothing runs.">
                <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-2">
                    <StatusBadge tone={dirty ? "warn" : "default"} dot={false}>
                      {dirty ? "Unsaved draft" : "Saved configuration"}
                    </StatusBadge>
                    <span className="monitor-hint">+ session restrictions</span>
                  </div>
                  <div className="monitor-fl access-fl-select">
                    <span className="monitor-label">Preview target</span>
                    <MonitorSelect
                      label="Preview router"
                      value={probeDevice}
                      onChange={setProbeDevice}
                      options={[
                        { value: "", label: "Default router" },
                        ...data.devices.map((d) => ({
                          value: d.name,
                          label: `${d.name}${d.disabled ? " · disabled" : ""}`,
                        })),
                      ]}
                    />
                  </div>
                  <div aria-label="Draft permission boundaries">
                    <Gate
                      icon={<Server aria-hidden="true" />}
                      title="Router boundary"
                      value={
                        access.devices.length
                          ? `${access.devices.length} selected`
                          : "All configured"
                      }
                      sub={`${access.denyDevices.length} blocked`}
                    />
                    <GateLink />
                    <Gate
                      icon={<Box aria-hidden="true" />}
                      title="Tool boundary"
                      value={
                        access.tools.length
                          ? `${access.tools.length} allow patterns`
                          : "All tool names"
                      }
                      sub={`${access.denyTools.length} exclusions`}
                    />
                    <GateLink />
                    <Gate
                      icon={<ShieldCheck aria-hidden="true" />}
                      title="Risk ceiling"
                      value={access.maxRisk ?? "No ceiling"}
                      sub={access.enabled ? "Enabled" : "Inactive"}
                      warn
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2" aria-live="polite">
                    <div className="glass access-impact">
                      <span className="text-success">{preview?.allowed ?? "—"}</span>
                      <span className="monitor-hint">scope allows</span>
                    </div>
                    <div className="glass access-impact">
                      <span className="text-destructive">{preview?.blocked ?? "—"}</span>
                      <span className="monitor-hint">scope blocks</span>
                    </div>
                  </div>
                  {preview && dirty && (
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge tone="good" dot={false}>
                        +{preview.newlyAllowed} newly allowed
                      </StatusBadge>
                      <StatusBadge tone="bad" dot={false}>
                        −{preview.newlyBlocked} newly blocked
                      </StatusBadge>
                    </div>
                  )}
                  <p className="monitor-hint">
                    Across {data.tools.length} catalog tools for the preview target. Approvals,
                    arguments and device capabilities are separate checks.
                  </p>
                  {previewError && (
                    <p role="alert" className="monitor-err">
                      {previewError}
                    </p>
                  )}
                  <div className="flex flex-col gap-2 border-t border-line pt-3">
                    <b className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
                      <Search aria-hidden="true" className="size-3.5" />
                      Check a specific call
                    </b>
                    <MonitorSearch
                      label="Search tool catalog"
                      placeholder="Search tool names…"
                      value={toolQuery}
                      onChange={setToolQuery}
                    />
                    <MonitorSelect
                      label="Tool to check"
                      value={probeTool}
                      options={toolOptions}
                      onChange={setProbeTool}
                    />
                    <span className="monitor-hint">
                      {filteredTools.length > 80
                        ? "Showing the first 80 matches. Refine your search."
                        : `${filteredTools.length} matching tools`}
                    </span>
                    <div role="status">
                      {preview?.check ? (
                        <MonitorNote
                          tone={preview.check.allowed ? "good" : "bad"}
                          icon={
                            preview.check.allowed ? (
                              <Check aria-hidden="true" />
                            ) : (
                              <X aria-hidden="true" />
                            )
                          }
                        >
                          <b>
                            {preview.check.allowed
                              ? "Within the access boundary."
                              : "This call would be blocked."}
                          </b>{" "}
                          {preview.check.reason ??
                            "The scope permits this name, risk and target. No call was run."}
                        </MonitorNote>
                      ) : (
                        <p className="monitor-hint">
                          {invalid
                            ? "Complete the router selection to preview."
                            : previewError
                              ? "Decision unavailable."
                              : pending
                                ? "Confirm or revert the pending change first."
                                : "Checking your draft…"}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              </MonitorPanel>
              <MonitorPanel
                title="Applied right now"
                description="Every layer that limits the next call."
              >
                <dl className="monitor-facts grid-cols-[150px_minmax(0,1fr)]">
                  <dt>Operator policy</dt>
                  <dd>
                    {data.configured.enabled ? (
                      <StatusBadge tone="good">Enforced</StatusBadge>
                    ) : (
                      "Off"
                    )}
                  </dd>
                  <dt>Server read-only</dt>
                  <dd>{data.readOnly ? "On · writes unavailable" : "Off"}</dd>
                  <dt>Session narrowing</dt>
                  <dd>
                    {data.narrowed ? (
                      <>
                        <span className="font-mono">narrow_access_scope</span> · active
                      </>
                    ) : (
                      "None"
                    )}
                  </dd>
                  <dt>Effective ceiling</dt>
                  <dd>
                    {data.effective.enabled ? (
                      scope?.maxRisk ? (
                        <RiskBadge risk={scope.maxRisk} />
                      ) : (
                        "None"
                      )
                    ) : (
                      "Inactive"
                    )}
                  </dd>
                  <dt>Session expiry</dt>
                  <dd>
                    {scope?.expiresAt ? new Date(scope.expiresAt).toLocaleString() : "Not set"}
                  </dd>
                  <dt>Allowed routers</dt>
                  <dd className="font-mono">
                    {scope?.noDevices
                      ? "None · scopes do not overlap"
                      : scope?.devices?.join(", ") || "All configured"}
                  </dd>
                  <dt>Blocked routers</dt>
                  <dd className="font-mono">{scope?.denyDevices?.join(", ") || "None"}</dd>
                </dl>
                <details className="access-details">
                  <summary>Allowed and blocked tools</summary>
                  <dl className="monitor-facts mt-2 grid-cols-[150px_minmax(0,1fr)]">
                    <dt>Allowed tools</dt>
                    <dd className="font-mono">{scope?.tools?.join(", ") || "All"}</dd>
                    <dt>Blocked tools</dt>
                    <dd className="font-mono">{scope?.denyTools?.join(", ") || "None"}</dd>
                  </dl>
                  {!!scope?.toolAllowGroups?.length && (
                    <p className="monitor-hint mt-2">
                      Also must match each group:{" "}
                      {scope.toolAllowGroups.map((g) => `(${g.join(", ")})`).join(" AND ")}
                    </p>
                  )}
                </details>
                <p className="monitor-hint mt-3">
                  Changes affect this server process, not a login account. Runtime narrowing is kept
                  on save; it cannot be reset here. Expiry is set through{" "}
                  <span className="font-mono">narrow_access_scope</span>, not the base policy.
                </p>
              </MonitorPanel>
            </div>
          </div>

          <section className="glass access-savebar" data-dirty={dirty || undefined}>
            <StatusDot tone={dirty ? "warn" : "default"} />
            <b className="text-[13px] text-foreground">
              {dirty ? "You have unapplied changes" : "No unapplied changes"}
            </b>
            <span className="monitor-hint">Preview → apply → keep within 60 seconds</span>
            <span className="flex-1" />
            <MonitorButton
              variant="ghost"
              disabled={!dirty || locked}
              onClick={() => {
                accept(data);
                setError("");
                setNotice("");
              }}
            >
              Discard draft
            </MonitorButton>
            <MonitorButton
              variant="primary"
              icon={<ChevronRight aria-hidden="true" />}
              disabled={!dirty || locked || !!invalid || !preview || !!previewError}
              onClick={() => {
                setError("");
                setReview(true);
              }}
            >
              Review changes
            </MonitorButton>
          </section>

          <MonitorPanel
            title="Blocked call history"
            description="Real denials in this process. Preview checks never land here. Resets on server restart."
            extra={<StatusBadge dot={false}>{data.denials.length} recent</StatusBadge>}
            flush
          >
            {!data.denials.length ? (
              <MonitorEmpty icon={<ShieldCheck />} title="No blocked calls recorded">
                {data.effective.enabled
                  ? "A call appears here only when it breaks the active scope."
                  : "Access scope is off. Once enforced, rejected calls show here with the reason."}{" "}
                History is in memory and resets on server restart.
              </MonitorEmpty>
            ) : (
              <div className="access-denials">
                <div className="monitor-thead access-denial-grid">
                  <span>Time</span>
                  <span>Tool</span>
                  <span>Reason</span>
                  <span>Router · risk · rule</span>
                  <span />
                </div>
                {data.denials.map((d, i) => (
                  <RowMenu
                    key={`${d.ts}-${i}`}
                    title={d.tool}
                    sub={`${clockTime(d.ts)} · ${d.device ?? "No device"} · ${d.rule}`}
                    onOpen={() => setDenialOpen(i)}
                    cells={{
                      time: { value: clockTime(d.ts), kind: "time" },
                      tool: { value: d.tool, kind: "tool" },
                      reason: { value: d.reason },
                      meta: d.device ? { value: d.device, kind: "router" } : { value: "" },
                    }}
                    copies={[
                      { label: "Tool", value: d.tool },
                      { label: "Reason", value: d.reason, hint: "" },
                    ]}
                    row={d}
                  >
                    <div
                      role="button"
                      tabIndex={0}
                      aria-label={`${d.tool} blocked at ${clockTime(d.ts)}`}
                      className="monitor-row access-denial-grid cursor-pointer"
                      data-failed
                      data-selected={denialOpen === i || undefined}
                      onClick={() => setDenialOpen(i)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setDenialOpen(i);
                        }
                      }}
                    >
                      <time
                        data-col="time"
                        className="font-mono text-xs text-muted-foreground"
                        dateTime={new Date(d.ts).toISOString()}
                      >
                        {clockTime(d.ts)}
                      </time>
                      <span data-col="tool" className="p truncate font-mono text-xs">
                        {d.tool}
                      </span>
                      <span data-col="reason" className="truncate text-destructive">
                        {d.reason}
                      </span>
                      <span
                        data-col="meta"
                        className="truncate font-mono text-xs text-muted-foreground"
                      >
                        {d.device ?? "No device"} · {d.risk} · {d.rule}
                      </span>
                      <RowMore />
                    </div>
                  </RowMenu>
                ))}
              </div>
            )}
          </MonitorPanel>

          <RowDrawer
            open={Boolean(denialRow)}
            onClose={() => setDenialOpen(undefined)}
            label={`Blocked call details: ${denialRow?.tool ?? ""}`}
            status={{ tone: "bad", label: "Blocked" }}
            title={denialRow?.tool ?? ""}
            meta={
              denialRow
                ? `${new Date(denialRow.ts).toLocaleString()} · ${denialRow.device ?? "No device"}`
                : undefined
            }
            nav={
              denialOpen !== undefined && denialRow
                ? {
                    index: denialOpen,
                    total: data.denials.length,
                    onPrev: denialOpen > 0 ? () => setDenialOpen(denialOpen - 1) : undefined,
                    onNext:
                      denialOpen < data.denials.length - 1
                        ? () => setDenialOpen(denialOpen + 1)
                        : undefined,
                  }
                : undefined
            }
            rowKey={denialRow ? `${denialRow.ts}-${denialOpen}` : undefined}
            storageKey="access-denials"
          >
            {denialRow && (
              <DetailList
                items={[
                  { label: "Time", value: new Date(denialRow.ts).toLocaleString(), mono: true },
                  { label: "Tool", value: denialRow.tool, mono: true },
                  { label: "Reason", value: denialRow.reason },
                  { label: "Router", value: denialRow.device ?? "No device", mono: true },
                  { label: "Risk", value: <RiskBadge risk={denialRow.risk} short /> },
                  { label: "Rule", value: denialRow.rule, mono: true },
                ]}
              />
            )}
          </RowDrawer>

          <RowDrawer
            open={Boolean(routerInfo)}
            onClose={() => setRouterOpen(undefined)}
            label={`Router details: ${routerOpen ?? ""}`}
            status={
              routerInfo
                ? {
                    tone:
                      routerInfo.tone === "bad" ? "bad" : routerInfo.tone === "good" ? "ok" : "off",
                    label: routerInfo.state,
                  }
                : undefined
            }
            title={routerOpen ?? ""}
            meta="Router state comes from the config, not a connectivity check."
            nav={
              routerIndex >= 0
                ? {
                    index: routerIndex,
                    total: routerRows.length,
                    onPrev:
                      routerIndex > 0
                        ? () => setRouterOpen(routerRows[routerIndex - 1])
                        : undefined,
                    onNext:
                      routerIndex < routerRows.length - 1
                        ? () => setRouterOpen(routerRows[routerIndex + 1])
                        : undefined,
                  }
                : undefined
            }
            rowKey={routerOpen}
            storageKey="access-routers"
            actions={
              routerOpen &&
              routerInfo && (
                <>
                  <MonitorButton
                    size="sm"
                    variant="ghost"
                    disabled={locked}
                    onClick={() => allowRouter(routerOpen)}
                  >
                    Allow
                  </MonitorButton>
                  <MonitorButton
                    size="sm"
                    variant="ghost"
                    disabled={locked}
                    onClick={() => toggle("denyDevices", routerOpen, !routerInfo.denied)}
                  >
                    {routerInfo.denied ? "Unblock" : "Block"}
                  </MonitorButton>
                </>
              )
            }
          >
            {routerOpen && routerInfo && (
              <DetailList
                items={[
                  { label: "Router", value: routerOpen, mono: true },
                  { label: "State", value: routerInfo.state },
                  { label: "In config", value: routerInfo.known ? "Yes" : "No" },
                  {
                    label: "Group",
                    value:
                      deviceMode === "all" ? "All configured routers" : "Only selected routers",
                  },
                  { label: "Blocked", value: routerInfo.denied ? "Yes" : "No" },
                ]}
              />
            )}
          </RowDrawer>

          <MonitorDialog
            open={review}
            onOpenChange={(open) => {
              if (!saving) setReview(open);
            }}
            width={640}
            closeDisabled={saving}
            title="Review access changes"
            description="These are MCP server permissions, not RouterOS settings. Changes apply to the next calls in this process right away."
            footer={
              <>
                <span className="flex-1" />
                <MonitorButton variant="ghost" disabled={saving} onClick={() => setReview(false)}>
                  Cancel
                </MonitorButton>
                <MonitorButton
                  variant="primary"
                  icon={<ShieldCheck aria-hidden="true" />}
                  disabled={saving}
                  onClick={() => void apply()}
                >
                  Apply for 60 seconds
                </MonitorButton>
              </>
            }
          >
            <div className="monitor-dialog-body flex flex-col gap-3.5">
              <div className="access-review-diff">
                {changes.map((key) => (
                  <div key={key}>
                    <b className="font-mono text-xs text-foreground">{key}</b>
                    <del>{summarize(data.configured[key])}</del>
                    <ChevronRight aria-hidden="true" />
                    <span>{summarize(access[key])}</span>
                  </div>
                ))}
              </div>
              {(!access.enabled || (preview?.newlyAllowed ?? 0) > 0) && (
                <MonitorNote tone="warn" icon={<ShieldOff aria-hidden="true" />}>
                  {!access.enabled
                    ? "You are switching off the operator's access policy. Saved rules will not restrict calls while it is off."
                    : `${preview?.newlyAllowed} catalog tools become newly allowed for this preview target.`}{" "}
                  Other targets may be affected too. Review every change above.
                </MonitorNote>
              )}
              <p className="monitor-hint">
                A backup is made and a 60-second auto-revert timer starts. Select Keep changes after
                applying. Existing session restrictions stay.
              </p>
              {!data.fromFile && (
                <p className="monitor-err">
                  This process was not loaded from a config file. Settings are written to the
                  default config path, but future launches must use that file to keep them.
                </p>
              )}
              {error && (
                <p role="alert" className="monitor-err">
                  {error}
                </p>
              )}
            </div>
          </MonitorDialog>
        </>
      )}
    </div>
  );
}

/** "14:02", the table's short time. */
function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function Gate({
  icon,
  title,
  value,
  sub,
  warn = false,
}: {
  icon: ReactNode;
  title: string;
  value: string;
  sub: string;
  warn?: boolean;
}): ReactNode {
  return (
    <div className="access-gate">
      <span className="access-gate-icon" data-warn={warn || undefined}>
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="monitor-hint">{title}</span>
        <b className="text-[13px] font-semibold text-foreground">{value}</b>
      </span>
      <span className="font-mono text-xs text-muted-foreground">{sub}</span>
    </div>
  );
}

function GateLink(): ReactNode {
  return (
    <div className="flex h-3.5 justify-center" aria-hidden="true">
      <span className="access-gate-link" />
    </div>
  );
}
