import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  ArrowDown,
  CircleHelp,
  Network,
  Search,
  Server,
  WifiOff,
  Plus,
  Settings2,
  LoaderCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConnectivityGraph } from "./connectivity";
import { DeviceCard } from "./device-card";
import type { DeviceActions } from "./device-card";
import { SSHPoolPanel } from "./ssh-pool";
import { ConfigEditor } from "./config-editor";
import { api } from "./api";
import { addDevice } from "../../src/config-device-draft";
import type { CapabilitiesJson, DevicesPayload, SSHPoolPayload } from "./types";

type DeviceFilter = "all" | "online" | "offline" | "pending" | "disabled";

/** A cached fleet overview. Only the explicit per-device actions contact a router. */
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
            throw new Error("This router is no longer configured. Refresh the device directory.");
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
  const management = (
    <>
      {error && (
        <div className="devices-management-error" role="alert">
          <span>{error}</span>
          <Button variant="outline" size="sm" onClick={() => openManager({ ...request })}>
            Retry settings
          </Button>
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
  const controls = (
    <div className="fleet-brief__actions">
      <Button size="sm" disabled={loading || !!editor} onClick={() => openManager({ add: true })}>
        <Plus size={15} />
        Add device
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={loading || !!editor}
        onClick={() => openManager({})}
      >
        {loading ? <LoaderCircle size={15} className="animate-spin" /> : <Settings2 size={15} />}{" "}
        {loading ? "Loading settings…" : "Manage routers"}
      </Button>
    </div>
  );
  const list = payload?.devices ?? [];
  const counts = {
    all: list.length,
    online: list.filter((d) => d.status.reachable === true).length,
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

  if (!payload)
    return (
      <section className="devices-workspace">
        <section className="devices-empty" role="status">
          <Server aria-hidden="true" />
          <h2>Waiting for device data</h2>
          <p>The fleet has not loaded yet. Use Refresh data above to retry.</p>
          {controls}
        </section>
        {management}
      </section>
    );
  if (!list.length)
    return (
      <section className="devices-workspace">
        <section className="devices-empty">
          <Network aria-hidden="true" />
          <h2>Your fleet starts here</h2>
          <p>
            Add your first router here to see its connection, system resources and tool activity.
          </p>
          {controls}
        </section>
        {management}
      </section>
    );

  return (
    <section className="devices-workspace">
      <header className="fleet-brief">
        <div className="fleet-brief__intro">
          <span className="devices-eyebrow">
            <Network size={13} /> FLEET AT A GLANCE
          </span>
          <h2>
            Every router.
            <br />
            <span>One clear picture.</span>
          </h2>
          <p>
            Last known reachability, resources and connections.
            <br />
            Test a device when you need a fresh reading.
          </p>
          {controls}
          <a
            className="fleet-brief__link"
            href="#device-inventory"
            onClick={(e) => {
              e.preventDefault();
              document.getElementById("device-inventory")?.scrollIntoView({ block: "start" });
            }}
          >
            Explore {counts.all} devices <ArrowDown size={14} />
          </a>
        </div>
        <div className="fleet-brief__readings">
          <div className="fleet-brief__headline">
            <strong>
              {counts.online}
              <span> / {counts.all}</span>
            </strong>
            <span>
              routers reachable
              <br />
              at their last check
            </span>
          </div>
          <div
            className="fleet-availability"
            aria-label={`${counts.online} online, ${counts.offline} offline, ${counts.pending} awaiting a check`}
          >
            {(["online", "offline", "pending"] as const).map(
              (state) =>
                counts[state] > 0 && (
                  <span key={state} data-state={state} style={{ flex: counts[state] }} />
                ),
            )}
          </div>
          <div className="fleet-brief__counts">
            <span data-state="online">
              <Activity size={14} />
              <b>{counts.online}</b> Online
            </span>
            <span data-state="offline">
              <WifiOff size={14} />
              <b>{counts.offline}</b> Offline
            </span>
            <span>
              <CircleHelp size={14} />
              <b>{counts.pending}</b> Unchecked
            </span>
          </div>
          <p>
            {counts.disabled > 0
              ? `${counts.disabled} disabled in MCP · saved check results are retained.`
              : "Management reachability is separate from client internet access."}
          </p>
        </div>
      </header>
      {management}

      {/* Preserve the existing radar, its dimensions and its fleet-wide input. */}
      <details className="bg-card reveal rounded-lg border p-4" open={counts.all <= 8}>
        <summary className="cursor-pointer text-sm font-medium">
          Connectivity radar
          <span className="text-muted-foreground text-[11px]">
            {" "}
            · {counts.online} online · {counts.offline} offline · {counts.all} total
          </span>
        </summary>
        <ConnectivityGraph payload={payload} pulses={pulses} />
      </details>

      <section
        className="device-inventory"
        id="device-inventory"
        aria-labelledby="device-inventory-title"
      >
        <header className="device-inventory__heading">
          <div>
            <span className="devices-eyebrow">YOUR INFRASTRUCTURE</span>
            <h2 id="device-inventory-title">
              Device directory <span>{counts.all}</span>
            </h2>
          </div>
          <span className="devices-caption">Connection → resources → actions</span>
        </header>
        <div className="device-inventory__toolbar">
          <Input
            type="search"
            aria-label="Search devices"
            placeholder="Search name, address or hardware…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="device-filters" role="group" aria-label="Filter devices by status">
            {(
              [
                ["all", "All"],
                ["online", "Online"],
                ["offline", "Offline"],
                ["pending", "Unchecked"],
                ["disabled", "Disabled"],
              ] as const
            ).map(([value, label]) => (
              <Button
                key={value}
                size="sm"
                variant="ghost"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {label}
                <span>{counts[value]}</span>
              </Button>
            ))}
          </div>
        </div>
        <div className="device-inventory__count" role="status">
          {shown.length} of {counts.all} devices
          {(query || filter !== "all") && (
            <Button variant="ghost" size="xs" onClick={clear}>
              Clear filters
            </Button>
          )}
        </div>
        {shown.length ? (
          <div className="device-directory">
            {shown.map((d) => (
              <DeviceCard
                key={d.name}
                d={d}
                allNames={list.map((x) => x.name)}
                capabilities={capabilities[d.name] ?? null}
                {...actions}
                onManage={editor || loading ? undefined : (name) => openManager({ name })}
              />
            ))}
          </div>
        ) : (
          <div className="devices-empty">
            <Search aria-hidden="true" />
            <h3>No devices match</h3>
            <p>Try another name, address or status.</p>
            <Button variant="outline" size="sm" onClick={clear}>
              Clear filters
            </Button>
          </div>
        )}
      </section>

      {/* Pool totals always describe the whole fleet, not the filtered directory. */}
      <SSHPoolPanel devices={list} poolPayload={pool} />
    </section>
  );
}
