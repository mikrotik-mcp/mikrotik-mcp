/**
 * Files page — the files of several routers side by side, in dockable panes.
 *
 * Search runs on every open router at once (names, or the text inside small
 * text files). Every upload, download and router-to-router copy goes through
 * one queue, shown with its progress in the transfers dock.
 */
import type { DockviewApi, DockviewReadyEvent, DockviewTheme } from "dockview-react";
import { DockviewReact } from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import {
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUpFromLine,
  CalendarClock,
  Check,
  ChartPie,
  ChevronDown,
  Layers,
  Plus,
  RotateCw,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  Square,
  Star,
  Trash2,
  Vault,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api } from "./api";
import { FileCompare } from "./files-compare";
import { ImportDialog } from "./files-import";
import type { FilesState, SearchDone, SearchHit, Transfer } from "./files-lib";
import {
  baseName,
  bookmarkStore,
  broadcastStore,
  directStore,
  filePanes,
  filesApi,
  filesLayout,
  pace,
  parentOf,
  syncStore,
  transferQueue,
  verifyStore,
  workspaceStore,
} from "./files-lib";
import { rise } from "./files-motion";
import { FilesDockPane, FilesPane } from "./files-pane";
import { Count, Strip, fleetStore, size, stamp, usageStore } from "./files-parts";
import { FolderSync } from "./files-sync";
import { FilesTab } from "./files-tab";
import { ToolsDrawer, openTool, toolCounts } from "./files-tools";
import { FileViewer } from "./files-viewer";
import type { MenuItem, Tone } from "./kit";
import { Led, Menu, TextInput, arrive } from "./kit";
import { PHONE_QUERY } from "./kit/motion";
import { routerOption } from "./kit/router-picker";
import type { DevicesPayload } from "./types";
import "./files.css";

const components = { files: FilesDockPane };
const THEME: DockviewTheme = {
  name: "signal-files",
  className: "dockview-theme-abyss fl-dock-theme",
  gap: 12,
};
const KIND_ICON = { upload: ArrowUpFromLine, download: ArrowDownToLine, copy: ArrowLeftRight };

/** `1 s left`, `1 m 20 s left`, or nothing while the speed is unknown. */
function timeLeft(seconds: number): string {
  if (!Number.isFinite(seconds)) return "";
  const whole = Math.ceil(seconds);
  return whole >= 60 ? `${Math.floor(whole / 60)} m ${whole % 60} s left` : `${whole} s left`;
}

/** The queue calls the user's side "this computer"; the board says "this browser". */
const here = (end: string): string => (end === "this computer" ? "this browser" : end);

function usePhone(): boolean {
  return useSyncExternalStore(
    (listener) => {
      if (typeof matchMedia !== "function") return () => {};
      const query = matchMedia(PHONE_QUERY);
      query.addEventListener("change", listener);
      return () => query.removeEventListener("change", listener);
    },
    () => typeof matchMedia === "function" && matchMedia(PHONE_QUERY).matches,
  );
}

function TransferRow({ item }: { item: Transfer }): ReactNode {
  const Icon = KIND_ICON[item.kind];
  const part =
    item.total > 0 ? Math.min(item.done / item.total, 1) : item.status === "done" ? 1 : 0;
  const live = item.status === "active" ? pace(item) : null;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) arrive(ref.current);
  }, []);
  const verified = item.note?.includes("verified");
  return (
    <div ref={ref} className="fl-tx-r" data-status={item.status}>
      <span className="ki" aria-hidden="true">
        <Icon size={item.kind === "download" ? 16 : 14} />
      </span>
      <span className="n" title={item.name}>
        {item.name}{" "}
        {item.via && (
          <span className="fl-tx-badge" data-tone="acc">
            {item.via}
          </span>
        )}
        {item.note && (
          <span className="fl-tx-badge" data-tone={verified ? undefined : "plain"}>
            {verified ? "sha256 ✓ verified" : item.note}
          </span>
        )}
      </span>
      <span className="rt" title={`${here(item.from)} → ${here(item.to)}`}>
        {here(item.from)} → {here(item.to)}
      </span>
      <span
        className="pb"
        role="progressbar"
        aria-label={`${item.name} progress`}
        aria-valuenow={Math.round(part * 100)}
      >
        <i style={{ width: `${part * 100}%` }} data-run={item.status === "active" || undefined} />
      </span>
      <span
        className="st"
        data-tone={item.status === "done" ? "ok" : item.status === "error" ? "bad" : undefined}
      >
        {item.status === "active" &&
          live &&
          `${size(item.done)} of ${size(item.total)} · ${size(live.speed)}/s · ${timeLeft(live.left)}`}
        {item.status === "queued" && "Waiting"}
        {item.status === "done" &&
          `done in ${Math.max(1, Math.round(((item.finished ?? 0) - (item.started ?? 0)) / 1000))} s`}
        {item.status === "stopped" && "Stopped"}
        {item.status === "error" && (item.error ?? "Failed")}
      </span>
      <span className="ac">
        {(item.status === "active" || item.status === "queued") && (
          <button
            type="button"
            className="fp-ib"
            onClick={() => transferQueue.stop(item.id)}
            aria-label="Stop"
          >
            <Square size={12} />
          </button>
        )}
        {(item.status === "error" || item.status === "stopped") && (
          <button
            type="button"
            className="fp-ib"
            onClick={() => transferQueue.retry(item.id)}
            aria-label="Try again"
          >
            <RotateCw size={13} />
          </button>
        )}
        {item.status === "done" && (
          <button
            type="button"
            className="fp-ib"
            onClick={() => transferQueue.dismiss(item.id)}
            aria-label="Remove from the list"
          >
            <X size={16} />
          </button>
        )}
      </span>
    </div>
  );
}

