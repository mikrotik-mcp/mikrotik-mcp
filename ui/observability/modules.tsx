import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { api, postJson } from "./api";
import { Panel } from "./atoms";
import { Button, Input } from "./geist";
import { toast } from "./toast-action";

// ── Tool Modules view ────────────────────────────────────────────────────────
// Every catalog module with a live on/off toggle. Flipping one writes the
// config file's `tools` block (added to disabledModules / enabledModules) and
// applies it live; the MCP client must reconnect for the tool list to change.

interface ModuleItem {
  slug: string;
  label: string;
  group: string;
  description: string;
  toolCount: number;
  enabled: boolean;
  /** Devices already known to fail this module's requirements, with the reason. */
  unsupported?: { device: string; reason: string }[];
}
interface ConfigSource {
  path: string;
  fromFile: boolean;
}
interface ModuleSurface {
  modules: ModuleItem[];
  total: number;
  enabledModules: number;
  enabledTools: number;
  totalTools: number;
  hasAllowList: boolean;
  source?: ConfigSource;
  appViews?: boolean;
}
interface ToggleResult extends ModuleSurface {
  ok?: boolean;
  persisted?: boolean;
  warning?: string;
  error?: string;
}

/** The shared surface for a toggle row (module row or the app-views row). */
const rowClass = (on: boolean): string =>
  cn(
    "flex items-start gap-2.5 rounded-md border px-[11px] py-[9px] cursor-pointer select-none transition-colors",
    on ? "border-brand/50 bg-brand/10" : "border-border bg-card hover:border-brand/35",
  );

/** A single module row: checkbox + name/slug + tool count + scope description. */
function ModuleRow({
  m,
  busy,
  onToggle,
  unmet,
}: {
  m: ModuleItem;
  busy: boolean;
  onToggle: (slug: string, enabled: boolean) => void;
  /** Dim + explain when this module cannot run on the selected device. */
  unmet?: string;
}): ReactNode {
  return (
    <label
      className={cn(rowClass(m.enabled), unmet && "opacity-45")}
      title={unmet ? `Unavailable on the selected device: ${unmet}` : m.description}
    >
      <input
        type="checkbox"
        className="mt-0.5 cursor-pointer accent-brand"
        checked={m.enabled}
        disabled={busy}
        onChange={() => onToggle(m.slug, !m.enabled)}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-[7px] text-xs font-semibold text-foreground">
          {m.label}
          <code className="rounded border border-border bg-background px-[5px] py-px font-mono text-[10px] text-muted-foreground">
            {m.slug}
          </code>
        </span>
        <span className="text-[11px] leading-[1.35] text-muted-foreground">{m.description}</span>
        {unmet && (
          <span className="text-warning text-[10px] leading-[1.35]">unavailable here: {unmet}</span>
        )}
      </span>
      <span className="whitespace-nowrap pt-px font-mono text-[10px] text-muted-foreground">
        {m.toolCount} tool{m.toolCount === 1 ? "" : "s"}
      </span>
    </label>
  );
}

