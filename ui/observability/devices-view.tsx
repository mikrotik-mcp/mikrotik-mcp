import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Plus, Search, Server } from "lucide-react";
import { LoadingState } from "./loading-state";
import { ManagementPaths } from "./connectivity";
import { PhoneRouterRow, RouterDetails, RouterRow, clockTime, deviceState } from "./device-card";
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

/** "edge-02 is offline", "edge-02 and lab-chr are offline", "3 routers are offline". */
function offlineLine(names: string[]): string {
  if (names.length === 1) return `${names[0]} is offline`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are offline`;
  return `${names.length} routers are offline`;
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
    offline: list.filter((d) => d.status.reachable === false).length,
    pending: list.filter((d) => d.status.reachable == null).length,
    disabled: list.filter((d) => d.disabled).length,
  };
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (payload?.devices ?? []).filter((d) => {
      if (filter === "online" && d.status.reachable !== true) return false;
      if (filter === "offline" && d.status.reachable !== false) return false;
      if (filter === "pending" && d.status.reachable != null) return false;
      if (filter === "disabled" && !d.disabled) return false;
      return (
        !q ||
        [
          d.name,
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

  const offline = list.filter((d) => d.status.reachable === false && !d.disabled);
  const checked = list.map((d) => d.status.checkedAt ?? 0).filter((t) => t > 0);
  const lastCheck = checked.length ? Math.max(...checked) : null;
  const calls = list.reduce((n, d) => n + d.activity.calls, 0);
  const failed = list.reduce((n, d) => n + d.activity.errors, 0);
  const avg = calls
    ? list.reduce((n, d) => n + d.activity.avgMs * d.activity.calls, 0) / calls
    : null;
  const agg = pool?.aggregate;

  const controls = (
    <>
      <MonitorButton
        size="sm"
        disabled={loading || !!editor}
        aria-pressed={!!editor && !editor.selection ? true : undefined}
        onClick={() => openManager({})}
      >
        {loading && !request?.add && !request?.seed ? "Loading settings…" : "Manage routers"}
      </MonitorButton>
      <MonitorButton
        size="sm"
        variant="inverse"
        icon={<Plus aria-hidden="true" />}
        disabled={loading || !!editor}
        onClick={() => openManager({ add: true })}
      >
        Add device
      </MonitorButton>
    </>
  );
  const intro = (
    <PageIntro
      tone={!list.length ? undefined : offline.length ? "warn" : counts.online ? "good" : "default"}
      title={
        list.length ? (
          <span>
            <b>
              {counts.online} of {counts.all} routers reachable
            </b>
            {offline.length > 0 && (
              <span className="max-sm:hidden"> · {offlineLine(offline.map((d) => d.name))}</span>
            )}
          </span>
        ) : undefined
      }
      controls={controls}
    >
      <span className={offline.length ? "max-sm:hidden" : undefined}>
        Your routers, how MCP reaches them, and what each one reported at its last check.
      </span>
      {offline.length > 0 && (
        <span className="sm:hidden">{offlineLine(offline.map((d) => d.name))}.</span>
      )}
    </PageIntro>
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
      <section className="dv grid content-start gap-6">
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

  return (
    <section className="dv grid content-start gap-6">
      {intro}
      {management}
      <div className="dv-overview contents">
        <MetricStrip label="Router metrics" minCell={170} className="dv-strip">
          <Metric
            label="Reachable"
            primary
            value={
              <>
                {counts.online}
                <span className="dv-of text-muted-foreground"> / {counts.all}</span>
              </>
            }
            hint="at the last check"
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
          <Metric
            label="Recent tool calls"
            value={num(calls)}
            hint={failed ? `${num(failed)} failed` : "no failures"}
          />
          <div className="dv-avg contents">
            <Metric
              label="Average call"
              value={avg != null ? formatMs(avg) : "—"}
              hint="across all routers"
            />
          </div>
          <Metric
            label="SSH pool"
            value={agg ? `${num(agg.totalConnections)} open` : "—"}
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
          description="Management path only, not your clients' traffic. A line lights up while a call runs."
          extra={
            <div className="text-muted-foreground flex flex-wrap gap-4 text-[12px]">
              <span className="inline-flex items-center gap-1.5">
                <span className="bg-chart-1 h-0.5 w-4" />
                Direct SSH
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="border-chart-1 w-4 border-t-2 border-dashed" />
                Through a jump host
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="dv-legend-dot w-4 border-t-2 border-dotted" />
                MAC-Telnet (layer 2)
              </span>
            </div>
          }
        >
          <ManagementPaths devices={list} pulses={pulses} />
        </MonitorPanel>

        <section className="monitor-panel dv-routers" aria-labelledby="dv-routers-title">
          <div className="dv-toolbar">
            <h2 id="dv-routers-title" className="mr-2 text-[14px] font-[590]">
              Routers
            </h2>
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
          <div ref={rowsRef} className="border-border border-t">
            {shown.length ? (
              <>
                <div className="min-w-0 overflow-x-auto max-sm:hidden">
                  <div className="monitor-thead dv-cols border-t-0">
                    <span>Router</span>
                    <span>Address</span>
                    <span>CPU</span>
                    <span>Memory</span>
                    <span className="text-right">Latency</span>
                    <span className="text-right">Calls</span>
                  </div>
                  {shown.map((d) => (
                    <RouterRow
                      key={d.name}
                      d={d}
                      capabilities={capabilities[d.name] ?? null}
                      selected={selected?.name === d.name}
                      onSelect={() => setPicked(d.name)}
                    />
                  ))}
                  <div className="monitor-row text-muted-foreground grid-cols-[1fr_auto] text-[12px]">
                    <span>
                      {lastCheck ? `Last check ${clockTime(lastCheck)} · ` : ""}checks run every 30
                      s
                    </span>
                  </div>
                </div>
                <div className="sm:hidden">
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
                <div className="max-sm:hidden">{details(false)}</div>
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
        </section>

        {shown.length > 0 && <div className="min-w-0 sm:hidden">{details(true)}</div>}

        {/* Pool totals always describe the whole fleet, not the filtered table. */}
        <SSHPoolPanel devices={list} poolPayload={pool} />
      </div>
    </section>
  );
}
