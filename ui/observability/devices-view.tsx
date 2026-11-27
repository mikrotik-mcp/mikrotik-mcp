import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  PenLine,
  Plus,
  Power,
  RotateCw,
  Search,
  Server,
  SlidersHorizontal,
  Zap,
} from "lucide-react";
import { DetailList, RowDrawer, RowMenu, RowMore } from "./kit";
import type { RowAction, Tone as KitTone } from "./kit";
import { LoadingState } from "./loading-state";
import { ManagementPaths, PathLegend } from "./connectivity";
import {
  addressOf,
  PhoneRouterRow,
  RouterDetails,
  RouterRow,
  clockTime,
  deviceState,
  transportLine,
} from "./device-card";
import type { DeviceActions, DeviceBusy } from "./device-card";
import { SSHPoolPanel } from "./ssh-pool";
import { ConfigEditor } from "./config-editor";
import {
  Metric,
  MetricStrip,
  MonitorButton,
  MonitorEmpty,
  MonitorPanel,
  MonitorSearch,
  PageIntro,
  Segmented,
  formatMs,
  useStaggerIn,
} from "./monitoring-ui";
import { api } from "./api";
import { num } from "./format";
import { addDevice } from "../../src/config-device-draft";
import type { CapabilitiesJson, DevicesPayload, SSHPoolPayload } from "./types";

type DeviceFilter = "all" | "online" | "offline" | "pending" | "disabled";

const STATE_KIT: Record<ReturnType<typeof deviceState>, KitTone> = {
  online: "ok",
  offline: "bad",
  pending: "off",
  disabled: "off",
};