/** List every module grouped by scope, with per-module and bulk on/off toggles. */
export function ModulesView(): ReactNode {
  const [data, setData] = useState<ModuleSurface | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [appViews, setAppViews] = useState<boolean>(false);
  const [appViewsBusy, setAppViewsBusy] = useState(false);
  // Which device to judge module availability against. Empty = judge none, which
  // is the honest default: capabilities are per-device and may not be probed yet.
  const [capDevice, setCapDevice] = useState("");
  // Only devices that some module reports on are offerable — a device with no
  // resolved probe contributes no `unsupported` entries, so selecting it would
  // dim nothing and imply everything is supported.
  const capDevices = useMemo(
    () =>
      [
        ...new Set((data?.modules ?? []).flatMap((m) => m.unsupported?.map((u) => u.device) ?? [])),
      ].sort(),
    [data],
  );

  const load = useCallback(() => {
    void api<ModuleSurface>("/api/modules")
      .then((d) => {
        setData(d);
        if (d.appViews !== undefined) setAppViews(d.appViews);
      })
      .catch(() => setMsg("could not load modules"));
  }, []);
  useEffect(() => load(), [load]);

  // Apply a toggle result (or the initial load) into state, keeping the surface
  // counts and every module's enabled flag in sync with the server's answer.
  const adopt = (r: ModuleSurface): void => setData((prev) => (prev ? { ...prev, ...r } : r));

  const toggle = useCallback(
    async (slug: string, enabled: boolean): Promise<void> => {
      setBusy((s) => new Set(s).add(slug));
      // Optimistic flip so the checkbox responds instantly.
      setData((prev) =>
        prev
          ? { ...prev, modules: prev.modules.map((m) => (m.slug === slug ? { ...m, enabled } : m)) }
          : prev,
      );
      const r = await postJson<ToggleResult>("/api/modules/toggle", { slug, enabled }).catch(
        (): ToggleResult => ({ error: "request failed" }) as ToggleResult,
      );
      setBusy((s) => {
        const next = new Set(s);
        next.delete(slug);
        return next;
      });
      if (r.error || r.ok === false) {
        setMsg(r.error ?? "toggle failed");
        toast.error(r.error ?? "Toggle failed");
        load(); // resync from the server (undo the optimistic flip)
        return;
      }
      adopt(r);
      const where = r.persisted ? "saved to config" : "applied live (not saved)";
      const warn = r.warning ? ` ⚠ ${r.warning}` : "";
      setMsg(
        `${slug} ${enabled ? "enabled" : "disabled"} — ${where}. Reconnect the MCP client ` +
          `(or restart the server) for the tool list to update.${warn}`,
      );
      toast.success(`Module ${enabled ? "enabled" : "disabled"}`);
    },
    [load],
  );

  // Bulk enable/disable every module currently shown (respects the search filter)
  // by toggling each one whose state differs from the target — sequentially so
  // each write lands on the prior result's filter.
  const bulk = useCallback(
    async (slugs: string[], enabled: boolean): Promise<void> => {
      for (const slug of slugs) await toggle(slug, enabled);
    },
    [toggle],
  );

  const toggleAppViews = useCallback(async (enabled: boolean): Promise<void> => {
    setAppViewsBusy(true);
    setAppViews(enabled);
    const r = await postJson<{
      ok?: boolean;
      persisted?: boolean;
      warning?: string;
      error?: string;
      appViews?: boolean;
    }>("/api/modules/app-views", { enabled }).catch(() => ({ error: "request failed" }));
    setAppViewsBusy(false);
    if ("error" in r && r.error) {
      setMsg(r.error);
      toast.error(r.error);
      setAppViews(!enabled);
      return;
    }
    if ("appViews" in r && r.appViews !== undefined) setAppViews(r.appViews);
    const where = "persisted" in r && r.persisted ? "saved to config" : "applied live (not saved)";
    const warn = "warning" in r && r.warning ? ` — ${r.warning}` : "";
    setMsg(
      `App views ${enabled ? "enabled" : "disabled"} — ${where}. ` +
        `Restart the server for the change to take effect.${warn}`,
    );
    toast.success(`App Views ${enabled ? "enabled" : "disabled"}`);
  }, []);

  const groups = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    const match = (m: ModuleItem): boolean =>
      !q ||
      m.slug.toLowerCase().includes(q) ||
      m.label.toLowerCase().includes(q) ||
      m.group.toLowerCase().includes(q) ||
      m.description.toLowerCase().includes(q);
    const byGroup = new Map<string, ModuleItem[]>();
    for (const m of data.modules) {
      if (!match(m)) continue;
      const arr = byGroup.get(m.group) ?? [];
      arr.push(m);
      byGroup.set(m.group, arr);
    }
    return [...byGroup.entries()].map(([group, modules]) => ({ group, modules }));
  }, [data, query]);

  if (!data) return <div className="text-muted-foreground text-[11px]">loading modules…</div>;

  const shown = groups.reduce((n, g) => n + g.modules.length, 0);

  return (
    <section className="grid content-start gap-[18px]">
      <Panel
        title="Tool modules"
        className="reveal"
        extra={
          <div className="flex items-center gap-3">
            <span className="text-muted-foreground text-[11px]">
              {data.enabledModules}/{data.total} modules · {data.enabledTools}/{data.totalTools}{" "}
              tools exposed
            </span>
            <Button size="sm" ghost icon={<RefreshCw />} onClick={load}>
              Refresh
            </Button>
          </div>
        }
      >
        <label
          className={cn(rowClass(appViews), "mb-2.5")}
          title="Emit MCP App view metadata (_meta.ui) on read tools"
        >
          <input
            type="checkbox"
            className="mt-0.5 cursor-pointer accent-brand"
            checked={appViews}
            disabled={appViewsBusy}
            onChange={() => void toggleAppViews(!appViews)}
          />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-[7px] text-xs font-semibold text-foreground">
              MCP App Views
            </span>
            <span className="text-[11px] leading-[1.35] text-muted-foreground">
              When on, read tools emit interactive table/detail widgets via <code>_meta.ui</code>.
              Disable to keep the LLM context lean. Requires server restart.
            </span>
          </span>
        </label>

        <div className="mb-2.5 flex flex-wrap gap-3 font-mono text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-[5px]">
            writes to: <code>{data.source?.path ?? "config file"}</code>
          </span>
          <span className="inline-flex items-center gap-[5px]">
            {data.hasAllowList ? "allow-list active" : "all modules on by default"}
          </span>
        </div>

        <p className="mb-3 text-muted-foreground text-xs">
          Toggle a module to expose or hide all of its tools. Disabling adds it to{" "}
          <code>tools.disabledModules</code> in your config file; enabling removes it (or adds it to{" "}
          <code>tools.enabledModules</code> when an allow-list is in force). Trimming the surface
          below ~150–200 tools makes every remaining tool reliably findable by the MCP client. The
          client must reconnect for changes to take effect.
        </p>

        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <Input
            placeholder="Filter modules by name, slug, group or description…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {capDevices.length > 0 && (
            <select
              className="border-border bg-card text-muted-foreground h-8 rounded-md border px-2 text-[11px]"
              value={capDevice}
              onChange={(e) => setCapDevice(e.target.value)}
              title="Dim modules the selected device cannot run. Only devices whose capabilities have been probed appear here — probe one from the Devices page."
            >
              <option value="">availability: all devices</option>
              {capDevices.map((d) => (
                <option key={d} value={d}>
                  availability: {d}
                </option>
              ))}
            </select>
          )}
          <span className="flex-1" />
          <Button
            size="sm"
            onClick={() =>
              void bulk(
                data.modules.filter((m) => !m.enabled).map((m) => m.slug),
                true,
              )
            }
          >
            Enable all
          </Button>
          <Button
            size="sm"
            onClick={() =>
              void bulk(
                data.modules.filter((m) => m.enabled).map((m) => m.slug),
                false,
              )
            }
          >
            Disable all
          </Button>
        </div>

        {msg && <div className="mt-3 font-mono text-xs text-muted-foreground">{msg}</div>}

        {shown === 0 ? (
          <div className="p-3 text-muted-foreground text-[11px]">No modules match “{query}”.</div>
        ) : (
          <div className="mt-3 flex flex-col gap-[18px]">
            {groups.map(({ group, modules }) => {
              const on = modules.filter((m) => m.enabled).length;
              const slugs = modules.map((m) => m.slug);
              return (
                <div key={group}>
                  <div className="mb-2 flex items-center gap-2.5 border-b border-border pb-1.5">
                    <h3 className="m-0 text-[13px] font-semibold text-foreground">{group}</h3>
                    <span className="text-muted-foreground text-[11px]">
                      {on}/{modules.length} on
                    </span>
                    <span className="flex-1" />
                    <Button
                      size="sm"
                      onClick={() =>
                        void bulk(
                          slugs.filter((s) => {
                            const m = modules.find((x) => x.slug === s);
                            return m ? !m.enabled : false;
                          }),
                          true,
                        )
                      }
                    >
                      Enable group
                    </Button>
                    <Button
                      size="sm"
                      onClick={() =>
                        void bulk(
                          slugs.filter((s) => {
                            const m = modules.find((x) => x.slug === s);
                            return m ? m.enabled : false;
                          }),
                          false,
                        )
                      }
                    >
                      Disable group
                    </Button>
                  </div>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,360px),1fr))] gap-2">
                    {modules.map((m) => (
                      <ModuleRow
                        key={m.slug}
                        m={m}
                        busy={busy.has(m.slug)}
                        onToggle={(slug, enabled) => void toggle(slug, enabled)}
                        unmet={
                          capDevice
                            ? m.unsupported?.find((u) => u.device === capDevice)?.reason
                            : undefined
                        }
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Panel>
    </section>
  );
}
