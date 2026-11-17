/**
 * Terminal page — RouterOS consoles in dockable panes.
 *
 * Panes split, resize, move, stack as tabs, float and maximise (dockview). Each
 * pane is one console on one router; several panes may share a router. The
 * drawer holds the command history and the favourites, and can run any of them
 * on any router.
 */
import type { DockviewApi, DockviewReadyEvent } from "dockview-react";
import { DockviewReact, themeAbyss } from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import {
  History,
  LayoutGrid,
  Play,
  Plus,
  Radio,
  Search,
  ShieldAlert,
  Star,
  TextCursorInput,
  Trash2,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api } from "./api";
import { loadHighlighter, staticSpans } from "./terminal-highlight";
import type { HistoryEntry, TerminalState } from "./terminal-lib";
import {
  cleanOutput,
  favoritesStore,
  layoutStorage,
  paneRegistry,
  paneStorage,
  terminalApi,
  workspace,
} from "./terminal-lib";
import { TerminalPane } from "./terminal-pane";
import { CompareDialog } from "./terminal-compare";
import { FindBar } from "./terminal-search";
import type { DevicesPayload } from "./types";
import "./terminal.css";

const components = { terminal: TerminalPane };

function Code({ text }: { text: string }): ReactNode {
  return (
    <code className="term-code">
      {staticSpans(text).map((line, row) => (
        // eslint-disable-next-line react/no-array-index-key -- lines have no identity
        <span key={row}>
          {row > 0 && "\n"}
          {line.map((span, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <span key={i} style={span.color ? { color: span.color } : undefined}>
              {span.text}
            </span>
          ))}
        </span>
      ))}
    </code>
  );
}

