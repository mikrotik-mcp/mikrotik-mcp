import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowRight,
  Check,
  CheckCheck,
  Clock3,
  Eye,
  Fingerprint,
  History,
  LockKeyhole,
  RefreshCw,
  Router,
  Search,
  ShieldCheck,
  ShieldOff,
  SlidersHorizontal,
  Terminal,
  Undo2,
  X,
} from "lucide-react";
import type { AccessConfig } from "../../src/config";
import type { AccessPreview, AccessSettings } from "../../src/observability/access-settings";
import { withToken } from "./api";
import { Badge, Button, Select } from "./geist";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { AccessToolPicker } from "./access-tool-picker";
import { cn } from "@/lib/utils";
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

function SectionTitle({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return (
    <header className="access-section-title">
      <span>{icon}</span>
      <div>
        <h3>{title}</h3>
        <p>{detail}</p>
      </div>
    </header>
  );
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
  const load = useCallback(async () => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setLoading(true);
    setError("");
    try {
      const next = await request<AccessSettings>("", undefined, controller.signal);
      if (!Array.isArray(next.tools) || !next.configured)
        throw new Error(
          "This server does not support access settings yet. Restart it with the updated build.",
        );
      if (alive.current && !controller.signal.aborted) accept(next);
    } catch (e) {
      if (alive.current && !controller.signal.aborted)
        setError(e instanceof Error ? e.message : "Access settings unavailable.");
    } finally {
      if (alive.current && !controller.signal.aborted) setLoading(false);
    }
  }, [accept]);
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

  useEffect(() => {
    setPreview(null);
    setPreviewError("");
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

  return (
    <div className="access-workspace">
      <section className="access-intro">
        <div className="access-intro-copy">
          <span className="access-eyebrow">
            <Fingerprint className="size-3.5" /> MCP permission boundary
          </span>
          <h2>
            Give your agent room.
            <br />
            <span>Keep the boundaries yours.</span>
          </h2>
          <p>
            Choose which routers and tools this server may use. Preview the decision, then safely
            apply your policy. No JSON required.
          </p>
        </div>
        <div className="access-current" aria-label="Current enforcement">
          <span className={cn("access-current-icon", data?.effective.enabled && "is-enforced")}>
            {data?.effective.enabled ? <ShieldCheck /> : <ShieldOff />}
          </span>
          <div>
            <span className="access-eyebrow">Applied right now</span>
            <strong>
              {!data
                ? loading
                  ? "Connecting…"
                  : "Status unavailable"
                : data.effective.enabled
                  ? "Access enforced"
                  : "Access scope off"}
            </strong>
            <p>
              {data
                ? data.narrowed
                  ? "Includes runtime session restrictions"
                  : "Operator-configured policy"
                : "Waiting for the server's policy"}
            </p>
          </div>
          <Button
            size="sm"
            ghost
            icon={<RefreshCw />}
            loading={loading}
            onClick={() => void load()}
            disabled={saving || (dirty && !error)}
            aria-label="Refresh access settings"
          />
        </div>
      </section>

      {error && (
        <div role="alert" className="access-message is-error">
          <ShieldOff className="size-4" />
          <div>
            {error}
            <p>
              Unsaved edits are not applied. If a save request timed out, refresh to verify its
              outcome.
            </p>
          </div>
          <Button
            size="sm"
            ghost
            onClick={() => {
              setReview(false);
              void load();
            }}
          >
            Reload saved policy
          </Button>
        </div>
      )}
      {notice && (
        <div role="status" className="access-message">
          <Check className="size-4" />
          <span>{notice}</span>
        </div>
      )}
      {!data && !error && (
        <div className="access-loading" role="status">
          <span />
          <span />
          <span />
          Loading permission settings…
        </div>
      )}

      {data && access && draft && (
        <>
          {pending && (
            <section className="access-pending" aria-label="Pending access change">
              <div className="access-countdown">
                <Clock3 />
                {pending.owned ? `${seconds}s` : "!"}
              </div>
              <div>
                <h3>
                  {pending.owned
                    ? "Your policy is applied, but not yet permanent."
                    : "A Config Studio change is awaiting confirmation."}
                </h3>
                <p>
                  {pending.owned
                    ? "Keep these settings to finish, or restore the previous configuration. The server handles auto-revert even if this tab closes."
                    : "Keep or revert that change in Config Studio, then refresh this page."}
                </p>
              </div>
              {pending.owned && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    icon={<CheckCheck />}
                    loading={saving}
                    onClick={() => void settle("keep")}
                    disabled={seconds === 0}
                  >
                    Keep changes
                  </Button>
                  <Button
                    ghost
                    icon={<Undo2 />}
                    disabled={saving || seconds === 0}
                    onClick={() => void settle("rollback")}
                  >
                    Revert now
                  </Button>
                </div>
              )}
            </section>
          )}
          <div className="access-layout">
            <div className="access-editor">
              <fieldset disabled={locked} className="access-card access-enforcement">
                <div className="access-switch-row">
                  <SectionTitle
                    icon={<SlidersHorizontal />}
                    title="Enforcement"
                    detail="The policy ceiling set by you, the operator."
                  />
                  <Switch
                    aria-label="Enable access enforcement"
                    checked={draft.enabled}
                    onCheckedChange={(enabled) => update({ enabled })}
                    disabled={locked}
                  />
                </div>
                <p className="access-hint">
                  {draft.enabled
                    ? "Rules below will be checked before each MCP tool call."
                    : "Rules are saved but inactive until enabled. Session restrictions and server read-only mode still apply."}
                </p>
                <label className="access-field">
                  <span>
                    Policy label <small>optional</small>
                  </span>
                  <Input
                    aria-label="Policy label"
                    value={draft.label ?? ""}
                    maxLength={200}
                    placeholder="e.g. Production maintenance"
                    onChange={(e) => update({ label: e.target.value || undefined })}
                  />
                </label>
                <label className="access-field">
                  <span>Maximum risk</span>
                  <Select
                    aria-label="Maximum risk"
                    value={draft.maxRisk ?? ""}
                    options={riskOptions}
                    onValueChange={(v) =>
                      update({ maxRisk: (v || undefined) as AccessConfig["maxRisk"] })
                    }
                  />
                </label>
                <div className="access-quick">
                  <span>Quick ceiling</span>
                  <Button
                    size="sm"
                    ghost
                    icon={<Eye />}
                    onClick={() => update({ enabled: true, maxRisk: "READ" })}
                  >
                    Read only
                  </Button>
                  <Button
                    size="sm"
                    ghost
                    icon={<SlidersHorizontal />}
                    onClick={() => update({ enabled: true, maxRisk: "WRITE" })}
                  >
                    Routine changes
                  </Button>
                </div>
                <p className="access-hint">
                  Idempotent writes share the WRITE ceiling: safe to retry does not mean read-only.
                  Quick ceilings preserve your device and tool rules.
                </p>
              </fieldset>

              <fieldset disabled={locked} className="access-card">
                <SectionTitle
                  icon={<Router />}
                  title="Router boundaries"
                  detail="Allow a group, carve out exceptions. Explicit blocks always win."
                />
                <Select
                  aria-label="Allowed router scope"
                  value={deviceMode}
                  options={[
                    { value: "all", label: "All configured routers" },
                    { value: "selected", label: "Only selected routers" },
                  ]}
                  onValueChange={setDeviceMode}
                />
                <div className="mt-3">
                  <Input
                    aria-label="Search routers"
                    placeholder="Find a configured router…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
                <div className="access-router-list">
                  {deviceNames
                    .filter((name) => name.toLowerCase().includes(query.toLowerCase()))
                    .map((name) => {
                      const configured = data.devices.find((d) => d.name === name);
                      const denied = draft.denyDevices.includes(name);
                      return (
                        <div key={name} className={cn("access-router", denied && "is-denied")}>
                          <span className="access-router-icon">
                            <Router />
                          </span>
                          <div className="min-w-0 flex-1">
                            <strong>{name}</strong>
                            <small>
                              {!configured
                                ? "No longer configured · remove from rules"
                                : configured.disabled
                                  ? "Disabled in server config"
                                  : denied
                                    ? "Explicitly blocked"
                                    : deviceMode === "all" || draft.devices.includes(name)
                                      ? "Inside allowed group"
                                      : "Outside allowed group"}
                            </small>
                          </div>
                          <div className="access-router-checks">
                            {deviceMode === "selected" && (
                              <label>
                                <Checkbox
                                  aria-label={`Allow ${name}`}
                                  checked={draft.devices.includes(name)}
                                  onCheckedChange={(v) => toggle("devices", name, v === true)}
                                  disabled={locked}
                                />
                                Allow
                              </label>
                            )}
                            <label>
                              <Checkbox
                                aria-label={`Block ${name}`}
                                checked={denied}
                                onCheckedChange={(v) => toggle("denyDevices", name, v === true)}
                                disabled={locked}
                              />
                              Block
                            </label>
                          </div>
                        </div>
                      );
                    })}
                  {!deviceNames.length && (
                    <p className="access-hint py-4">
                      No routers configured. Add devices in Config before defining router-specific
                      rules.
                    </p>
                  )}
                  {!!deviceNames.length &&
                    !deviceNames.some((n) => n.toLowerCase().includes(query.toLowerCase())) && (
                      <p className="access-hint py-4">No routers match this search.</p>
                    )}
                </div>
                {invalid && (
                  <p role="alert" className="access-validation">
                    {invalid}
                  </p>
                )}
                <p className="access-hint">
                  “All” includes future configured routers. Router state here comes from
                  configuration, not a connectivity check.
                </p>
              </fieldset>

              <fieldset disabled={locked} className="access-card">
                <SectionTitle
                  icon={<Terminal />}
                  title="Tool rules"
                  detail="Pick tools from the catalog, or add a * pattern that includes future matches."
                />
                <div className="access-rule-grid">
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
                <p className="access-hint">
                  Patterns match tool names, not commands or arguments. All matching is
                  case-insensitive. A risk ceiling also applies to tools on the allow-list.
                </p>
              </fieldset>
            </div>

            <aside className="access-inspector">
              <section className="access-card access-preview">
                <SectionTitle
                  icon={<Fingerprint />}
                  title="Permission lens"
                  detail="A decision preview, not a tool execution."
                />
                <div className="access-lens-label">
                  <Badge type={dirty ? "warning" : "secondary"}>
                    {dirty ? "Unsaved draft" : "Saved configuration"}
                  </Badge>
                  <span>+ session restrictions</span>
                </div>
                <label className="access-field">
                  <span>Preview target</span>
                  <Select
                    aria-label="Preview router"
                    value={probeDevice}
                    onValueChange={setProbeDevice}
                    options={[
                      { value: "", label: "Default router" },
                      ...data.devices.map((d) => ({
                        value: d.name,
                        label: `${d.name}${d.disabled ? " · disabled" : ""}`,
                      })),
                    ]}
                    disabled={saving}
                  />
                </label>
                <div className="access-gates" aria-label="Draft permission boundaries">
                  <div>
                    <Router />
                    <span>
                      Router boundary
                      <strong>
                        {access.devices.length
                          ? `${access.devices.length} selected`
                          : "All configured"}
                      </strong>
                    </span>
                    <small>{access.denyDevices.length} blocked</small>
                  </div>
                  <ArrowDown className="access-gate-link" />
                  <div>
                    <Terminal />
                    <span>
                      Tool boundary
                      <strong>
                        {access.tools.length
                          ? `${access.tools.length} allow patterns`
                          : "All tool names"}
                      </strong>
                    </span>
                    <small>{access.denyTools.length} exclusions</small>
                  </div>
                  <ArrowDown className="access-gate-link" />
                  <div>
                    <ShieldCheck />
                    <span>
                      Risk ceiling<strong>{access.maxRisk ?? "No ceiling"}</strong>
                    </span>
                    <small>{access.enabled ? "Enabled" : "Inactive"}</small>
                  </div>
                </div>
                <div className="access-impact" aria-live="polite">
                  <div>
                    <strong>{preview?.allowed ?? "—"}</strong>
                    <span>scope allows</span>
                  </div>
                  <div>
                    <strong>{preview?.blocked ?? "—"}</strong>
                    <span>scope blocks</span>
                  </div>
                </div>
                <p className="access-hint">
                  Across {data.tools.length} catalog tools for the preview target. No-device tools
                  ignore the router selection. Availability, approvals, tool arguments and device
                  capabilities are separate checks.
                </p>
                {preview && dirty && (
                  <div className="access-impact-diff">
                    <span>+{preview.newlyAllowed} newly allowed</span>
                    <span>−{preview.newlyBlocked} newly blocked</span>
                  </div>
                )}
                {previewError && (
                  <p role="alert" className="access-validation">
                    {previewError}
                  </p>
                )}
                <div className="access-probe">
                  <h4>
                    <Search className="size-3.5" /> Check a specific call
                  </h4>
                  <Input
                    aria-label="Search tool catalog"
                    value={toolQuery}
                    placeholder="Search tool names…"
                    onChange={(e) => setToolQuery(e.target.value)}
                  />
                  <Select
                    aria-label="Tool to check"
                    value={probeTool}
                    options={toolOptions}
                    onValueChange={setProbeTool}
                    disabled={!data.tools.length || saving}
                  />
                  <small className="access-hint">
                    {filteredTools.length > 80
                      ? "Showing the first 80 matches. Refine your search."
                      : `${filteredTools.length} matching tools`}
                  </small>
                  <div
                    className={cn(
                      "access-verdict",
                      preview?.check?.allowed ? "is-allowed" : preview?.check && "is-blocked",
                    )}
                    role="status"
                  >
                    {preview?.check ? (
                      <>
                        <span>{preview.check.allowed ? <Check /> : <LockKeyhole />}</span>
                        <div>
                          <strong>
                            {preview.check.allowed
                              ? "Within the access boundary"
                              : "This call would be blocked"}
                          </strong>
                          <p>
                            {preview.check.reason ??
                              "The scope permits this name, risk and target. No call was executed."}
                          </p>
                        </div>
                      </>
                    ) : (
                      <p>
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
              </section>
              <section className="access-card access-runtime">
                <h3>
                  <LockKeyhole className="size-4" /> Applied runtime layers
                </h3>
                <dl>
                  <div>
                    <dt>Operator policy</dt>
                    <dd>{data.configured.enabled ? "On" : "Off"}</dd>
                  </div>
                  <div>
                    <dt>Server read-only</dt>
                    <dd>{data.readOnly ? "On · writes unavailable" : "Off"}</dd>
                  </div>
                  <div>
                    <dt>Session narrowing</dt>
                    <dd>{data.narrowed ? "Active" : "None"}</dd>
                  </div>
                  <div>
                    <dt>Effective risk ceiling</dt>
                    <dd>{data.effective.enabled ? (scope?.maxRisk ?? "None") : "Inactive"}</dd>
                  </div>
                  <div>
                    <dt>Session expiry</dt>
                    <dd>
                      {scope?.expiresAt ? new Date(scope.expiresAt).toLocaleString() : "Not set"}
                    </dd>
                  </div>
                </dl>
                <details>
                  <summary>Inspect the effective scope</summary>
                  <dl>
                    <div>
                      <dt>Allowed routers</dt>
                      <dd>
                        {scope?.noDevices
                          ? "None · scopes do not overlap"
                          : scope?.devices?.join(", ") || "All configured"}
                      </dd>
                    </div>
                    <div>
                      <dt>Blocked routers</dt>
                      <dd>{scope?.denyDevices?.join(", ") || "None"}</dd>
                    </div>
                    <div>
                      <dt>Allowed tools</dt>
                      <dd>{scope?.tools?.join(", ") || "All"}</dd>
                    </div>
                    <div>
                      <dt>Blocked tools</dt>
                      <dd>{scope?.denyTools?.join(", ") || "None"}</dd>
                    </div>
                  </dl>
                  {!!scope?.toolAllowGroups?.length && (
                    <p className="access-hint">
                      Also must match each group:{" "}
                      {scope.toolAllowGroups.map((g) => `(${g.join(", ")})`).join(" AND ")}
                    </p>
                  )}
                </details>
                <p className="access-hint">
                  Changes affect this server process, not a login account. Runtime narrowing is
                  retained on save; it cannot be reset here. Expiry is set through{" "}
                  <code>narrow_access_scope</code>, not the base policy.
                </p>
              </section>
            </aside>
          </div>

          <footer className="access-savebar">
            <div>
              <span className={cn("access-save-dot", dirty && "is-dirty")} />
              <strong>{dirty ? "You have unapplied changes" : "No unapplied changes"}</strong>
              <small>Preview → apply → keep within 60 seconds</small>
            </div>
            <div className="flex gap-2">
              <Button
                ghost
                icon={<Undo2 />}
                disabled={!dirty || locked}
                onClick={() => {
                  accept(data);
                  setError("");
                  setNotice("");
                }}
              >
                Discard draft
              </Button>
              <Button
                icon={<ArrowRight />}
                disabled={!dirty || locked || !!invalid || !preview || !!previewError}
                onClick={() => {
                  setError("");
                  setReview(true);
                }}
              >
                Review changes
              </Button>
            </div>
          </footer>

          <section className="access-card access-audit">
            <SectionTitle
              icon={<History />}
              title="Blocked call history"
              detail="Recent real denials in this process. Preview checks never enter this history."
            />
            <Badge type="secondary">{data.denials.length} recent</Badge>
            {!data.denials.length ? (
              <div className="access-audit-empty">
                <ShieldCheck />
                <div>
                  <h4>No blocked calls recorded</h4>
                  <p>
                    {data.effective.enabled
                      ? "A call appears here only when it violates the active scope."
                      : "Access scope is off. Once enforced, rejected calls will appear here with the reason."}{" "}
                    History is in memory and resets on server restart.
                  </p>
                </div>
              </div>
            ) : (
              <div className="access-denials">
                {data.denials.map((d, i) => (
                  <article key={`${d.ts}-${i}`}>
                    <span className="access-denial-icon">
                      <X />
                    </span>
                    <div>
                      <strong>{d.tool}</strong>
                      <p>{d.reason}</p>
                      <small>
                        {d.device ?? "No device"} · {d.risk} · {d.rule}
                      </small>
                    </div>
                    <time dateTime={new Date(d.ts).toISOString()}>
                      {new Date(d.ts).toLocaleTimeString()}
                    </time>
                  </article>
                ))}
              </div>
            )}
          </section>

          <Dialog
            open={review}
            onOpenChange={(open) => {
              if (!saving) setReview(open);
            }}
          >
            <DialogContent
              className="sm:max-w-2xl max-h-[85svh] overflow-y-auto"
              showCloseButton={!saving}
            >
              <DialogHeader>
                <DialogTitle>Review access changes</DialogTitle>
                <DialogDescription>
                  These are MCP server permissions, not RouterOS settings. Changes apply to
                  subsequent calls in this process immediately.
                </DialogDescription>
              </DialogHeader>
              <div className="access-review-diff">
                {changes.map((key) => (
                  <div key={key}>
                    <strong>{key}</strong>
                    <del>{summarize(data.configured[key])}</del>
                    <ArrowRight />
                    <span>{summarize(access[key])}</span>
                  </div>
                ))}
              </div>
              {(!access.enabled || (preview?.newlyAllowed ?? 0) > 0) && (
                <div className="access-message is-warning">
                  <ShieldOff className="size-4" />
                  <p>
                    {!access.enabled
                      ? "You are switching off the operator's access policy. Saved rules will not restrict calls while it is off."
                      : `${preview?.newlyAllowed} catalog tools become newly allowed for this preview target.`}{" "}
                    Other targets may be affected too. Review every change above.
                  </p>
                </div>
              )}
              <p className="access-hint">
                A backup is created and a 60-second auto-revert timer starts. You must select Keep
                changes after applying. Existing session restrictions remain.
              </p>
              {!data.fromFile && (
                <p className="access-validation">
                  This process was not loaded from a config file. Settings are written to the
                  default config path, but future launches must use that file to retain them.
                </p>
              )}
              {error && (
                <p role="alert" className="access-validation">
                  {error}
                </p>
              )}
              <DialogFooter>
                <Button ghost disabled={saving} onClick={() => setReview(false)}>
                  Cancel
                </Button>
                <Button icon={<ShieldCheck />} loading={saving} onClick={() => void apply()}>
                  Apply for 60 seconds
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}
