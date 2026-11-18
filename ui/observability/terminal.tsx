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
  CalendarClock,
  History,
  LayoutGrid,
  PanelsTopLeft,
  Play,
  Plus,
  Radio,
  Search,
  ShieldAlert,
  Star,
  TextCursorInput,
  Trash2,
  Video,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Select } from "./geist";
import { api } from "./api";
import { loadHighlighter, staticSpans } from "./terminal-highlight";
import type {
  BroadcastGroup,
  BroadcastResult,
  BroadcastTarget,
  HistoryEntry,
  SavedWorkspace,
  TerminalState,
} from "./terminal-lib";
import {
  cleanOutput,
  favoritesStore,
  groupStorage,
  layoutStorage,
  paneRegistry,
  paneStorage,
  terminalApi,
  workspace,
  workspaceStorage,
} from "./terminal-lib";
import type { PaletteAction } from "./terminal-palette";
import { CommandPalette } from "./terminal-palette";
import { TerminalPane } from "./terminal-pane";
import { CompareDialog } from "./terminal-compare";
import { RecordingsDialog } from "./terminal-recordings";
import { ScheduleDrawer } from "./terminal-schedules";
import { ScriptDialog } from "./terminal-script";
import { FindBar } from "./terminal-search";
import { SharedView } from "./terminal-shared";
import { ShellPane } from "./terminal-shell-pane";
import { PaneTab } from "./terminal-tab";
import type { DevicesPayload } from "./types";
import "./terminal.css";

const components = { terminal: TerminalPane, shell: ShellPane };

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

/** The page, or a shared read-only view when the URL carries `?share=<id>`. */
export function TerminalView(): ReactNode {
  const share = new URLSearchParams(location.search).get("share");
  return share ? <SharedView id={share} /> : <TerminalWorkspace />;
}