function ago(ts: number): string {
  const seconds = Math.round((Date.now() - ts) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

export function TerminalView(): ReactNode {
  const [state, setState] = useState<TerminalState | null>(null);
  const [devices, setDevices] = useState<DevicesPayload | null>(null);
  const [broadcast, setBroadcast] = useState(false);
  const [drawer, setDrawer] = useState<"history" | "favorites" | null>("history");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [query, setQuery] = useState("");
  const [filterDevice, setFilterDevice] = useState("");
  const [target, setTarget] = useState("active");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [armed, setArmed] = useState(false);
  const [finding, setFinding] = useState(false);
  /** Raised by Ctrl+F so an open find bar takes the focus again. */
  const [findFocus, setFindFocus] = useState(0);
  const [, setGrammarReady] = useState(false);
  const dock = useRef<DockviewApi | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const favorites = useSyncExternalStore(favoritesStore.subscribe, favoritesStore.get);
  const paneCount = useSyncExternalStore(paneRegistry.subscribe, () => paneRegistry.all().length);
  const starred = useMemo(() => new Set(favorites.map((f) => f.command)), [favorites]);

  useEffect(() => {
    void terminalApi
      .state()
      .then(setState)
      .catch(() =>
        setState({ enabled: false, reason: "The terminal API did not answer.", readOnly: false }),
      );
    void api<DevicesPayload>("/api/devices")
      .then(setDevices)
      .catch(() => {});
    void loadHighlighter().then(() => setGrammarReady(true));
    void favoritesStore.refresh();
  }, []);

  const names = useMemo(() => devices?.devices.map((d) => d.name) ?? [], [devices]);

  const refreshHistory = useCallback((): void => {
    terminalApi
      .history({ q: query || undefined, device: filterDevice || undefined })
      .then(setHistory)
      .catch(() => {});
  }, [query, filterDevice]);
  useEffect(() => {
    if (!state?.enabled) return;
    const timer = setTimeout(refreshHistory, 150);
    return () => clearTimeout(timer);
  }, [refreshHistory, state?.enabled]);
  useEffect(() => {
    workspace.onCommandDone = refreshHistory;
    return () => {
      workspace.onCommandDone = () => {};
    };
  }, [refreshHistory]);
  useEffect(() => {
    workspace.broadcast = broadcast;
    return () => {
      workspace.broadcast = false;
    };
  }, [broadcast]);

  // Ctrl/Cmd+K: search the history from anywhere on the page.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return;
      // Ctrl/Cmd+F: find in the terminals, in place of the browser's page search.
      if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        setFinding(true);
        setFindFocus((tick) => tick + 1);
        return;
      }
      if (event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      setDrawer((open) => open ?? "history");
      requestAnimationFrame(() => search.current?.focus());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const addPane = useCallback((device: string, direction: "right" | "below" = "right"): string => {
    const view = dock.current;
    if (!view) return "";
    const sameDevice = view.panels.filter(
      (p) => (p.params as { device?: string })?.device === device,
    );
    const id = `term-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const reference = view.activePanel;
    view.addPanel({
      id,
      component: "terminal",
      title: sameDevice.length ? `${device} · ${sameDevice.length + 1}` : device,
      params: { device },
      position: reference ? { referencePanel: reference.id, direction } : undefined,
    });
    return id;
  }, []);

  const onReady = useCallback(
    (event: DockviewReadyEvent): void => {
      dock.current = event.api;
      const saved = layoutStorage.load();
      let restored = false;
      if (saved) {
        try {
          event.api.fromJSON(saved as Parameters<DockviewApi["fromJSON"]>[0]);
          restored = event.api.panels.length > 0;
        } catch {
          event.api.clear();
          layoutStorage.clear();
        }
      }
      if (!restored && devices) addPane(devices.defaultDevice || devices.devices[0]?.name || "");
      event.api.onDidLayoutChange(() => layoutStorage.save(event.api.toJSON()));
      event.api.onDidRemovePanel((panel) => paneStorage.remove(panel.id));
    },
    [addPane, devices],
  );

  /** Run on the chosen target: the active pane, or a pane of the named router. */
  const runOn = useCallback(
    (command: string, mode: "run" | "insert", device = target): void => {
      const act = (id: string): boolean => {
        const pane = paneRegistry.get(id);
        if (!pane) return false;
        if (mode === "run") pane.run(command);
        else pane.insert(command);
        return true;
      };
      if (device === "active") {
        const pane = paneRegistry.get(workspace.activePane) ?? paneRegistry.all()[0];
        if (pane) act(pane.id);
        return;
      }
      const existing = paneRegistry.all().find((p) => p.device === device);
      if (existing) {
        act(existing.id);
        return;
      }
      // No pane for that router yet: open one, then run when it has mounted.
      const id = addPane(device);
      let tries = 0;
      const wait = setInterval(() => {
        if (act(id) || ++tries > 40) clearInterval(wait);
      }, 50);
    },
    [addPane, target],
  );

  if (!state || !devices) return <div className="term-page term-loading">Opening terminal…</div>;
  if (!state.enabled) {
    return (
      <div className="term-page">
        <div className="term-locked">
          <ShieldAlert size={28} />
          <h2>Terminal is locked</h2>
          <p>{state.reason}</p>
        </div>
      </div>
    );
  }

  const rows =
    drawer === "favorites"
      ? favorites
          .filter((f) => !query || f.command.toLowerCase().includes(query.toLowerCase()))
          .map((f) => ({ key: `f${f.id}`, command: f.command, favorite: f, entry: undefined }))
      : history.map((e) => ({
          key: `h${e.id}`,
          command: e.command,
          favorite: undefined,
          entry: e,
        }));

  return (
    <div className="term-page" data-drawer={drawer !== null}>
      <div className="term-toolbar">
        <div className="term-devices" role="group" aria-label="Open a terminal">
          <span className="term-toolbar-label">
            <Plus size={13} /> New terminal
          </span>
          {devices.devices.map((device) => (
            <button
              key={device.name}
              type="button"
              className="term-device"
              data-reachable={String(device.status.reachable)}
              onClick={() => addPane(device.name)}
              title={`Open a terminal on ${device.name} (${device.address ?? device.host})`}
            >
              <span className="term-dot" />
              {device.name}
              {device.status.latencyMs !== null && <small>{device.status.latencyMs} ms</small>}
            </button>
          ))}
        </div>
        <div className="term-tools">
          {state.readOnly && (
            <span className="term-badge" title="Only print, export and diagnostic commands run.">
              read-only server
            </span>
          )}
          <button
            type="button"
            onClick={() => names.forEach((name, i) => addPane(name, i % 2 ? "below" : "right"))}
            title="Open one terminal for every router"
          >
            <LayoutGrid size={14} /> All routers
          </button>
          <button
            type="button"
            data-on={broadcast}
            className="term-broadcast"
            onClick={() => setBroadcast((on) => !on)}
            title="Broadcast: a command typed in one pane also runs in every other open pane"
          >
            <Radio size={14} /> Broadcast {broadcast ? `· ${paneCount} panes` : "off"}
          </button>
          <button
            type="button"
            data-on={finding}
            onClick={() => setFinding((open) => !open)}
            title="Find in the terminals (Ctrl+F)"
          >
            <Search size={14} /> Find
          </button>
          <button
            type="button"
            data-on={drawer === "history"}
            onClick={() => setDrawer(drawer === "history" ? null : "history")}
            title="Command history (Ctrl+K)"
          >
            <History size={14} /> History
          </button>
          <button
            type="button"
            data-on={drawer === "favorites"}
            onClick={() => setDrawer(drawer === "favorites" ? null : "favorites")}
          >
            <Star size={14} /> Favourites{" "}
            {favorites.length > 0 && <small>{favorites.length}</small>}
          </button>
        </div>
      </div>

      <CompareDialog />
      {finding && <FindBar focus={findFocus} onClose={() => setFinding(false)} />}

      <div className="term-body">
        <div className="term-dock">
          <DockviewReact components={components} onReady={onReady} theme={themeAbyss} />
          {paneCount === 0 && (
            <div className="term-nopane">
              <p>No terminal is open.</p>
              <div>
                {names.map((name) => (
                  <button key={name} type="button" onClick={() => addPane(name)}>
                    <Plus size={13} /> {name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {drawer && (
          <aside
            className="term-drawer"
            aria-label={drawer === "history" ? "History" : "Favourites"}
          >
            <header>
              <strong>{drawer === "history" ? "Command history" : "Favourite commands"}</strong>
              <button type="button" onClick={() => setDrawer(null)} aria-label="Close">
                <X size={14} />
              </button>
            </header>
            <label className="term-search">
              <Search size={13} />
              <input
                ref={search}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search commands…"
                spellCheck={false}
              />
            </label>
            <div className="term-drawer-filters">
              {drawer === "history" && (
                <label>
                  From
                  <select value={filterDevice} onChange={(e) => setFilterDevice(e.target.value)}>
                    <option value="">all routers</option>
                    {names.map((name) => (
                      <option key={name}>{name}</option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                Run on
                <select value={target} onChange={(e) => setTarget(e.target.value)}>
                  <option value="active">active pane</option>
                  {names.map((name) => (
                    <option key={name}>{name}</option>
                  ))}
                </select>
              </label>
              {drawer === "history" && history.length > 0 && (
                <button
                  type="button"
                  className="term-clear"
                  title={
                    filterDevice ? `Delete the history of ${filterDevice}` : "Delete all history"
                  }
                  data-armed={armed}
                  onClick={() => {
                    // Two clicks: the first arms the button for three seconds.
                    if (!armed) {
                      setArmed(true);
                      setTimeout(() => setArmed(false), 3000);
                      return;
                    }
                    setArmed(false);
                    void terminalApi
                      .deleteHistory({ device: filterDevice || undefined })
                      .then(refreshHistory);
                  }}
                >
                  <Trash2 size={12} />
                  {armed && " click again to delete"}
                </button>
              )}
            </div>
            <ol className="term-rows">
              {rows.length === 0 && (
                <li className="term-rows-empty">
                  {drawer === "history"
                    ? "Nothing here yet. Commands you run appear in this list."
                    : "No favourites yet. Star a command to keep it here."}
                </li>
              )}
              {rows.map(({ key, command, entry, favorite }) => (
                <li key={key} data-ok={entry ? String(entry.ok) : undefined}>
                  <Code text={command} />
                  {entry && (
                    <div className="term-row-meta">
                      <span className="term-row-device">{entry.device}</span>
                      <span>{entry.ok ? `${entry.ms} ms` : "failed"}</span>
                      <span>{ago(entry.ts)}</span>
                    </div>
                  )}
                  <div className="term-row-actions">
                    <button
                      type="button"
                      onClick={() => runOn(command, "run")}
                      title="Run on the chosen target"
                    >
                      <Play size={12} /> Run
                    </button>
                    <button
                      type="button"
                      onClick={() => runOn(command, "insert")}
                      title="Put in the input to edit first"
                    >
                      <TextCursorInput size={12} /> Edit
                    </button>
                    <button
                      type="button"
                      data-on={starred.has(command)}
                      onClick={() => void favoritesStore.toggle(command)}
                      title={starred.has(command) ? "Remove from favourites" : "Add to favourites"}
                    >
                      <Star size={12} fill={starred.has(command) ? "currentColor" : "none"} />
                    </button>
                    {entry && (
                      <button
                        type="button"
                        onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}
                        title="Show the saved output"
                      >
                        output
                      </button>
                    )}
                    {entry && (
                      <button
                        type="button"
                        title="Delete this entry"
                        onClick={() =>
                          void terminalApi.deleteHistory({ id: entry.id }).then(refreshHistory)
                        }
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                    {favorite && (
                      <button
                        type="button"
                        title="Remove favourite"
                        onClick={() => void favoritesStore.toggle(command)}
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                  {entry && expanded === entry.id && (
                    <pre className="term-row-output">
                      {entry.error ?? (cleanOutput(entry.output).trimEnd() || "no output")}
                    </pre>
                  )}
                </li>
              ))}
            </ol>
          </aside>
        )}
      </div>
    </div>
  );
}
