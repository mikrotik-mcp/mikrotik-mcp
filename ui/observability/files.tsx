/**
 * Files page — the files of several routers side by side, in dockable panes.
 *
 * Search runs on every open router at once (names, or the text inside small
 * text files). Every upload, download and router-to-router copy goes through
 * one queue, shown with its progress at the bottom of the page.
 */
import type { DockviewApi, DockviewReadyEvent } from "dockview-react";
import { DockviewReact, themeAbyss } from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import {
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  CircleAlert,
  FolderSync as FolderSyncIcon,
  Plus,
  Radio,
  RotateCw,
  Search,
  ShieldAlert,
  Square,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { api } from "./api";
import { bytes } from "./format";
import type { FilesState, SearchDone, SearchHit, Transfer } from "./files-lib";
import {
  baseName,
  broadcastStore,
  filePanes,
  filesApi,
  filesLayout,
  pace,
  syncStore,
  parentOf,
  transferQueue,
  when,
} from "./files-lib";
import { FileCompare } from "./files-compare";
import { FilesPane } from "./files-pane";
import { FolderSync } from "./files-sync";
import { FileViewer } from "./files-viewer";
import { PaneTab } from "./terminal-tab";
import type { DevicesPayload } from "./types";
import "./terminal.css";
import "./files.css";

const components = { files: FilesPane };
const KIND_ICON = { upload: ArrowUpFromLine, download: ArrowDownToLine, copy: ArrowLeftRight };

/** `1m 20s`, `45s`, or nothing while the speed is unknown. */
function timeLeft(seconds: number): string {
  if (!Number.isFinite(seconds)) return "";
  const whole = Math.ceil(seconds);
  return whole >= 60 ? `${Math.floor(whole / 60)}m ${whole % 60}s left` : `${whole}s left`;
}

function TransferRow({ item }: { item: Transfer }): ReactNode {
  const Icon = KIND_ICON[item.kind];
  const part =
    item.total > 0 ? Math.min(item.done / item.total, 1) : item.status === "done" ? 1 : 0;
  const live = item.status === "active" ? pace(item) : null;
  return (
    <li className="files-transfer" data-status={item.status}>
      <Icon size={15} />
      <div>
        <p>
          <strong title={item.name}>{item.name}</strong>
          <span>
            {item.from} → {item.to}
          </span>
        </p>
        <div className="files-bar" role="progressbar" aria-valuenow={Math.round(part * 100)}>
          <i style={{ width: `${part * 100}%` }} />
        </div>
        <small>
          {item.status === "active" && live && (
            <>
              {bytes(item.done)} of {bytes(item.total)} · {bytes(live.speed)}/s ·{" "}
              {timeLeft(live.left)}
            </>
          )}
          {item.status === "queued" && "Waiting"}
          {item.status === "done" &&
            `${bytes(item.total)} · done in ${(((item.finished ?? 0) - (item.started ?? 0)) / 1000).toFixed(1)}s`}
          {item.status === "stopped" && "Stopped"}
          {item.status === "error" && (item.error ?? "Failed")}
        </small>
      </div>
      <span className="files-transfer-state">
        {item.status === "done" && <Check size={15} />}
        {item.status === "error" && <CircleAlert size={15} />}
        {(item.status === "active" || item.status === "queued") && (
          <button type="button" onClick={() => transferQueue.stop(item.id)} title="Stop">
            <Square size={12} />
          </button>
        )}
        {(item.status === "error" || item.status === "stopped") && (
          <button type="button" onClick={() => transferQueue.retry(item.id)} title="Try again">
            <RotateCw size={13} />
          </button>
        )}
      </span>
    </li>
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
  const [contents, setContents] = useState(false);
  const [regex, setRegex] = useState(false);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [answers, setAnswers] = useState<SearchDone[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState("");
  const [searchError, setSearchError] = useState("");
  const [dockOpen, setDockOpen] = useState(true);
  const dock = useRef<DockviewApi | null>(null);
  const running = useRef<AbortController | null>(null);
  const transfers = useSyncExternalStore(transferQueue.subscribe, transferQueue.get);
  const panes = useSyncExternalStore(filePanes.subscribe, filePanes.all);
  const broadcasting = useSyncExternalStore(broadcastStore.subscribe, broadcastStore.get);
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
  const readOnly = state?.readOnly === true;

  const addPane = useCallback(
    (device: string, path = "/"): void => {
      const view = dock.current;
      if (!view || !device) return;
      const same = view.panels.filter((p) => (p.params as { device?: string })?.device === device);
      const reference = view.activePanel;
      view.addPanel({
        id: `files-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        component: "files",
        title: same.length ? `${device} · ${same.length + 1}` : device,
        params: { device, path, readOnly },
        position: reference ? { referencePanel: reference.id, direction: "right" } : undefined,
      });
    },
    [readOnly],
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
    setSearched(regex ? "" : q);
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

  if (!state || !devices) return <div className="term-page term-loading">Opening files…</div>;
  if (!state.enabled) {
    return (
      <div className="term-page">
        <div className="term-locked">
          <ShieldAlert size={28} />
          <h2>Files is locked</h2>
          <p>{state.reason}</p>
        </div>
      </div>
    );
  }

  const grouped = new Map<string, SearchHit[]>();
  for (const hit of hits ?? []) grouped.set(hit.device, [...(grouped.get(hit.device) ?? []), hit]);
  const finished = transfers.length - active.length;
  const totalBytes = active.reduce((sum, item) => sum + item.total, 0);
  const doneBytes = active.reduce((sum, item) => sum + item.done, 0);

  return (
    <div className="term-page files-page">
      <div className="term-toolbar">
        <div className="term-devices" role="group" aria-label="Open the files of a router">
          <span className="term-toolbar-label">
            <Plus size={13} /> Open files of
          </span>
          {names.map((name) => (
            <button key={name} type="button" className="term-device" onClick={() => addPane(name)}>
              {name}
            </button>
          ))}
        </div>
        <div className="term-tools">
          <button
            type="button"
            disabled={panes.length < 2}
            onClick={() => syncStore.set(true)}
            title="Compare the open folders of two panes, and copy what is missing"
          >
            <FolderSyncIcon size={13} /> Compare folders
          </button>
        </div>
        {!readOnly && (
          <div className="term-tools">
            <button
              type="button"
              data-on={broadcasting}
              aria-pressed={broadcasting}
              onClick={() => broadcastStore.set(!broadcasting)}
              title="An upload to one pane goes to the same folder on every open router"
            >
              <Radio size={13} /> Upload to all
            </button>
          </div>
        )}
        <form
          className="files-search"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            search();
          }}
        >
          <Search size={14} />
          <input
            value={query}
            placeholder={
              contents
                ? "Search inside the files of every open router"
                : "Search file names on every open router"
            }
            aria-label="Search the files of every open router"
            onChange={(event) => setQuery(event.target.value)}
          />
          <label title="Search the text inside small text files (.rsc, .txt, .log, …) instead of the names">
            <Checkbox checked={contents} onCheckedChange={(on) => setContents(on === true)} />{" "}
            Contents
          </label>
          <label title="The search text is a regular expression">
            <Checkbox checked={regex} onCheckedChange={(on) => setRegex(on === true)} /> Regex
          </label>
          <button type="submit" disabled={!query.trim() || panes.length === 0}>
            Search
          </button>
        </form>
      </div>

      <div className="term-body">
        <div className="term-dock">
          <DockviewReact
            components={components}
            defaultTabComponent={PaneTab}
            onReady={onReady}
            theme={themeAbyss}
          />
          {panes.length === 0 && (
            <div className="term-nopane">
              <p>No router is open.</p>
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

        {hits !== null && (
          <aside className="files-results" aria-label="Search results">
            <header>
              <strong>
                {hits.length} {hits.length === 1 ? "match" : "matches"}
              </strong>
              <span>{searching ? "searching…" : `${answers.length} routers`}</span>
              {searching && (
                <button
                  type="button"
                  onClick={() => running.current?.abort()}
                  title="Stop the search"
                >
                  <Square size={12} />
                </button>
              )}
              <button
                type="button"
                aria-label="Close the results"
                onClick={() => {
                  running.current?.abort();
                  setHits(null);
                }}
              >
                <X size={14} />
              </button>
            </header>
            {searchError && (
              <p className="files-empty" data-tone="danger">
                {searchError}
              </p>
            )}
            <div>
              {Array.from(new Set([...grouped.keys(), ...answers.map((a) => a.device)])).map(
                (device) => {
                  const answer = answers.find((a) => a.device === device);
                  const rows = grouped.get(device) ?? [];
                  return (
                    <section key={device}>
                      <h3>
                        {device}
                        <small>
                          {rows.length}
                          {answer && ` of ${answer.scanned} scanned`}
                          {answer?.truncated && " · stopped early"}
                        </small>
                      </h3>
                      {answer?.error && (
                        <p className="files-empty" data-tone="danger">
                          {answer.error}
                        </p>
                      )}
                      {rows.map((hit) => (
                        <button
                          key={`${hit.path}:${hit.line ?? 0}`}
                          type="button"
                          className="files-hit"
                          onClick={() => show(hit)}
                          title="Show in the router's pane"
                        >
                          <span>
                            <Marked text={baseName(hit.path)} query={hit.line ? "" : searched} />
                            {hit.line !== undefined && <em>:{hit.line}</em>}
                          </span>
                          <small>
                            {parentOf(hit.path)} · {hit.dir ? "folder" : bytes(hit.size)} ·{" "}
                            {when(hit.mtime)}
                          </small>
                          {hit.text !== undefined && (
                            <code>
                              <Marked text={hit.text.trim()} query={searched} />
                            </code>
                          )}
                        </button>
                      ))}
                    </section>
                  );
                },
              )}
              {!searching && hits.length === 0 && !searchError && (
                <p className="files-empty">Nothing matches on the open routers.</p>
              )}
            </div>
          </aside>
        )}
      </div>

      <FileViewer readOnly={readOnly} />
      <FileCompare />
      <FolderSync readOnly={readOnly} />

      {transfers.length > 0 && (
        <section className="files-transfers" data-open={dockOpen} aria-label="Transfers">
          <header>
            <button
              type="button"
              onClick={() => setDockOpen((open) => !open)}
              aria-expanded={dockOpen}
            >
              <ChevronDown size={14} />
              <strong>Transfers</strong>
            </button>
            <span>
              {active.length > 0 ? `${active.length} running` : "all done"}
              {finished > 0 && ` · ${finished} finished`}
            </span>
            {active.length > 0 && (
              <div className="files-bar" data-total="true">
                <i style={{ width: `${totalBytes ? (doneBytes / totalBytes) * 100 : 0}%` }} />
              </div>
            )}
            {finished > 0 && (
              <button type="button" onClick={() => transferQueue.clearFinished()}>
                Clear finished
              </button>
            )}
          </header>
          {dockOpen && (
            <ul>
              {[...transfers].reverse().map((item) => (
                <TransferRow key={item.id} item={item} />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