/** "edge-02 is offline", "edge-02 and lab-chr are offline", "3 routers are offline". */
function offlineLine(names: string[]): string {
  if (names.length === 1) return `${names[0]} is offline`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are offline`;
  return `${names.length} routers are offline`;
}

/** An average call as a KPI value and unit: 96 ms, 1.2 s. */
function msValue(ms: number): { value: string; unit: string } {
  if (ms < 1) return { value: "<1", unit: "ms" };
  if (ms < 1000) return { value: String(Math.round(ms)), unit: "ms" };
  const s = ms / 1000;
  return { value: String(s < 10 ? Math.round(s * 10) / 10 : Math.round(s)), unit: "s" };
}

/** The router fleet: management paths, the Routers table with details, and the SSH pool. */
export function DevicesView({
  payload,
  pulses,
  pool,
  capabilities,
  seed,
  onSeedConsumed,
  onReload,
  ...actions
}: DeviceActions & {
  payload: DevicesPayload | null;
  pulses: Record<string, number>;
  pool: SSHPoolPayload | null;
  capabilities: Record<string, CapabilitiesJson | null>;
  seed?: { name: string; body: Record<string, unknown> } | null;
  onSeedConsumed?: () => void;
  onReload?: () => void;
}): ReactNode {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<DeviceFilter>("all");
  // undefined: nothing chosen yet, so the first router is open; null: closed.
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  // The row drawer, by router name.
  const [drawer, setDrawer] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, DeviceBusy>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  type Request = { name?: string; add?: boolean; seed?: NonNullable<typeof seed> };
  const [request, setRequest] = useState<Request | null>(() => (seed ? { seed } : null));
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<{
    initial: Record<string, unknown>;
    original: Record<string, unknown>;
    selection?: { name: string; isNew: boolean };
  } | null>(null);
  const loading = !!request && !editor && !error;
  const openManager = (next: Request) => {
    setError(null);
    setRequest(next);
  };
  useEffect(() => {
    if (!request) return;
    const controller = new AbortController();
    void api<Record<string, unknown>>("/api/config", controller.signal)
      .then((original) => {
        if (controller.signal.aborted) return;
        let initial = original;
        let selection: { name: string; isNew: boolean } | undefined;
        const devices = (original.devices ?? {}) as Record<string, unknown>;
        if (request.seed) {
          // Discovery must never overwrite an existing router with the same name.
          let name = request.seed.name;
          for (let n = 2; Object.hasOwn(devices, name); n++) name = `${request.seed.name}-${n}`;
          initial = {
            ...original,
            devices: { ...devices, [name]: request.seed.body },
            defaultDevice: original.defaultDevice || name,
          };
          selection = { name, isNew: true };
        } else if (request.add) {
          const added = addDevice(original);
          initial = added.config;
          selection = { name: added.name, isNew: true };
        } else if (request.name) {
          if (!Object.hasOwn(devices, request.name))
            throw new Error("This router is no longer configured. Refresh the router list.");
          selection = { name: request.name, isNew: false };
        }
        setEditor({ initial, original, selection });
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "Could not load router settings.");
      });
    return () => controller.abort();
  }, [request]);

  const list = payload?.devices ?? [];
  const counts = {
    all: list.length,
    online: list.filter((d) => deviceState(d) === "online").length,
    offline: list.filter((d) => deviceState(d) === "offline").length,
    pending: list.filter((d) => deviceState(d) === "pending").length,
    disabled: list.filter((d) => d.disabled).length,
  };
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (payload?.devices ?? []).filter((d) => {
      if (filter !== "all" && deviceState(d) !== filter) return false;
      return (
        !q ||
        [
          d.name,
          addressOf(d, true),
          ...(d.endpoints?.hosts ?? []),
          d.address,
          d.host,
          d.mac,
          d.description,
          d.status.identity,
          d.status.boardName,
        ].some((value) => value?.toLowerCase().includes(q))
      );
    });
  }, [payload, query, filter]);
  const clear = () => {
    setQuery("");
    setFilter("all");
  };
  const selectedName = picked === undefined ? (list[0]?.name ?? null) : picked;
  const selected = shown.find((d) => d.name === selectedName) ?? null;
  const rowsRef = useRef<HTMLDivElement>(null);
  useStaggerIn(rowsRef, ".monitor-row", `${filter}|${query.trim()}|${list.length > 0}`);

  const runAction = async (name: string, kind: DeviceBusy) => {
    if (busy[name]) return;
    const action =
      kind === "test"
        ? actions.onTest
        : kind === "reconnect"
          ? actions.onReconnect
          : actions.onProbeCapabilities;
    if (!action) return;
    setBusy((b) => ({ ...b, [name]: kind }));
    setErrors(({ [name]: _old, ...rest }) => rest);
    try {
      await action(name);
    } catch {
      setErrors((e) => ({
        ...e,
        [name]: `Could not ${kind === "capabilities" ? "probe capabilities on" : kind} ${name}. Try again.`,
      }));
    } finally {
      setBusy(({ [name]: _done, ...rest }) => rest);
    }
  };

  const offline = list.filter((d) => deviceState(d) === "offline");
  const checked = list.map((d) => d.status.checkedAt ?? 0).filter((t) => t > 0);
  const lastCheck = checked.length ? Math.max(...checked) : null;
  const calls = list.reduce((n, d) => n + d.activity.calls, 0);
  const failed = list.reduce((n, d) => n + d.activity.errors, 0);
  const avg = calls
    ? list.reduce((n, d) => n + d.activity.avgMs * d.activity.calls, 0) / calls
    : null;
  const agg = pool?.aggregate;
  // The calls KPI trend: the fleet's recent call count at each device poll.
  const [trend, setTrend] = useState<{ from: DevicesPayload | null; values: number[] }>({
    from: null,
    values: [],
  });
  if (payload && payload !== trend.from)
    setTrend({ from: payload, values: [...trend.values, calls].slice(-12) });
  const callTrend = trend.values;

  const controls = (
    <>
      <MonitorButton
        className="dv-manage-btn"
        icon={<SlidersHorizontal aria-hidden="true" />}
        disabled={loading || !!editor}
        aria-pressed={!!editor && !editor.selection ? true : undefined}
        onClick={() => openManager({})}
      >
        {loading && !request?.add && !request?.seed ? "Loading settings…" : "Manage routers"}
      </MonitorButton>
      <MonitorButton
        className="dv-add-btn"
        variant="primary"
        icon={<Plus aria-hidden="true" />}
        disabled={loading || !!editor}
        onClick={() => openManager({ add: true })}
      >
        Add device
      </MonitorButton>
    </>
  );
  const offlineText = offline.length > 0 && offlineLine(offline.map((d) => d.name));
  const intro = (
    <PageIntro
      eyebrow={
        list.length ? (
          <>
            Devices<span className="max-sm:hidden"> · checks run every 30 s</span>
          </>
        ) : undefined
      }
      heading={
        list.length ? (
          <>
            {counts.online} of {counts.all - counts.disabled}{" "}
            <span className="max-sm:hidden">
              {counts.disabled ? "enabled routers " : "routers "}
            </span>
            reachable.
            {offlineText && (
              <>
                {" "}
                <em>{offlineText}.</em>
              </>
            )}
          </>
        ) : undefined
      }
      lead="Your routers, how MCP reaches them, how many probes each path loses, and what each one reported at its last check."
      actions={controls}
    />
  );
  const management = (
    <>
      {error && (
        <div className="monitor-note items-center" data-tone="bad" role="alert">
          <span className="flex-1">{error}</span>
          <MonitorButton size="sm" onClick={() => openManager({ ...request })}>
            Retry settings
          </MonitorButton>
        </div>
      )}
      {editor && (
        <ConfigEditor
          scope="devices"
          initial={editor.initial}
          original={editor.original}
          initialSelection={editor.selection}
          onClose={() => {
            setEditor(null);
            setRequest(null);
            onSeedConsumed?.();
          }}
          onReload={() => onReload?.()}
        />
      )}
    </>
  );

  if (!payload || !list.length)
    return (
      <section className="dv grid content-start gap-[18px]">
        {intro}
        {management}
        {!payload ? (
          <>
            <LoadingState label="Loading router list" layout="cards" />
            <MonitorEmpty icon={<Server />} title="Waiting for device data">
              The router list has not loaded yet. It refreshes every few seconds.
            </MonitorEmpty>
          </>
        ) : (
          <MonitorEmpty icon={<Server />} title="No routers yet">
            Add your first router to see its connection, resources and tool activity.
          </MonitorEmpty>
        )}
      </section>
    );

  const details = (phone: boolean) =>
    selected && (
      <RouterDetails
        d={selected}
        phone={phone}
        capabilities={capabilities[selected.name] ?? null}
        busy={busy[selected.name] ?? null}
        error={errors[selected.name] ?? null}
        onClose={() => setPicked(null)}
        onAction={(kind) => void runAction(selected.name, kind)}
        onToggle={actions.onToggle}
        onManage={editor || loading ? undefined : (name) => openManager({ name })}
        canTest={!!actions.onTest}
        canReconnect={!!actions.onReconnect}
        canProbe={!!actions.onProbeCapabilities}
      />
    );
  const filters: { value: DeviceFilter; label: string }[] = [
    { value: "all", label: `All ${counts.all}` },
    { value: "online", label: `Online ${counts.online}` },
    { value: "offline", label: `Offline ${counts.offline}` },
    { value: "pending", label: `Unchecked ${counts.pending}` },
    { value: "disabled", label: `Disabled ${counts.disabled}` },
  ];
  const checkedAt = lastCheck ? clockTime(lastCheck) : null;
  const avgMs = avg != null ? msValue(avg) : null;

  return (
    <section className="dv grid content-start gap-[18px]">
      {intro}
      {management}
      <div className="dv-overview contents">
        <MetricStrip label="Router metrics" minCell={150} className="dv-strip">
          <Metric
            label="Reachable"
            tone={counts.online ? "good" : "default"}
            value={
              <>
                {counts.online}
                <small>/{counts.all - counts.disabled}</small>
              </>
            }
            hint={counts.disabled ? `${counts.disabled} disabled` : "enabled routers"}
          />
          <Metric
            label="Offline"
            tone={offline.length ? "bad" : "default"}
            value={offline.length}
            hint={
              offline.length === 1 ? (
                <>
                  {offline[0].name}
                  {offline[0].status.error && (
                    <span className="max-sm:hidden"> · {offline[0].status.error}</span>
                  )}
                </>
              ) : offline.length ? (
                "routers not reachable"
              ) : (
                "none"
              )
            }
          />
          <div className="contents max-sm:hidden">
            <Metric
              label="Recent tool calls"
              value={num(calls)}
              hint={failed ? `${num(failed)} failed` : "no failures"}
              spark={callTrend}
            />
          </div>
          <div className="contents sm:hidden">
            <Metric
              label="Tool calls"
              value={num(calls)}
              hint={failed ? `${num(failed)} failed` : "no failures"}
            />
          </div>
          <div className="contents max-sm:hidden">
            <Metric
              label="Average call"
              value={
                avgMs ? (
                  <>
                    {avgMs.value}
                    <small>{avgMs.unit}</small>
                  </>
                ) : (
                  "—"
                )
              }
              hint="across all routers"
            />
          </div>
          <Metric
            label="SSH pool"
            value={
              agg ? (
                <>
                  {num(agg.totalConnections)}
                  <small>open</small>
                </>
              ) : (
                "—"
              )
            }
            hint={
              agg
                ? `${num(agg.totalBusy)} busy · ${num(agg.totalIdle)} idle`
                : pool?.enabled === false
                  ? "pooling off"
                  : "not reported"
            }
          />
        </MetricStrip>

        <MonitorPanel
          className="dv-paths-panel"
          title="How MCP reaches each router"
          description="Management path only, not your clients' traffic. A line lights up while a call runs, and turns amber when the path loses packets."
          extra={<PathLegend />}
        >
          <ManagementPaths devices={list} pulses={pulses} />
        </MonitorPanel>

        <MonitorPanel
          className="dv-routers"
          title="Routers"
          flush
          extra={
            <div className="dv-toolbar">
              <MonitorSearch
                className="dv-search"
                value={query}
                onChange={setQuery}
                label="Search devices"
                placeholder="Search name, address or hardware"
              />
              <Segmented
                className="dv-seg"
                label="Show"
                value={filter}
                options={filters}
                onChange={setFilter}
              />
            </div>
          }
        >
          <div ref={rowsRef}>
            {shown.length ? (
              <>
                <div className="min-w-0 max-sm:hidden">
                  <div className="monitor-thead dv-cols">
                    <span>Router</span>
                    <span>Address</span>
                    <span>CPU</span>
                    <span>Memory</span>
                    <span className="text-right">Latency</span>
                    <span className="text-right">Loss, last 30 probes</span>
                    <span className="text-right">Calls</span>
                  </div>
                  {shown.map((d) => {
                    const rowBusy = !!busy[d.name] || !!d.disabled;
                    const rowActions: RowAction[] = [];
                    if (actions.onTest)
                      rowActions.push({
                        label: "Test",
                        icon: <Zap aria-hidden="true" />,
                        disabled: rowBusy,
                        onSelect: () => void runAction(d.name, "test"),
                      });
                    if (actions.onReconnect && !d.mac)
                      rowActions.push({
                        label: "Reconnect",
                        icon: <RotateCw aria-hidden="true" />,
                        disabled: rowBusy,
                        onSelect: () => void runAction(d.name, "reconnect"),
                      });
                    if (!editor && !loading)
                      rowActions.push({
                        label: "Edit",
                        icon: <PenLine aria-hidden="true" />,
                        onSelect: () => openManager({ name: d.name }),
                      });
                    if (actions.onToggle)
                      rowActions.push({
                        label: d.disabled ? "Make available to MCP" : "Turn off for MCP",
                        icon: <Power aria-hidden="true" />,
                        danger: !d.disabled,
                        onSelect: () => actions.onToggle?.(d.name, !d.disabled),
                      });
                    return (
                      <RowMenu
                        key={d.name}
                        title={d.name}
                        sub={addressOf(d, true)}
                        onOpen={() => setDrawer(d.name)}
                        opens={[{ label: "Show full details", onSelect: () => setPicked(d.name) }]}
                        copies={[
                          { label: "Router name", value: d.name },
                          { label: d.mac ? "MAC address" : "Address", value: addressOf(d) },
                        ]}
                        row={d}
                        cells={{
                          name: {
                            value: d.name,
                            kind: "router",
                            open: { label: "Show full details", run: () => setPicked(d.name) },
                          },
                          address: { value: addressOf(d) },
                          latency: {
                            value:
                              d.status.latencyMs != null
                                ? `${Math.round(d.status.latencyMs)} ms`
                                : "",
                            kind: "duration",
                          },
                          calls: { value: String(d.activity.calls) },
                        }}
                        actions={rowActions}
                      >
                        <RouterRow
                          d={d}
                          capabilities={capabilities[d.name] ?? null}
                          selected={selected?.name === d.name}
                          onSelect={() => setPicked(d.name)}
                          more={<RowMore />}
                        />
                      </RowMenu>
                    );
                  })}
                  <div className="monitor-foot">
                    <span>
                      {checkedAt ? `Last check ${checkedAt} · ` : ""}checks run every 30 s
                    </span>
                    <span className="flex-1" />
                    <span>Select a router to see its details</span>
                  </div>
                </div>
                <div className="dv-cards sm:hidden">
                  {shown.map((d) => (
                    <PhoneRouterRow
                      key={d.name}
                      d={d}
                      capabilities={capabilities[d.name] ?? null}
                      selected={selected?.name === d.name}
                      onSelect={() => setPicked(d.name)}
                    />
                  ))}
                </div>
              </>
            ) : (
              <MonitorEmpty
                compact
                icon={<Search />}
                title="No routers match"
                action={
                  <MonitorButton size="sm" onClick={clear}>
                    Clear filters
                  </MonitorButton>
                }
              >
                Try another name, address or status.
              </MonitorEmpty>
            )}
          </div>
        </MonitorPanel>

        {shown.length > 0 && (
          <>
            <div className="min-w-0 max-sm:hidden">{details(false)}</div>
            <div className="min-w-0 sm:hidden">{details(true)}</div>
          </>
        )}

        {(() => {
          const at = shown.findIndex((d) => d.name === drawer);
          const d = at >= 0 ? shown[at]! : null;
          if (!d) return null;
          const state = deviceState(d);
          const rowBusy = !!busy[d.name] || !!d.disabled;
          const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v)}%`);
          return (
            <RowDrawer
              open
              onClose={() => setDrawer(null)}
              label={`Router row: ${d.name}`}
              status={{
                tone: STATE_KIT[state],
                label:
                  state === "pending"
                    ? "Unchecked"
                    : state === "disabled"
                      ? "Off for MCP"
                      : state === "online"
                        ? "Online"
                        : "Offline",
              }}
              title={d.name}
              meta={transportLine(d)}
              rowKey={d.name}
              nav={{
                index: at,
                total: shown.length,
                onPrev: at > 0 ? () => setDrawer(shown[at - 1]!.name) : undefined,
                onNext: at < shown.length - 1 ? () => setDrawer(shown[at + 1]!.name) : undefined,
              }}
              storageKey="devices"
              actions={
                <>
                  {actions.onTest && (
                    <MonitorButton
                      size="sm"
                      disabled={rowBusy}
                      onClick={() => void runAction(d.name, "test")}
                    >
                      {busy[d.name] === "test" ? "Testing…" : "Test"}
                    </MonitorButton>
                  )}
                  {actions.onReconnect && !d.mac && (
                    <MonitorButton
                      size="sm"
                      disabled={rowBusy}
                      onClick={() => void runAction(d.name, "reconnect")}
                    >
                      {busy[d.name] === "reconnect" ? "Reconnecting…" : "Reconnect"}
                    </MonitorButton>
                  )}
                </>
              }
              primary={
                <MonitorButton size="sm" variant="primary" onClick={() => setPicked(d.name)}>
                  Show full details
                </MonitorButton>
              }
            >
              {errors[d.name] && (
                <p role="alert" className="monitor-err">
                  {errors[d.name]}
                </p>
              )}
              <DetailList
                items={[
                  { label: "Router", value: d.name, mono: true },
                  { label: d.mac ? "MAC address" : "Address", value: addressOf(d), mono: true },
                  { label: "Path", value: transportLine(d) },
                  ...(d.status.identity
                    ? [{ label: "Identity", value: d.status.identity, mono: true }]
                    : []),
                  ...(d.status.boardName ? [{ label: "Hardware", value: d.status.boardName }] : []),
                  { label: "CPU", value: pct(d.status.cpuLoad) },
                  { label: "Memory", value: pct(d.status.memUsedPct) },
                  {
                    label: "Latency",
                    value:
                      d.status.latencyMs != null && state === "online"
                        ? formatMs(d.status.latencyMs)
                        : "—",
                    mono: true,
                  },
                  {
                    label: "Recent calls",
                    value: `${num(d.activity.calls)} · ${num(d.activity.errors)} failed`,
                  },
                  ...(d.status.checkedAt
                    ? [{ label: "Last check", value: clockTime(d.status.checkedAt) }]
                    : []),
                ]}
              />
            </RowDrawer>
          );
        })()}

        {/* Pool totals always describe the whole fleet, not the filtered table. */}
        <div className="min-w-0 max-sm:hidden">
          <SSHPoolPanel
            devices={list}
            poolPayload={pool}
            onSelectRouter={(name) => setPicked(name)}
          />
        </div>
      </div>
    </section>
  );
}