/** The matched text with the query marked, for a plain-text search. */
function Marked({ text, query }: { text: string; query: string }): ReactNode {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0 || !query) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

export function FilesView(): ReactNode {
  const [state, setState] = useState<FilesState | null>(null);
  const [devices, setDevices] = useState<DevicesPayload | null>(null);
  const [query, setQuery] = useState("");
  const [contents, setContents] = useState(true);
  const [regex, setRegex] = useState(false);
  const [matchCase, setMatchCase] = useState(false);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [answers, setAnswers] = useState<SearchDone[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState({ q: "", regex: false, matchCase: false });
  const [searchError, setSearchError] = useState("");
  const [dockOpen, setDockOpen] = useState(true);
  const [saving, setSaving] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");
  const [phoneDevice, setPhoneDevice] = useState("");
  const dock = useRef<DockviewApi | null>(null);
  const dockRoot = useRef<HTMLDivElement>(null);
  const running = useRef<AbortController | null>(null);
  const phone = usePhone();
  const transfers = useSyncExternalStore(transferQueue.subscribe, transferQueue.get);
  const panes = useSyncExternalStore(filePanes.subscribe, filePanes.all);
  const broadcasting = useSyncExternalStore(broadcastStore.subscribe, broadcastStore.get);
  const direct = useSyncExternalStore(directStore.subscribe, directStore.get);
  const bookmarks = useSyncExternalStore(bookmarkStore.subscribe, bookmarkStore.get);
  const workspaces = useSyncExternalStore(workspaceStore.subscribe, workspaceStore.get);
  const verify = useSyncExternalStore(verifyStore.subscribe, verifyStore.get);
  const counts = useSyncExternalStore(toolCounts.subscribe, toolCounts.get);
  useSyncExternalStore(usageStore.subscribe, usageStore.version);
  // Speeds and times left move while a transfer runs.
  const [, tick] = useState(0);
  const active = transfers.filter((item) => item.status === "active" || item.status === "queued");
  useEffect(() => {
    if (active.length === 0) return;
    const timer = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(timer);
  }, [active.length]);

  useEffect(() => {
    void filesApi
      .state()
      .then(setState)
      .catch(() =>
        setState({ enabled: false, reason: "The files API did not answer.", readOnly: false }),
      );
    void api<DevicesPayload>("/api/devices")
      .then(setDevices)
      .catch(() => {});
    return () => running.current?.abort();
  }, []);

  const names = useMemo(() => devices?.devices.map((d) => d.name) ?? [], [devices]);
  const tones = useMemo(() => {
    const out: Record<string, Tone> = {};
    for (const d of devices?.devices ?? [])
      out[d.name] = (routerOption(d.name, d, false).led ?? "off") as Tone;
    return out;
  }, [devices]);
  useEffect(() => fleetStore.set({ names, tone: tones }), [names, tones]);
  const readOnly = state?.readOnly === true;

  // The toolbar counts: files in the vault, jobs, files in the recycle bin.
  useEffect(() => {
    if (!state?.enabled) return;
    const set = (key: "vault" | "jobs" | "trash", n: number): void =>
      toolCounts.set({ ...toolCounts.get(), [key]: n });
    filesApi
      .vault()
      .then((v) => set("vault", v.files.length))
      .catch(() => {});
    filesApi
      .jobs()
      .then((j) => set("jobs", j.length))
      .catch(() => {});
    if (state.trash)
      filesApi
        .trash()
        .then((t) => set("trash", t.length))
        .catch(() => {});
  }, [state]);

  const addPane = useCallback(
    (device: string, path = "/"): void => {
      if (phone) {
        setPhoneDevice(device);
        return;
      }
      const view = dock.current;
      if (!view || !device) return;
      const same = view.panels.filter((p) => (p.params as { device?: string })?.device === device);
      const reference = view.activePanel;
      view.addPanel({
        id: `files-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        component: "files",
        title: same.length ? `${device} · ${same.length + 1}` : device,
        params: { device, path, readOnly, trash: state?.trash === true, s3: state?.s3 === true },
        position: reference ? { referencePanel: reference.id, direction: "right" } : undefined,
      });
    },
    [phone, readOnly, state?.trash, state?.s3],
  );

  const onReady = useCallback(
    (event: DockviewReadyEvent): void => {
      dock.current = event.api;
      const saved = filesLayout.load();
      let restored = false;
      if (saved) {
        try {
          event.api.fromJSON(saved as Parameters<DockviewApi["fromJSON"]>[0]);
          // A router that left the config has no files to show.
          for (const panel of event.api.panels)
            if (!names.includes((panel.params as { device?: string })?.device ?? ""))
              panel.api.close();
          restored = event.api.panels.length > 0;
        } catch {
          event.api.clear();
        }
      }
      // First visit: the routers side by side, which is what the page is for.
      if (!restored) for (const name of names.slice(0, 3)) addPane(name);
      event.api.onDidLayoutChange(() => filesLayout.save(event.api.toJSON()));
      // Panes rise in, one after the other.
      requestAnimationFrame(() => rise(dockRoot.current, ".dv-groupview", 60));
    },
    [addPane, names],
  );

  const search = (): void => {
    const q = query.trim();
    if (!q) return;
    running.current?.abort();
    const abort = new AbortController();
    running.current = abort;
    const targets = Array.from(new Set(panes.map((pane) => pane.device))).map((device) => ({
      device,
      path: "/",
    }));
    setHits([]);
    setAnswers([]);
    setSearchError("");
    setSearched({ q, regex, matchCase });
    setSearching(true);
    filesApi
      .search(
        { q, contents, regex, targets },
        (hit) => setHits((now) => [...(now ?? []), hit]),
        (done) => setAnswers((now) => [...now, done]),
        abort.signal,
      )
      .catch((e: unknown) => {
        if (!abort.signal.aborted) setSearchError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (running.current === abort) setSearching(false);
      });
  };

  const show = (hit: SearchHit): void => {
    const dir = parentOf(hit.path);
    const pane = panes.find((p) => p.device === hit.device);
    if (pane) pane.reveal(dir, baseName(hit.path));
    else addPane(hit.device, dir);
  };

  if (!state || !devices) return <div className="files-page fl-loading">Opening files…</div>;
  if (!state.enabled) {
    return (
      <div className="files-page">
        <div className="fl-locked">
          <ShieldAlert size={28} />
          <h2>Files is turned off</h2>
          <p>{state.reason}</p>
        </div>
      </div>
    );
  }

  /** Aa: the server matches without case, so a case-sensitive search filters here. */
  const caseOk = (hit: SearchHit): boolean => {
    if (!searched.matchCase) return true;
    const where = hit.text ?? baseName(hit.path);
    if (searched.regex) {
      try {
        return new RegExp(searched.q).test(where);
      } catch {
        return true;
      }
    }
    return where.includes(searched.q);
  };
  const shownHits = (hits ?? []).filter(caseOk);
  const grouped = new Map<string, SearchHit[]>();
  for (const hit of shownHits) grouped.set(hit.device, [...(grouped.get(hit.device) ?? []), hit]);
  const finished = transfers.length - active.length;
  const totalBytes = active.reduce((sum, item) => sum + item.total, 0);
  const doneBytes = active.reduce((sum, item) => sum + item.done, 0);
  const allPct = totalBytes ? Math.round((doneBytes / totalBytes) * 100) : 0;
  const openDevices = Array.from(new Set(panes.map((pane) => pane.device)));
  const free = openDevices.reduce((sum, d) => sum + (usageStore.get(d)?.free ?? 0), 0);
  const phonePick = phoneDevice || names[0] || "";

  const openGroups: MenuItem[][] = [
    names.map((name) => ({
      label: name,
      icon: <Led tone={tones[name] ?? "off"} />,
      onSelect: () => addPane(name),
    })),
    bookmarks.map((item) => ({
      label: `${item.device}:${item.path}`,
      icon: <Star />,
      onSelect: () => {
        const pane = panes.find((p) => p.device === item.device);
        if (pane) pane.reveal(item.path);
        else addPane(item.device, item.path);
      },
    })),
  ].filter((group) => group.length > 0);
  const workspaceGroups: MenuItem[][] = [
    workspaces.map((item) => ({
      label: item.name,
      icon: <Layers />,
      onSelect: () => {
        try {
          dock.current?.fromJSON(item.layout as Parameters<DockviewApi["fromJSON"]>[0]);
        } catch {
          /* a layout from an older version: leave the panes as they are */
        }
      },
    })),
    [{ label: "Save these panes as…", icon: <Plus />, onSelect: () => setSaving(true) }],
    workspaces.map((item) => ({
      label: `Delete ${item.name}`,
      icon: <Trash2 />,
      danger: true,
      onSelect: () => workspaceStore.set(workspaces.filter((w) => w.name !== item.name)),
    })),
  ].filter((group) => group.length > 0);
  const option = (on: boolean, label: string, hint: string, toggle: () => void): MenuItem => ({
    label: (
      <span className="fl-opt">
        {label}
        <small>{hint}</small>
      </span>
    ),
    icon: on ? <Check /> : <span />,
    onSelect: toggle,
  });
  const copyGroups: MenuItem[][] = [
    [
      option(
        broadcasting,
        "Upload to all",
        "An upload to one pane goes to the same folder on every open router.",
        () => broadcastStore.set(!broadcasting),
      ),
      option(
        direct,
        "Direct copy",
        "The destination router fetches a large file from the source itself, when it can reach it. It gets the source's SSH password for that one command.",
        () => directStore.set(!direct),
      ),
      option(verify, "Verify", "After a copy, compare the SHA-256 of both sides.", () =>
        verifyStore.set(!verify),
      ),
    ],
  ];

  return (
    <div className="files-page" data-phone={phone || undefined}>
      {!phone && (
        <>
          <header className="fl-head">
            <div className="t">
              <p className="fl-eb">Router configuration · Files</p>
              <h1 className="fl-h1">
                {openDevices.length === 0 ? (
                  "No router open."
                ) : (
                  <>
                    <Count value={openDevices.length} />{" "}
                    {openDevices.length === 1 ? "router" : "routers"} open · {size(free)} free
                    across them.
                  </>
                )}
              </h1>
              <p className="fl-lead">
                Browse, copy and edit router files side by side. Drag between panes to copy; deleted
                and replaced files wait 7 days in the recycle bin.
              </p>
            </div>
            <form
              className="fl-search"
              role="search"
              onSubmit={(event) => {
                event.preventDefault();
                search();
              }}
            >
              <TextInput
                value={query}
                onChange={setQuery}
                placeholder="Search names or contents on every open router"
                label="Search the files of every open router"
                icon={<Search aria-hidden="true" />}
                end={
                  <span className="opt">
                    {(
                      [
                        ["Aa", matchCase, setMatchCase, "Match case"],
                        [
                          "Contents",
                          contents,
                          setContents,
                          "Search the text inside small text files (.rsc, .txt, .log, …) instead of the names",
                        ],
                        [".*", regex, setRegex, "The search text is a regular expression"],
                      ] as const
                    ).map(([text, on, set, title]) => (
                      <button
                        key={text}
                        type="button"
                        aria-pressed={on}
                        data-on={on || undefined}
                        title={title}
                        onClick={() => set(!on)}
                      >
                        {text}
                      </button>
                    ))}
                  </span>
                }
              />
            </form>
          </header>

          <div className="fl-bar" role="toolbar" aria-label="Files tools">
            <Menu
              label="Open a router"
              align="start"
              groups={openGroups}
              trigger={
                <button type="button" className="fl-chip" data-tone="add">
                  <Plus size={16} />
                  Open a router
                  <ChevronDown size={16} />
                </button>
              }
            />
            <span className="fl-sep" />
            <button
              type="button"
              className="fl-chip"
              disabled={panes.length < 2}
              onClick={() => syncStore.set(true)}
              title="Compare the open folders of two panes, and copy what is missing"
            >
              <ArrowLeftRight size={14} />
              Compare folders
            </button>
            <button type="button" className="fl-chip" onClick={() => openTool("storage")}>
              <ChartPie size={14} />
              Storage
            </button>
            <button type="button" className="fl-chip" onClick={() => openTool("vault")}>
              <Vault size={14} />
              Vault
              {counts.vault !== undefined && (
                <span className="c">
                  <Count value={counts.vault} />
                </span>
              )}
            </button>
            <button type="button" className="fl-chip" onClick={() => openTool("jobs")}>
              <CalendarClock size={14} />
              Scheduled
              {counts.jobs !== undefined && (
                <span className="c">
                  <Count value={counts.jobs} />
                </span>
              )}
            </button>
            {state.trash && (
              <button type="button" className="fl-chip" onClick={() => openTool("trash")}>
                <Trash2 size={14} />
                Recycle bin
                {counts.trash !== undefined && (
                  <span className="c">
                    <Count value={counts.trash} />
                  </span>
                )}
              </button>
            )}
            <span className="sp" />
            <Menu
              label="Workspaces"
              groups={workspaceGroups}
              trigger={
                <button type="button" className="fl-chip">
                  <Layers size={16} />
                  Workspaces
                  {workspaces.length > 0 && <span className="c">{workspaces.length}</span>}
                </button>
              }
            />
            {!readOnly && (
              <>
                <span className="fl-sep" />
                <Menu
                  label="Copy options"
                  groups={copyGroups}
                  trigger={
                    <button
                      type="button"
                      className="fl-chip"
                      data-on={broadcasting || direct || verify || undefined}
                    >
                      <SlidersHorizontal size={16} />
                      Copy options
                      <ChevronDown size={16} />
                    </button>
                  }
                />
              </>
            )}
          </div>
          {saving && (
            <form
              className="fl-save"
              onSubmit={(event) => {
                event.preventDefault();
                const name = workspaceName.trim();
                if (!name || !dock.current) return;
                workspaceStore.set([
                  ...workspaces.filter((w) => w.name !== name),
                  { name, layout: dock.current.toJSON() },
                ]);
                setWorkspaceName("");
                setSaving(false);
              }}
            >
              <Strip
                icon={<Layers size={15} />}
                actions={
                  <>
                    <button type="button" className="fp-act" onClick={() => setSaving(false)}>
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="fp-act"
                      data-tone="primary"
                      disabled={!workspaceName.trim()}
                    >
                      Save
                    </button>
                  </>
                }
              >
                <TextInput
                  size="sm"
                  value={workspaceName}
                  onChange={setWorkspaceName}
                  placeholder="Save these panes as…"
                  label="Workspace name"
                  maxLength={40}
                  // eslint-disable-next-line jsx-a11y/no-autofocus -- opened by a click
                  autoFocus
                />
              </Strip>
            </form>
          )}
        </>
      )}

      {phone ? (
        <div className="fl-phone">
          <div className="fl-phone-tabs" role="tablist" aria-label="Routers">
            {names.map((name) => (
              <button
                key={name}
                type="button"
                role="tab"
                aria-selected={name === phonePick}
                className="fl-chip"
                data-tone={name === phonePick ? "router" : undefined}
                onClick={() => setPhoneDevice(name)}
              >
                <Led tone={tones[name] ?? "off"} />
                {name}
              </button>
            ))}
          </div>
          {phonePick && (
            <FilesPane
              key={phonePick}
              id={`phone-${phonePick}`}
              device={phonePick}
              path="/"
              readOnly={readOnly}
              trash={state.trash === true}
              s3={state.s3 === true}
              phone
              active
            />
          )}
        </div>
      ) : (
        <div className="fl-body">
          <div className="fl-dockwrap" ref={dockRoot}>
            <DockviewReact
              components={components}
              defaultTabComponent={FilesTab}
              onReady={onReady}
              theme={THEME}
            />
            {panes.length === 0 && (
              <div className="fl-nopane">
                <p>No router is open.</p>
                <div>
                  {names.map((name) => (
                    <button
                      key={name}
                      type="button"
                      className="fl-chip"
                      onClick={() => addPane(name)}
                    >
                      <Plus size={13} /> {name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {hits !== null && (
            <aside className="fl-results" aria-label="Search results">
              <header>
                <b>
                  {shownHits.length} {shownHits.length === 1 ? "match" : "matches"}
                </b>
                <span className="m">{searching ? "searching…" : `${answers.length} routers`}</span>
                <span className="sp" />
                {searching && (
                  <button
                    type="button"
                    className="fp-ib"
                    onClick={() => running.current?.abort()}
                    aria-label="Stop the search"
                  >
                    <Square size={12} />
                  </button>
                )}
                <button
                  type="button"
                  className="fp-ib"
                  aria-label="Close the results"
                  onClick={() => {
                    running.current?.abort();
                    setHits(null);
                  }}
                >
                  <X size={14} />
                </button>
              </header>
              {searchError && <Strip tone="danger">{searchError}</Strip>}
              <div className="list">
                {Array.from(new Set([...grouped.keys(), ...answers.map((a) => a.device)])).map(
                  (device) => {
                    const answer = answers.find((a) => a.device === device);
                    const rows = grouped.get(device) ?? [];
                    return (
                      <section key={device}>
                        <h3>
                          <Led tone={tones[device] ?? "off"} />
                          {device}
                          <small>
                            {rows.length}
                            {answer && ` of ${answer.scanned} scanned`}
                            {answer?.truncated && " · stopped early"}
                          </small>
                        </h3>
                        {answer?.error && <Strip tone="danger">{answer.error}</Strip>}
                        {rows.map((hit) => (
                          <button
                            key={`${hit.path}:${hit.line ?? 0}`}
                            type="button"
                            className="fl-hit"
                            onClick={() => show(hit)}
                            title="Show in the router's pane"
                          >
                            <span className="n">
                              <Marked
                                text={baseName(hit.path)}
                                query={hit.line || searched.regex ? "" : searched.q}
                              />
                              {hit.line !== undefined && <em>:{hit.line}</em>}
                            </span>
                            <small>
                              {parentOf(hit.path)} · {hit.dir ? "folder" : size(hit.size)} ·{" "}
                              {stamp(hit.mtime)}
                            </small>
                            {hit.text !== undefined && (
                              <code>
                                <Marked
                                  text={hit.text.trim()}
                                  query={searched.regex ? "" : searched.q}
                                />
                              </code>
                            )}
                          </button>
                        ))}
                      </section>
                    );
                  },
                )}
                {!searching && shownHits.length === 0 && !searchError && (
                  <p className="fl-empty">Nothing matches on the open routers.</p>
                )}
              </div>
            </aside>
          )}
        </div>
      )}

      <FileViewer readOnly={readOnly} />
      <FileCompare />
      <ToolsDrawer readOnly={readOnly} trash={state.trash === true} routers={names} />
      <ImportDialog />
      <FolderSync readOnly={readOnly} />

      {transfers.length > 0 && !phone && (
        <section className="fl-tx-dock" data-open={dockOpen || undefined} aria-label="Transfers">
          <div className="fl-tx-hd">
            <button
              type="button"
              className="tg"
              onClick={() => setDockOpen((open) => !open)}
              aria-expanded={dockOpen}
            >
              <ChevronDown size={15} />
              <b>Transfers</b>
            </button>
            <span className="m">
              {active.length > 0 ? `${active.length} running` : "all done"}
              {finished > 0 && ` · ${finished} finished`} · 3 at a time
            </span>
            <span className="sp" />
            {active.length > 0 && (
              <>
                <span className="fl-tx-all" aria-hidden="true">
                  <i style={{ width: `${allPct}%` }} />
                </span>
                <span className="m">
                  {allPct}% · {size(doneBytes)} of {size(totalBytes)}
                </span>
              </>
            )}
            {finished > 0 && (
              <button
                type="button"
                className="fp-act"
                onClick={() => transferQueue.clearFinished()}
              >
                Clear finished
              </button>
            )}
          </div>
          {dockOpen && (
            <div className="fl-tx-rows">
              {[...transfers].reverse().map((item) => (
                <TransferRow key={item.id} item={item} />
              ))}
            </div>
          )}
        </section>
      )}
      {transfers.length > 0 && phone && (
        <div className="fl-tx-pill" role="status">
          <span className="fl-tx-all" aria-hidden="true">
            <i style={{ width: `${active.length ? allPct : 100}%` }} />
          </span>
          {active.length > 0
            ? `${active.length} ${active.length === 1 ? "transfer" : "transfers"} · ${allPct}%`
            : "Transfers done"}
          <span className="m">
            {(() => {
              const first = active.find((item) => item.status === "active");
              return first ? timeLeft(pace(first).left) : "";
            })()}
          </span>
        </div>
      )}
    </div>
  );
}