function TerminalWorkspace(): ReactNode {
  const [state, setState] = useState<TerminalState | null>(null);
  const [devices, setDevices] = useState<DevicesPayload | null>(null);
  const [broadcast, setBroadcast] = useState<BroadcastTarget | null>(null);
  const [groups, setGroups] = useState<BroadcastGroup[]>(groupStorage.load);
  const [draft, setDraft] = useState<{ name: string; devices: string[] } | null>(null);
  const [saved, setSaved] = useState<SavedWorkspace[]>(workspaceStorage.load);
  const [workspaceName, setWorkspaceName] = useState("");
  /** True while one layout replaces another: closed panes then keep their blocks. */
  const switching = useRef(false);
  const [sent, setSent] = useState<{ command: string; results: BroadcastResult[] } | null>(null);
  const [drawer, setDrawer] = useState<"history" | "favorites" | "scheduled" | null>("history");
  const [scheduleDraft, setScheduleDraft] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [query, setQuery] = useState("");
  const [filterDevice, setFilterDevice] = useState("");
  const [target, setTarget] = useState("active");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [armed, setArmed] = useState(false);
  const [finding, setFinding] = useState(false);
  const [palette, setPalette] = useState(false);
  const [recordings, setRecordings] = useState(false);
  /** What "New terminal" opens: command blocks, or an interactive shell. */
  const [kind, setKind] = useState<"terminal" | "shell">("terminal");
  const kindRef = useRef(kind);
  kindRef.current = kind;
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
    workspace.onBroadcastDone = (command, results) => setSent({ command, results });
    workspace.onSchedule = (command) => {
      setScheduleDraft(command);
      setDrawer("scheduled");
    };
    return () => {
      workspace.broadcast = null;
      workspace.onBroadcastDone = () => {};
    };
  }, [broadcast]);

  // Ctrl/Cmd+K: search the history from anywhere on the page.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return;
      // Ctrl/Cmd+Shift+P: the command palette.
      if (event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setPalette((open) => !open);
        return;
      }
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
      component: kindRef.current,
      title:
        (sameDevice.length ? `${device} · ${sameDevice.length + 1}` : device) +
        (kindRef.current === "shell" ? " (shell)" : ""),
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
      event.api.onDidRemovePanel((panel) => {
        if (!switching.current) paneStorage.remove(panel.id);
      });
    },
    [addPane, devices],
  );

  const openWorkspace = (item: SavedWorkspace): void => {
    const view = dock.current;
    if (!view) return;
    switching.current = true;
    try {
      view.clear();
      view.fromJSON(item.layout as Parameters<DockviewApi["fromJSON"]>[0]);
    } catch {
      view.clear();
    } finally {
      switching.current = false;
    }
  };
  const saveWorkspace = (): void => {
    const name = workspaceName.trim();
    const view = dock.current;
    if (!name || !view) return;
    const next = [...saved.filter((w) => w.name !== name), { name, layout: view.toJSON() }];
    setSaved(next);
    workspaceStorage.save(next);
    setWorkspaceName("");
  };

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

  /** Everything the page can do, for the command palette. */
  const paletteActions = (): PaletteAction[] => {
    const active = paneRegistry.get(workspace.activePane) ?? paneRegistry.all()[0];
    const open = (device: string, as: "terminal" | "shell"): void => {
      kindRef.current = as;
      addPane(device);
      kindRef.current = kind;
    };
    return [
      ...names.map((name) => ({
        id: `open:${name}`,
        label: `Open terminal: ${name}`,
        group: "Panes",
        run: () => open(name, "terminal"),
      })),
      ...(state?.readOnly
        ? []
        : names.map((name) => ({
            id: `shell:${name}`,
            label: `Open interactive shell: ${name}`,
            group: "Panes",
            run: () => open(name, "shell"),
          }))),
      ...paneRegistry.all().map((pane, i) => ({
        id: `focus:${pane.id}`,
        label: `Go to pane ${i + 1}: ${pane.device}`,
        group: "Panes",
        run: () => {
          dock.current?.getPanel(pane.id)?.api.setActive();
          pane.focus();
        },
      })),
      ...favorites.map((favorite) => ({
        id: `fav:${favorite.id}`,
        label: `Run favourite: ${favorite.command}`,
        group: active ? `Favourites → ${active.device}` : "Favourites",
        run: () => void active?.run(favorite.command),
      })),
      ...saved.map((item) => ({
        id: `ws:${item.name}`,
        label: `Open workspace: ${item.name}`,
        group: "Workspaces",
        run: () => openWorkspace(item),
      })),
      { id: "bc:off", label: "Broadcast: off", group: "Broadcast", run: () => setBroadcast(null) },
      {
        id: "bc:all",
        label: "Broadcast: all open panes",
        group: "Broadcast",
        run: () => setBroadcast({ label: "all panes", devices: null }),
      },
      ...groups.map((group) => ({
        id: `bc:${group.name}`,
        label: `Broadcast: group ${group.name}`,
        group: "Broadcast",
        run: () => setBroadcast({ label: group.name, devices: group.devices }),
      })),
      {
        id: "recordings",
        label: "Play a shell recording",
        group: "View",
        run: () => setRecordings(true),
      },
      {
        id: "scheduled",
        label: "Show the scheduled commands",
        group: "View",
        run: () => setDrawer("scheduled"),
      },
      { id: "find", label: "Find in the terminals", group: "View", run: () => setFinding(true) },
      {
        id: "history",
        label: "Show the command history",
        group: "View",
        run: () => setDrawer("history"),
      },
      {
        id: "favs",
        label: "Show the favourites",
        group: "View",
        run: () => setDrawer("favorites"),
      },
      { id: "drawer", label: "Hide the side drawer", group: "View", run: () => setDrawer(null) },
      {
        id: "all",
        label: "Open one terminal for every router",
        group: "Panes",
        run: () => names.forEach((name, i) => addPane(name, i % 2 ? "below" : "right")),
      },
    ];
  };

  if (!state || !devices) return <div className="term-page term-loading">Opening terminal…</div>;
  if (!state.enabled) {
    return (
      <div className="term-page">
        <div className="term-locked">
          <ShieldAlert size={28} />
          <h2>Terminal is turned off</h2>
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
          <span className="term-kind" role="group" aria-label="Kind of terminal">
            <button
              type="button"
              data-on={kind === "terminal"}
              onClick={() => setKind("terminal")}
              title="Command blocks: history, retry, watch, table, compare. Every command is recorded."
            >
              Blocks
            </button>
            <button
              type="button"
              data-on={kind === "shell"}
              disabled={state.readOnly}
              onClick={() => setKind("shell")}
              title="Interactive shell, as in WinBox: enter menus, answer prompts, run live monitors. Keys are not recorded."
            >
              Shell
            </button>
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
          <details className="term-menu term-broadcast-menu">
            <summary title="Saved pane layouts">
              <PanelsTopLeft size={14} /> Workspaces{" "}
              {saved.length > 0 && <small>{saved.length}</small>}
            </summary>
            <div>
              {saved.length === 0 && (
                <span className="term-menu-note">No saved workspace yet.</span>
              )}
              {saved.map((item) => (
                <span key={item.name} className="term-group-row">
                  <button type="button" onClick={() => openWorkspace(item)}>
                    {item.name}
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete workspace ${item.name}`}
                    title="Delete this workspace"
                    onClick={() => {
                      const next = saved.filter((w) => w.name !== item.name);
                      setSaved(next);
                      workspaceStorage.save(next);
                    }}
                  >
                    <Trash2 size={11} />
                  </button>
                </span>
              ))}
              <form
                className="term-group-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  saveWorkspace();
                }}
              >
                <input
                  value={workspaceName}
                  placeholder="Name for the current layout"
                  aria-label="Workspace name"
                  onChange={(event) => setWorkspaceName(event.target.value)}
                />
                <button type="submit" disabled={!workspaceName.trim()}>
                  Save current layout
                </button>
              </form>
            </div>
          </details>
          <details className="term-menu term-broadcast-menu">
            <summary
              className="term-broadcast"
              data-on={broadcast !== null}
              title="Broadcast: a command typed in one pane also runs in other open panes"
            >
              <Radio size={14} /> Broadcast {broadcast ? `· ${broadcast.label}` : "off"}
            </summary>
            <div>
              <button type="button" data-on={broadcast === null} onClick={() => setBroadcast(null)}>
                Off
              </button>
              <button
                type="button"
                data-on={broadcast?.devices === null}
                onClick={() => setBroadcast({ label: "all panes", devices: null })}
              >
                All open panes ({paneCount})
              </button>
              {groups.map((group) => (
                <span key={group.name} className="term-group-row">
                  <button
                    type="button"
                    data-on={broadcast?.label === group.name}
                    onClick={() => setBroadcast({ label: group.name, devices: group.devices })}
                    title={group.devices.join(", ")}
                  >
                    {group.name} <small>{group.devices.length}</small>
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete group ${group.name}`}
                    title="Delete this group"
                    onClick={() => {
                      const next = groups.filter((g) => g.name !== group.name);
                      setGroups(next);
                      groupStorage.save(next);
                      if (broadcast?.label === group.name) setBroadcast(null);
                    }}
                  >
                    <Trash2 size={11} />
                  </button>
                </span>
              ))}
              {draft ? (
                <form
                  className="term-group-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const name = draft.name.trim();
                    if (!name || !draft.devices.length) return;
                    const next = [
                      ...groups.filter((g) => g.name !== name),
                      { name, devices: draft.devices },
                    ];
                    setGroups(next);
                    groupStorage.save(next);
                    setBroadcast({ label: name, devices: draft.devices });
                    setDraft(null);
                  }}
                >
                  <input
                    value={draft.name}
                    placeholder="Group name"
                    aria-label="Group name"
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                  {names.map((name) => (
                    <label key={name}>
                      <Checkbox
                        aria-label={`Include ${name}`}
                        checked={draft.devices.includes(name)}
                        onCheckedChange={(value) =>
                          setDraft({
                            ...draft,
                            devices:
                              value === true
                                ? [...draft.devices, name]
                                : draft.devices.filter((d) => d !== name),
                          })
                        }
                      />
                      {name}
                    </label>
                  ))}
                  <button type="submit">Save group</button>
                </form>
              ) : (
                <button type="button" onClick={() => setDraft({ name: "", devices: [] })}>
                  <Plus size={12} /> New group…
                </button>
              )}
            </div>
          </details>
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
            onClick={() => setRecordings(true)}
            title="Play back and search recorded interactive shell sessions"
          >
            <Video size={14} /> Recordings
          </button>
          <button
            type="button"
            data-on={drawer === "scheduled"}
            onClick={() => setDrawer(drawer === "scheduled" ? null : "scheduled")}
            title="Commands the server runs at a time or on a repeat"
          >
            <CalendarClock size={14} /> Scheduled
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

      {palette && <CommandPalette actions={paletteActions()} onClose={() => setPalette(false)} />}
      {recordings && <RecordingsDialog onClose={() => setRecordings(false)} />}
      <CompareDialog />
      <ScriptDialog />
      {sent && (
        <div className="term-sent" role="status">
          <Radio size={14} />
          <code>{sent.command}</code>
          {sent.results.map((result, i) => (
            <span
              // eslint-disable-next-line react/no-array-index-key -- one router may have two panes
              key={`${result.device}-${i}`}
              data-ok={result.ok}
              title={result.error}
            >
              {result.device} {result.ok ? `${result.ms} ms` : "failed"}
            </span>
          ))}
          <button type="button" onClick={() => setSent(null)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}
      {finding && <FindBar focus={findFocus} onClose={() => setFinding(false)} />}

      <div className="term-body">
        <div className="term-dock">
          <DockviewReact
            components={components}
            defaultTabComponent={PaneTab}
            onReady={onReady}
            theme={themeAbyss}
          />
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

        {drawer === "scheduled" && (
          <ScheduleDrawer devices={names} draft={scheduleDraft} onClose={() => setDrawer(null)} />
        )}
        {drawer && drawer !== "scheduled" && (
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
                <span className="term-field">
                  From
                  <Select
                    size="sm"
                    className="term-select"
                    aria-label="Show the history of"
                    value={filterDevice}
                    onValueChange={setFilterDevice}
                    options={[
                      { value: "", label: "all routers" },
                      ...names.map((name) => ({ value: name, label: name })),
                    ]}
                  />
                </span>
              )}
              <span className="term-field">
                Run on
                <Select
                  size="sm"
                  className="term-select"
                  aria-label="Run on"
                  value={target}
                  onValueChange={setTarget}
                  options={[
                    { value: "active", label: "active pane" },
                    ...names.map((name) => ({ value: name, label: name })),
                  ]}
                />
              </span>
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
