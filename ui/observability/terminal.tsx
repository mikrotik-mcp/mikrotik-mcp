/**
 * Terminal page — RouterOS consoles in dockable panes.
 *
 * Panes split, resize, move, stack as tabs, float and maximise (dockview). Each
 * pane is one console on one router; several panes may share a router. The
 * drawer holds the command history and the favourites, and can run any of them
 * on any router.
 */
import type {
  DockviewApi,
  DockviewReadyEvent,
  IDockviewHeaderActionsProps,
  IDockviewPanel,
} from "dockview-react";
import { DockviewReact, themeAbyss } from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import {
  CalendarDays,
  ChevronDown,
  CircleDot,
  History,
  Layers,
  LayoutGrid,
  Pencil,
  Play,
  Plus,
  Radio,
  Search,
  ShieldAlert,
  SquareTerminal,
  Star,
  Table2,
  Trash2,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api } from "./api";
import { Checkbox, enter, Kbd, Led, Menu, SearchInput, Segmented, Select, TextInput } from "./kit";
import { drawerIn } from "./kit/motion";
import { PageIntro } from "./monitoring-ui";
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
import { Count, PointMenu, Pop } from "./terminal-menu";
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
/** Abyss keeps dockview's drag and drop; terminal.css paints it in the Signal tokens. */
const dockTheme = { ...themeAbyss, gap: 12 };
const PHONE = "(max-width: 640px)";

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
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}
const took = (ms: number): string => (ms < 10_000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

/** "2 consoles open · home-ax3 and netherlands." The first router is teal. */
function headline(devices: string[]): ReactNode {
  if (!devices.length) return "No console open.";
  const count = `${devices.length} console${devices.length === 1 ? "" : "s"} open · `;
  const [first, ...rest] = [...new Set(devices)];
  const tail =
    rest.length === 0
      ? ""
      : rest.length === 1
        ? ` and ${rest[0]}`
        : `, ${rest.slice(0, -1).join(", ")} and ${rest.at(-1)}`;
  return (
    <>
      {count}
      <span className="s">{first}</span>
      {tail}.
    </>
  );
}

/** The "+" after a group's tabs: another pane on the router of the active tab. */
function AddTab(props: IDockviewHeaderActionsProps): ReactNode {
  const device = (props.activePanel?.params as { device?: string } | undefined)?.device;
  if (!device) return null;
  return (
    <button
      type="button"
      className="term-tab-add"
      aria-label={`Another console on ${device}`}
      title={`Another console on ${device}`}
      onClick={() => workspace.onAddPane?.(device, props.group.id)}
    >
      <Plus size={14} />
    </button>
  );
}

/** The page, or a shared read-only view when the URL carries `?share=<id>`. */
export function TerminalView(): ReactNode {
  const share = new URLSearchParams(location.search).get("share");
  return share ? <SharedView id={share} /> : <TerminalWorkspace />;
}

type DrawerKind = "history" | "favorites" | "scheduled";

function TerminalWorkspace(): ReactNode {
  const [state, setState] = useState<TerminalState | null>(null);
  const [devices, setDevices] = useState<DevicesPayload | null>(null);
  const [broadcast, setBroadcast] = useState<BroadcastTarget | null>(null);
  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const [groups, setGroups] = useState<BroadcastGroup[]>(groupStorage.load);
  const [draft, setDraft] = useState<{ name: string; devices: string[] } | null>(null);
  const [saved, setSaved] = useState<SavedWorkspace[]>(workspaceStorage.load);
  const [workspacesOpen, setWorkspacesOpen] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");
  /** True while one layout replaces another: closed panes then keep their blocks. */
  const switching = useRef(false);
  const [sent, setSent] = useState<{ command: string; results: BroadcastResult[] } | null>(null);
  const [drawer, setDrawer] = useState<DrawerKind | null>(null);
  const [scheduleDraft, setScheduleDraft] = useState("");
  const [scheduleCount, setScheduleCount] = useState(0);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [query, setQuery] = useState("");
  const [filterDevice, setFilterDevice] = useState("");
  const [target, setTarget] = useState("active");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [rowMenu, setRowMenu] = useState<{ key: string; x: number; y: number } | null>(null);
  const [armed, setArmed] = useState(false);
  const [finding, setFinding] = useState(false);
  const [palette, setPalette] = useState(false);
  const [recordings, setRecordings] = useState(false);
  /** What "New console" opens: command blocks, or an interactive shell. */
  const [kind, setKind] = useState<"terminal" | "shell">("terminal");
  const kindRef = useRef(kind);
  kindRef.current = kind;
  /** Raised by Ctrl+F so an open find bar takes the focus again. */
  const [findFocus, setFindFocus] = useState(0);
  const [, setGrammarReady] = useState(false);
  const [phone, setPhone] = useState(() => matchMedia(PHONE).matches);
  const dock = useRef<DockviewApi | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const aside = useRef<HTMLElement>(null);
  const search = useRef<HTMLDivElement>(null);
  const favorites = useSyncExternalStore(favoritesStore.subscribe, favoritesStore.get);
  const paneKey = useSyncExternalStore(paneRegistry.subscribe, () =>
    paneRegistry
      .all()
      .map((pane) => `${pane.id}=${pane.device}`)
      .join("|"),
  );
  const panes = useMemo(
    () =>
      paneKey
        ? paneKey.split("|").map((pair) => {
            const [id = "", device = ""] = pair.split("=");
            return { id, device };
          })
        : [],
    [paneKey],
  );
  const paneCount = panes.length;
  /** Every console in the dock, shells included: the headline and the phone chips. */
  const [consoles, setConsoles] = useState<{ id: string; device: string }[]>([]);
  const [activeId, setActiveId] = useState("");
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
    const media = matchMedia(PHONE);
    const onChange = (): void => setPhone(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
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
  // The count on the Scheduled button.
  useEffect(() => {
    if (!state?.enabled) return;
    api<{ schedules: unknown[] }>("/api/terminal/schedules")
      .then((r) => setScheduleCount(r.schedules.length))
      .catch(() => {});
  }, [state?.enabled, drawer]);

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
      requestAnimationFrame(() => search.current?.querySelector("input")?.focus());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The drawer slides in; its rows rise one after another.
  useEffect(() => {
    if (!drawer || !aside.current) return;
    const out = drawerIn(aside.current);
    const rows = enter(aside.current, ".term-hrow");
    return () => {
      out();
      rows();
    };
  }, [drawer]);

  const addPane = useCallback(
    (device: string, direction: "right" | "below" = "right", group?: string): string => {
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
        position: group
          ? { referenceGroup: group, direction: "within" as const }
          : reference
            ? { referencePanel: reference.id, direction }
            : undefined,
      });
      // Two consoles side by side: the first one gets the wider column, as on the board.
      const added = view.getPanel(id);
      if (!group && direction === "right" && view.groups.length === 2 && added)
        added.group.api.setSize({ width: Math.round(view.width / 2.35) });
      return id;
    },
    [],
  );
  useEffect(() => {
    workspace.onAddPane = (device, group) => addPane(device, "right", group);
    return () => {
      workspace.onAddPane = undefined;
    };
  }, [addPane]);

  const focusPanel = (panel: IDockviewPanel | undefined): void => {
    if (!panel) return;
    panel.api.setActive();
    if (phone) panel.api.maximize();
  };

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
      event.api.onDidActivePanelChange((change) => setActiveId(change.panel?.id ?? ""));
      setActiveId(event.api.activePanel?.id ?? "");
      const list = (): void =>
        setConsoles(
          event.api.panels.map((panel) => ({
            id: panel.id,
            device: (panel.params as { device?: string } | undefined)?.device ?? panel.id,
          })),
        );
      list();
      event.api.onDidAddPanel(list);
      event.api.onDidRemovePanel(list);
      // The panes rise in one after another.
      requestAnimationFrame(() => enter(body.current, ".dv-groupview"));
    },
    [addPane, devices],
  );

  // On a phone one pane fills the page; the chips above it switch panes.
  useEffect(() => {
    const view = dock.current;
    if (!view) return;
    if (phone) view.activePanel?.api.maximize();
    else if (view.hasMaximizedGroup()) view.exitMaximizedGroup();
  }, [phone]);

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
  const openAll = (): void => names.forEach((name, i) => addPane(name, i % 2 ? "below" : "right"));

  /** Run on the chosen target: the active pane, or a pane of the named router. */
  const runOn = useCallback(
    (command: string, mode: "run" | "insert", device = target): void => {
      const act = (id: string): boolean => {
        const pane = paneRegistry.get(id);
        if (!pane) return false;
        if (mode === "run") void pane.run(command);
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
      ...(state?.readOnly
        ? []
        : names.map((name) => ({
            id: `shell:${name}`,
            label: `Open a shell on ${name}`,
            group: "Open",
            icon: <SquareTerminal size={14} />,
            run: () => open(name, "shell"),
          }))),
      ...names.map((name) => ({
        id: `open:${name}`,
        label: `Open blocks on ${name}`,
        group: "Open",
        icon: <Table2 size={14} />,
        run: () => open(name, "terminal"),
      })),
      {
        id: "all",
        label: "Open one pane for every router",
        group: "Open",
        icon: <Table2 size={14} />,
        run: openAll,
      },
      ...paneRegistry.all().map((pane, i) => ({
        id: `focus:${pane.id}`,
        label: `Go to pane ${i + 1}: ${pane.device}`,
        group: "Panes",
        run: () => {
          focusPanel(dock.current?.getPanel(pane.id));
          pane.focus();
        },
      })),
      ...favorites.map((favorite) => ({
        id: `fav:${favorite.id}`,
        label: `Run favourite: ${favorite.command}`,
        group: active ? `Favourites on ${active.device}` : "Favourites",
        icon: <Star size={14} />,
        run: () => void active?.run(favorite.command),
      })),
      ...saved.map((item) => ({
        id: `ws:${item.name}`,
        label: `Open workspace: ${item.name}`,
        group: "Workspaces",
        icon: <Layers size={14} />,
        run: () => openWorkspace(item),
      })),
      {
        id: "bc:off",
        label: "Broadcast: off",
        group: "Broadcast",
        icon: <Radio size={14} />,
        run: () => setBroadcast(null),
      },
      {
        id: "bc:all",
        label: "Broadcast: all open panes",
        group: "Broadcast",
        icon: <Radio size={14} />,
        run: () => setBroadcast({ label: "all panes", devices: null }),
      },
      ...groups.map((group) => ({
        id: `bc:${group.name}`,
        label: `Broadcast: group ${group.name}`,
        group: "Broadcast",
        icon: <Radio size={14} />,
        run: () => setBroadcast({ label: group.name, devices: group.devices }),
      })),
      {
        id: "recordings",
        label: "Play a shell recording",
        group: "View",
        icon: <CircleDot size={14} />,
        run: () => setRecordings(true),
      },
      {
        id: "scheduled",
        label: "Show the scheduled commands",
        group: "View",
        icon: <CalendarDays size={14} />,
        run: () => setDrawer("scheduled"),
      },
      {
        id: "find",
        label: "Find in the terminals",
        group: "View",
        icon: <Search size={14} />,
        run: () => setFinding(true),
      },
      {
        id: "history",
        label: "Show the command history",
        group: "View",
        icon: <History size={14} />,
        run: () => setDrawer("history"),
      },
      {
        id: "favs",
        label: "Show the favourites",
        group: "View",
        icon: <Star size={14} />,
        run: () => setDrawer("favorites"),
      },
      { id: "drawer", label: "Hide the side drawer", group: "View", run: () => setDrawer(null) },
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
  const menuRow = rowMenu ? rows.find((row) => row.key === rowMenu.key) : undefined;
  const toggleDrawer = (next: DrawerKind): void => setDrawer(drawer === next ? null : next);
  const deviceTone = (name: string) => {
    const status = devices.devices.find((d) => d.name === name)?.status;
    if (status?.reachable === false) return "bad" as const;
    return (status?.latencyMs ?? 0) > 500 ? ("warn" as const) : ("ok" as const);
  };
  const broadcastCount = broadcast
    ? panes.filter((p) => !broadcast.devices || broadcast.devices.includes(p.device)).length
    : 0;
  const okCount = sent?.results.filter((r) => r.ok).length ?? 0;

  return (
    <div className="term-page" data-phone={phone || undefined}>
      <PageIntro
        eyebrow="Router configuration · Terminal"
        heading={headline(consoles.map((p) => p.device))}
        lead="RouterOS consoles in the browser. Blocks keep every command with its output; Shell is the real console. Every command is written to the audit feed."
        actions={
          <button
            type="button"
            className="term-keyhint"
            onClick={() => setPalette(true)}
            title="Open the command palette"
          >
            <Kbd>Ctrl</Kbd>
            <Kbd>Shift</Kbd>
            <Kbd>P</Kbd>
            <span>commands</span>
          </button>
        }
      />

      <div className="term-bar" role="toolbar" aria-label="Terminal">
        <Segmented
          value={kind}
          onChange={setKind}
          label="Kind of console"
          className="term-kind"
          options={[
            { value: "terminal", label: "Blocks", icon: <Table2 size={13} /> },
            {
              value: "shell",
              label: "Shell",
              icon: <SquareTerminal size={13} />,
              disabled: state.readOnly,
            },
          ]}
        />
        <Menu
          label="New console"
          align="start"
          trigger={
            <button type="button" className="term-chip" data-tone="add">
              <Plus size={16} />
              New console
              <ChevronDown size={16} />
            </button>
          }
          groups={[
            devices.devices.map((device) => ({
              label: device.name,
              icon: <Led tone={device.status.reachable ? "ok" : "bad"} />,
              shortcut:
                device.status.latencyMs !== null ? `${device.status.latencyMs} ms` : undefined,
              onSelect: () => addPane(device.name),
            })),
            [
              {
                label: "Open one pane for every router",
                icon: <LayoutGrid size={14} />,
                onSelect: openAll,
              },
            ],
          ]}
        />
        <span className="term-sep" />
        <Pop
          open={broadcastOpen}
          onOpenChange={setBroadcastOpen}
          label="Broadcast"
          align="start"
          width={300}
          trigger={
            <button
              type="button"
              className="term-chip"
              data-on={broadcast !== null || undefined}
              data-tone={broadcast ? "acc" : undefined}
              title="Broadcast: a command typed in one pane also runs in other open panes"
            >
              <Radio size={14} />
              Broadcast
              {broadcast && <Count className="c" value={broadcastCount} />}
            </button>
          }
        >
          <p className="term-pop-title">Broadcast to</p>
          <button
            type="button"
            className="kit-opt term-pop-opt"
            aria-pressed={broadcast === null}
            onClick={() => setBroadcast(null)}
          >
            <span className="t">Off</span>
          </button>
          <button
            type="button"
            className="kit-opt term-pop-opt"
            aria-pressed={broadcast?.devices === null}
            onClick={() => setBroadcast({ label: "all panes", devices: null })}
          >
            <span className="t">All open panes</span>
            <span className="meta">{paneCount}</span>
          </button>
          {groups.map((group) => (
            <span key={group.name} className="term-pop-pair">
              <button
                type="button"
                className="kit-opt term-pop-opt"
                aria-pressed={broadcast?.label === group.name}
                onClick={() => setBroadcast({ label: group.name, devices: group.devices })}
                title={group.devices.join(", ")}
              >
                <span className="t">{group.name}</span>
                <span className="meta">{group.devices.length}</span>
              </button>
              <button
                type="button"
                className="term-ib"
                aria-label={`Delete group ${group.name}`}
                title="Delete this group"
                onClick={() => {
                  const next = groups.filter((g) => g.name !== group.name);
                  setGroups(next);
                  groupStorage.save(next);
                  if (broadcast?.label === group.name) setBroadcast(null);
                }}
              >
                <Trash2 size={13} />
              </button>
            </span>
          ))}
          <div className="kit-sep" />
          {draft ? (
            <form
              className="term-pop-form"
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
              <TextInput
                size="sm"
                value={draft.name}
                placeholder="Group name"
                label="Group name"
                onChange={(name) => setDraft({ ...draft, name })}
              />
              {names.map((name) => (
                <Checkbox
                  key={name}
                  label={name}
                  checked={draft.devices.includes(name)}
                  onCheckedChange={(value) =>
                    setDraft({
                      ...draft,
                      devices: value
                        ? [...draft.devices, name]
                        : draft.devices.filter((d) => d !== name),
                    })
                  }
                />
              ))}
              <button
                type="submit"
                className="term-act"
                data-tone="go"
                disabled={!draft.name.trim() || !draft.devices.length}
              >
                Save group
              </button>
            </form>
          ) : (
            <button
              type="button"
              className="kit-opt term-pop-opt"
              onClick={() => setDraft({ name: "", devices: [] })}
            >
              <span className="ico">
                <Plus size={14} />
              </span>
              <span className="t">New group…</span>
            </button>
          )}
        </Pop>
        <button
          type="button"
          className="term-chip"
          data-on={finding || undefined}
          onClick={() => setFinding((open) => !open)}
          title="Find in the terminals (Ctrl+F)"
        >
          <Search size={14} />
          Find
        </button>
        <button
          type="button"
          className="term-chip"
          data-on={drawer === "history" || undefined}
          onClick={() => toggleDrawer("history")}
          title="Command history (Ctrl+K)"
        >
          <History size={14} />
          History
        </button>
        <button
          type="button"
          className="term-chip"
          data-on={drawer === "favorites" || undefined}
          onClick={() => toggleDrawer("favorites")}
        >
          <Star size={14} />
          Favourites
          {favorites.length > 0 && <Count className="c" value={favorites.length} />}
        </button>
        <button
          type="button"
          className="term-chip"
          data-on={drawer === "scheduled" || undefined}
          onClick={() => toggleDrawer("scheduled")}
          title="Commands the server runs at a time or on a repeat"
        >
          <CalendarDays size={14} />
          Scheduled
          {scheduleCount > 0 && <Count className="c" value={scheduleCount} />}
        </button>
        <button
          type="button"
          className="term-chip"
          onClick={() => setRecordings(true)}
          title="Play back and search recorded interactive shell sessions"
        >
          <CircleDot size={14} />
          Recordings
        </button>
        <span className="term-grow" />
        {state.readOnly && (
          <span
            className="term-chip term-ro"
            title="Only print, export and diagnostic commands run."
          >
            read-only server
          </span>
        )}
        <Pop
          open={workspacesOpen}
          onOpenChange={setWorkspacesOpen}
          label="Workspaces"
          width={300}
          trigger={
            <button type="button" className="term-chip" title="Saved pane layouts">
              <Layers size={14} />
              Workspaces
              {saved.length > 0 && <Count className="c" value={saved.length} />}
            </button>
          }
        >
          <p className="term-pop-title">Workspaces</p>
          {saved.length === 0 && <p className="term-pop-note">No saved workspace yet.</p>}
          {saved.map((item) => (
            <span key={item.name} className="term-pop-pair">
              <button
                type="button"
                className="kit-opt term-pop-opt"
                onClick={() => {
                  openWorkspace(item);
                  setWorkspacesOpen(false);
                }}
              >
                <span className="ico">
                  <Layers size={14} />
                </span>
                <span className="t">{item.name}</span>
              </button>
              <button
                type="button"
                className="term-ib"
                aria-label={`Delete workspace ${item.name}`}
                title="Delete this workspace"
                onClick={() => {
                  const next = saved.filter((w) => w.name !== item.name);
                  setSaved(next);
                  workspaceStorage.save(next);
                }}
              >
                <Trash2 size={13} />
              </button>
            </span>
          ))}
          <div className="kit-sep" />
          <form
            className="term-pop-form"
            onSubmit={(event) => {
              event.preventDefault();
              saveWorkspace();
            }}
          >
            <TextInput
              size="sm"
              value={workspaceName}
              placeholder="Name for the current layout"
              label="Workspace name"
              onChange={setWorkspaceName}
            />
            <button
              type="submit"
              className="term-act"
              data-tone="go"
              disabled={!workspaceName.trim()}
            >
              Save current layout
            </button>
          </form>
        </Pop>
      </div>

      {sent && (
        <div className="term-bc" role="status">
          <span className="ic">
            <Radio size={15} />
          </span>
          <span>
            Sent <code>{sent.command}</code> to{" "}
            <b>
              {sent.results.length} pane{sent.results.length === 1 ? "" : "s"}
            </b>
            {okCount < sent.results.length && ` · ${sent.results.length - okCount} failed`}
          </span>
          {sent.results.map((result, i) => (
            <span
              // eslint-disable-next-line react/no-array-index-key -- one router may have two panes
              key={`${result.device}-${i}`}
              className="r"
              data-ok={result.ok}
              title={result.error}
            >
              <Led tone={result.ok ? "ok" : "bad"} />
              {result.device}
              <span className="m">{result.ok ? `${result.ms} ms` : "failed"}</span>
            </span>
          ))}
          <span className="sp" />
          <button
            type="button"
            className="term-ib"
            onClick={() => setSent(null)}
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {phone && (
        <div className="term-phone-tabs" role="tablist" aria-label="Routers">
          {devices.devices.map((device) => {
            const active = consoles.find((c) => c.id === activeId)?.device === device.name;
            return (
              <button
                key={device.name}
                type="button"
                role="tab"
                aria-selected={active}
                className="term-chip"
                data-tone={active ? "r" : undefined}
                onClick={() => {
                  // The router's console, or a new one when none is open.
                  const open = consoles.find((c) => c.device === device.name);
                  if (open) focusPanel(dock.current?.getPanel(open.id));
                  else focusPanel(dock.current?.getPanel(addPane(device.name)));
                }}
              >
                <Led tone={deviceTone(device.name)} />
                {device.name}
              </button>
            );
          })}
        </div>
      )}

      <div className="term-body" ref={body}>
        <div className="term-dock">
          <DockviewReact
            components={components}
            defaultTabComponent={PaneTab}
            leftHeaderActionsComponent={AddTab}
            onReady={onReady}
            theme={dockTheme}
          />
          {consoles.length === 0 && (
            <div className="term-nopane">
              <p>No console is open.</p>
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
        {finding && <FindBar focus={findFocus} onClose={() => setFinding(false)} />}
      </div>

      {palette && <CommandPalette actions={paletteActions()} onClose={() => setPalette(false)} />}
      {recordings && <RecordingsDialog devices={names} onClose={() => setRecordings(false)} />}
      <CompareDialog />
      <ScriptDialog />

      {drawer === "scheduled" && (
        <ScheduleDrawer
          ref={aside}
          devices={names}
          draft={scheduleDraft}
          onCount={setScheduleCount}
          onClose={() => setDrawer(null)}
        />
      )}
      {drawer && drawer !== "scheduled" && (
        <aside
          ref={aside}
          className="term-dw"
          aria-label={drawer === "history" ? "History" : "Favourites"}
        >
          <div className="term-dw-hd">
            <div className="term-dw-title">
              {drawer === "history" ? <History size={16} /> : <Star size={16} />}
              <b>{drawer === "history" ? "History" : "Favourites"}</b>
              <span className="sp" />
              {drawer === "history" && history.length > 0 && (
                <button
                  type="button"
                  className="term-ib"
                  data-armed={armed || undefined}
                  title={
                    armed
                      ? "Click again to delete"
                      : filterDevice
                        ? `Delete the history of ${filterDevice}`
                        : "Delete all history"
                  }
                  aria-label={armed ? "Click again to delete" : "Delete the history"}
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
                  <Trash2 size={14} />
                </button>
              )}
              <button
                type="button"
                className="term-ib"
                onClick={() => setDrawer(null)}
                aria-label="Close"
              >
                <X size={15} />
              </button>
            </div>
            <div ref={search} className="term-dw-search">
              <SearchInput
                size="md"
                label="Search commands"
                value={query}
                onChange={setQuery}
                placeholder="Search commands"
                spellCheck={false}
              />
            </div>
            <div className="term-dw-filters">
              {drawer === "history" && (
                <Select
                  size="sm"
                  label="Show the history of"
                  value={filterDevice || "*"}
                  onChange={(value) => setFilterDevice(value === "*" ? "" : value)}
                  options={[
                    { value: "*", label: "From every router" },
                    ...names.map((name) => ({ value: name, label: `From ${name}` })),
                  ]}
                />
              )}
              <Select
                size="sm"
                label="Run on"
                value={target}
                onChange={setTarget}
                options={[
                  { value: "active", label: "Run on active pane" },
                  ...names.map((name) => ({ value: name, label: `Run on ${name}` })),
                ]}
              />
            </div>
          </div>
          <ol className="term-dw-rows">
            {rows.length === 0 && (
              <li className="term-dw-empty">
                {drawer === "history"
                  ? "Nothing here yet. Commands you run appear in this list."
                  : "No favourites yet. Star a command to keep it here."}
              </li>
            )}
            {rows.map(({ key, command, entry }) => (
              <li
                key={key}
                className="term-hrow"
                data-on={expanded === key || undefined}
                data-ok={entry ? String(entry.ok) : undefined}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setRowMenu({ key, x: event.clientX, y: event.clientY });
                }}
              >
                <button
                  type="button"
                  className="term-hrow-main"
                  onClick={() => setExpanded(expanded === key ? null : key)}
                  aria-expanded={expanded === key}
                  title={entry ? "Show the saved output" : undefined}
                >
                  <Code text={command} />
                  <span className="m">
                    {entry
                      ? `${entry.device} · ${entry.ok ? took(entry.ms) : "failed"} · ${ago(entry.ts)}`
                      : "favourite"}
                  </span>
                </button>
                <span className="a">
                  <button
                    type="button"
                    className="term-ib"
                    onClick={() => runOn(command, "run")}
                    title="Run on the chosen target"
                    aria-label="Run"
                  >
                    <Play size={12} />
                  </button>
                  <button
                    type="button"
                    className="term-ib"
                    onClick={() => runOn(command, "insert")}
                    title="Put in the input to edit first"
                    aria-label="Edit"
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    type="button"
                    className="term-ib"
                    data-star={starred.has(command) || undefined}
                    onClick={() => void favoritesStore.toggle(command)}
                    title={starred.has(command) ? "Remove from favourites" : "Add to favourites"}
                    aria-label={
                      starred.has(command) ? "Remove from favourites" : "Add to favourites"
                    }
                  >
                    <Star size={13} fill={starred.has(command) ? "currentColor" : "none"} />
                  </button>
                </span>
                {expanded === key && (
                  <pre className="term-hrow-out">
                    {entry
                      ? (entry.error ?? (cleanOutput(entry.output).trimEnd() || "no output"))
                      : command}
                  </pre>
                )}
              </li>
            ))}
          </ol>
          <PointMenu
            at={rowMenu && menuRow ? rowMenu : null}
            onClose={() => setRowMenu(null)}
            label="Command actions"
            head={menuRow && <b>{menuRow.command}</b>}
            groups={
              menuRow
                ? [
                    [
                      {
                        label: "Run",
                        icon: <Play size={14} />,
                        onSelect: () => runOn(menuRow.command, "run"),
                      },
                      {
                        label: "Edit in the input",
                        icon: <Pencil size={14} />,
                        onSelect: () => runOn(menuRow.command, "insert"),
                      },
                      {
                        label: starred.has(menuRow.command)
                          ? "Remove from favourites"
                          : "Add to favourites",
                        icon: <Star size={14} />,
                        onSelect: () => void favoritesStore.toggle(menuRow.command),
                      },
                      ...(menuRow.entry
                        ? [
                            {
                              label:
                                expanded === menuRow.key ? "Hide the output" : "Show the output",
                              icon: <ChevronDown size={14} />,
                              onSelect: () =>
                                setExpanded(expanded === menuRow.key ? null : menuRow.key),
                            },
                          ]
                        : []),
                    ],
                    [
                      {
                        label: menuRow.entry ? "Delete this entry" : "Remove favourite",
                        icon: <Trash2 size={14} />,
                        danger: true,
                        onSelect: () => {
                          const entry = menuRow.entry;
                          if (entry)
                            void terminalApi.deleteHistory({ id: entry.id }).then(refreshHistory);
                          else void favoritesStore.toggle(menuRow.command);
                        },
                      },
                    ],
                  ]
                : []
            }
          />
        </aside>
      )}
    </div>
  );
}
