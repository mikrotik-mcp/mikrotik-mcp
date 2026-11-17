/**
 * One Files pane: the files of one router, one folder at a time.
 *
 * Drop files from the computer to upload them. Drag rows to another pane (or to
 * a folder) to copy them there; the server relays a router-to-router copy.
 */
import type { IDockviewPanelProps } from "dockview-react";
import {
  Archive,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpFromLine,
  ChevronRight,
  CornerLeftUp,
  Eye,
  File,
  FileArchive,
  FileCode2,
  FileImage,
  FileKey2,
  FileText,
  Fingerprint,
  Folder,
  FolderPlus,
  GitCompareArrows,
  Globe,
  HardDrive,
  LifeBuoy,
  Package,
  Pencil,
  Play,
  RefreshCw,
  Send,
  Trash2,
  X,
} from "lucide-react";
import type { DragEvent, KeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { bytes } from "./format";
import { Select } from "./geist";
import type { FileEntry, FileKind, RouterSystem } from "./files-lib";
import {
  DRAG_TYPE,
  broadcastStore,
  droppedFiles,
  canPreview,
  compareStore,
  conflicts,
  dragState,
  filePanes,
  filesApi,
  filesBus,
  importStore,
  joinPath,
  kindOf,
  packageWarnings,
  parentOf,
  pickForCompare,
  transferQueue,
  uploadTargets,
  viewerStore,
  when,
} from "./files-lib";

const ICONS: Record<FileKind, typeof File> = {
  folder: Folder,
  backup: FileArchive,
  script: FileCode2,
  package: Package,
  text: FileText,
  key: FileKey2,
  support: LifeBuoy,
  web: Globe,
  image: FileImage,
  file: File,
};

type SortKey = "name" | "size" | "mtime";

/** A drop that waits for an answer because some names already exist. */
interface PendingDrop {
  dir: string;
  existing: string[];
  start: (skip: Set<string>) => void;
}

export function FilesPane(
  props: IDockviewPanelProps<{ device: string; path?: string; readOnly?: boolean }>,
): ReactNode {
  const { api } = props;
  const device = props.params.device;
  const readOnly = props.params.readOnly === true;
  const [path, setPath] = useState(props.params.path ?? "/");
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; down: boolean }>({ key: "name", down: false });
  const [usage, setUsage] = useState<RouterSystem>({});
  /** Where a drag is hovering: a folder name, or "" for the open folder. */
  const [over, setOver] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingDrop | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [packageCheck, setPackageCheck] = useState<{ warnings: string[]; go: () => void } | null>(
    null,
  );
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState("");
  const anchor = useRef<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const reveal = useRef<string | undefined>(undefined);
  const others = useSyncExternalStore(filePanes.subscribe, filePanes.all);
  const broadcasting = useSyncExternalStore(broadcastStore.subscribe, broadcastStore.get);

  const load = useCallback(
    (dir: string): void => {
      setBusy(true);
      filesApi
        .list(device, dir)
        .then((list) => {
          setEntries(list);
          setError("");
          const wanted = reveal.current;
          reveal.current = undefined;
          setSelected((now) =>
            wanted
              ? new Set([wanted])
              : new Set(list.filter((entry) => now.has(entry.name)).map((entry) => entry.name)),
          );
        })
        .catch((e: unknown) => {
          setEntries([]);
          setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => setBusy(false));
    },
    [device],
  );

  const open = useCallback((dir: string, name?: string): void => {
    reveal.current = name;
    setFilter("");
    setRenaming(null);
    setCreating(false);
    setConfirmDelete(false);
    setEntries(null);
    setPath(dir);
  }, []);

  useEffect(() => {
    load(path);
    api.updateParameters({ ...api.getParameters(), path });
  }, [api, load, path]);

  useEffect(() => {
    const refreshUsage = (): void => {
      filesApi
        .usage(device)
        .then(setUsage)
        .catch(() => {});
    };
    refreshUsage();
    return filesBus.subscribe((changedDevice, dir) => {
      if (changedDevice !== device) return;
      refreshUsage();
      if (dir === path) load(path);
    });
  }, [device, load, path]);

  useEffect(() => {
    filePanes.set(api.id, {
      device,
      path,
      reveal: (dir, name) => {
        if (dir === path) {
          reveal.current = name;
          load(path);
        } else open(dir, name);
        api.setActive();
      },
    });
  }, [api, device, load, open, path]);
  useEffect(() => () => filePanes.remove(api.id), [api.id]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const rows = (entries ?? []).filter((entry) => entry.name.toLowerCase().includes(needle));
    const order = sort.down ? -1 : 1;
    return rows.sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      const delta = sort.key === "name" ? a.name.localeCompare(b.name) : a[sort.key] - b[sort.key];
      return (delta || a.name.localeCompare(b.name)) * order;
    });
  }, [entries, filter, sort]);

  const chosen = useMemo(
    () => shown.filter((entry) => selected.has(entry.name)),
    [shown, selected],
  );
  const chosenFiles = chosen.filter((entry) => !entry.dir);

  const pick = (
    entry: FileEntry,
    event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
  ): void => {
    if (event.shiftKey && anchor.current) {
      const from = shown.findIndex((row) => row.name === anchor.current);
      const to = shown.findIndex((row) => row.name === entry.name);
      if (from >= 0 && to >= 0) {
        setSelected(
          new Set(shown.slice(Math.min(from, to), Math.max(from, to) + 1).map((r) => r.name)),
        );
        return;
      }
    }
    anchor.current = entry.name;
    if (event.metaKey || event.ctrlKey) {
      const next = new Set(selected);
      if (!next.delete(entry.name)) next.add(entry.name);
      setSelected(next);
    } else setSelected(new Set([entry.name]));
  };

  const activate = (entry: FileEntry): void => {
    if (entry.dir) open(joinPath(path, entry.name));
    else if (canPreview(entry)) viewerStore.set({ device, path: joinPath(path, entry.name) });
    else transferQueue.download(device, joinPath(path, entry.name), entry.size);
  };

  /** Ask before replacing files that the folder already has. */
  const plan = async (
    dir: string,
    names: string[],
    start: (skip: Set<string>) => void,
  ): Promise<void> => {
    if (names.length === 0) return;
    let existing: FileEntry[] = [];
    try {
      existing = dir === path && entries ? entries : await filesApi.list(device, dir);
    } catch {
      /* the transfer itself will report an unreadable folder */
    }
    const clash = conflicts(existing, names);
    if (clash.length === 0) start(new Set());
    else setPending({ dir, existing: clash, start });
  };

  /** `sub` is the folder of a file below `dir`, for a dropped folder. */
  const upload = (dir: string, items: { file: File; sub: string }[], checked = false): void => {
    // A package for another architecture or version never installs: say so first.
    const warnings = checked ? [] : items.flatMap((item) => packageWarnings(item.file.name, usage));
    if (warnings.length > 0)
      return setPackageCheck({ warnings, go: () => upload(dir, items, true) });
    const top = (item: { file: File; sub: string }): string =>
      item.sub.split("/")[0] || item.file.name;
    void plan(dir, Array.from(new Set(items.map(top))), (skip) => {
      for (const item of items)
        if (!skip.has(top(item)))
          for (const target of uploadTargets(device))
            transferQueue.upload(target, item.sub ? joinPath(dir, item.sub) : dir, item.file);
    });
  };

  const copyHere = (
    dir: string,
    source: { device: string; dir: string; entries: FileEntry[] },
  ): void => {
    if (source.device === device && source.dir === dir) return;
    void plan(
      dir,
      source.entries.map((entry) => entry.name),
      (skip) => {
        for (const entry of source.entries) {
          if (skip.has(entry.name)) continue;
          const from = joinPath(source.dir, entry.name);
          if (!entry.dir) {
            transferQueue.copy(
              { device: source.device, path: from, size: entry.size },
              { device, dir },
            );
            continue;
          }
          // A folder: every file in it, each to the same place below the target.
          filesApi
            .tree(source.device, from)
            .then((tree) => {
              if (tree.truncated) setNotice(`${entry.name} is very large: only a part was copied.`);
              const cut = source.dir === "/" ? 0 : source.dir.length;
              for (const file of tree.files)
                transferQueue.copy(
                  { device: source.device, path: file.path, size: file.size },
                  { device, dir: `${dir === "/" ? "" : dir}${parentOf(file.path).slice(cut)}` },
                );
            })
            .catch((e: unknown) => setNotice(e instanceof Error ? e.message : String(e)));
        }
      },
    );
  };

  const onDrop = (event: DragEvent, dir: string): void => {
    event.preventDefault();
    event.stopPropagation();
    setOver(null);
    if (readOnly) return;
    const internal = event.dataTransfer.types.includes(DRAG_TYPE) ? dragState.current : null;
    dragState.current = null;
    if (internal) return copyHere(dir, internal);
    droppedFiles(event.dataTransfer)
      .then((items) => upload(dir, items))
      .catch(() => setNotice("The dropped files could not be read."));
  };

  const onDragOver = (event: DragEvent, target: string): void => {
    const types = event.dataTransfer.types;
    if (readOnly || !(types.includes(DRAG_TYPE) || types.includes("Files"))) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    if (over !== target) setOver(target);
  };

  const act = (work: Promise<void>): void => {
    setBusy(true);
    work
      .catch((e: unknown) => setNotice(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        setRenaming(null);
        setCreating(false);
        setConfirmDelete(false);
        filesBus.changed(device, path);
      });
  };

  const submitDraft = (): void => {
    const name = draft.trim();
    if (!name || name.includes("/")) return setNotice("Type a name without '/'.");
    if (creating) act(filesApi.mkdir(device, joinPath(path, name)));
    else if (renaming && name !== renaming)
      act(filesApi.rename(device, joinPath(path, renaming), joinPath(path, name)));
    else setRenaming(null);
  };

  const onKey = (event: KeyboardEvent): void => {
    if ((event.target as HTMLElement).tagName === "INPUT") return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setSelected(new Set(shown.map((entry) => entry.name)));
    } else if (event.key === "Escape") setSelected(new Set());
    else if (event.key === "Enter" && chosen.length === 1 && chosen[0]) activate(chosen[0]);
    else if ((event.key === "Delete" || event.key === "Backspace") && chosen.length && !readOnly)
      setConfirmDelete(true);
    else if (event.key === "F2" && chosen.length === 1 && chosen[0] && !readOnly) {
      setDraft(chosen[0].name);
      setRenaming(chosen[0].name);
    }
  };

  const crumbs = path.split("/").filter(Boolean);
  const used = usage.total && usage.free !== undefined ? 1 - usage.free / usage.total : null;
  const targets = useMemo(() => {
    const seen = new Set<string>();
    return others
      .filter((pane) => !(pane.device === device && pane.path === path))
      .map((pane) => ({
        value: `${pane.device}\n${pane.path}`,
        label: `${pane.device}:${pane.path}`,
      }))
      .filter((option) => !seen.has(option.value) && seen.add(option.value));
  }, [others, device, path]);
  const dragLabel =
    over === null
      ? ""
      : dragState.current
        ? `Copy ${dragState.current.entries.length} from ${dragState.current.device}`
        : broadcasting
          ? "Drop to upload to every open router"
          : "Drop to upload";
  const sortBy = (key: SortKey): void =>
    setSort((now) => ({ key, down: now.key === key ? !now.down : key !== "name" }));

  return (
    <div
      className="files-pane"
      data-over={over !== null}
      onDragOver={(event) => onDragOver(event, "")}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null);
      }}
      onDrop={(event) => onDrop(event, path)}
    >
      <header className="files-head">
        <nav className="files-crumbs" aria-label="Folder">
          <button type="button" onClick={() => open("/")} title={`${device}: root`}>
            <HardDrive size={13} />
            <span>{device}</span>
          </button>
          {crumbs.map((part, index) => (
            // eslint-disable-next-line react/no-array-index-key -- a path may repeat a name
            <span key={index}>
              <ChevronRight size={12} />
              <button
                type="button"
                onClick={() => open(`/${crumbs.slice(0, index + 1).join("/")}`)}
              >
                {part}
              </button>
            </span>
          ))}
        </nav>
        <div className="files-actions">
          <input
            className="files-filter"
            value={filter}
            placeholder="Filter this folder"
            aria-label="Filter this folder"
            onChange={(event) => setFilter(event.target.value)}
          />
          <button
            type="button"
            disabled={path === "/"}
            onClick={() => open(parentOf(path))}
            title="Up one folder"
          >
            <CornerLeftUp size={14} />
          </button>
          <button type="button" onClick={() => load(path)} title="Reload" data-spin={busy}>
            <RefreshCw size={14} />
          </button>
          {!readOnly && (
            <>
              <button
                type="button"
                title="New folder"
                onClick={() => {
                  setDraft("");
                  setRenaming(null);
                  setCreating(true);
                }}
              >
                <FolderPlus size={14} />
              </button>
              <details className="files-more">
                <summary title="Have the router make a file">
                  <Archive size={14} />
                </summary>
                <div>
                  {(["backup", "export"] as const).map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      onClick={(event) => {
                        event.currentTarget.closest("details")?.removeAttribute("open");
                        setBusy(true);
                        filesApi
                          .make(device, kind)
                          .then((file) => setNotice(`${device} made ${file}.`))
                          .catch((e: unknown) =>
                            setNotice(e instanceof Error ? e.message : String(e)),
                          )
                          .finally(() => setBusy(false));
                      }}
                    >
                      {kind === "backup" ? "Backup now (.backup)" : "Export now (.rsc)"}
                    </button>
                  ))}
                </div>
              </details>
              <button
                type="button"
                className="files-upload"
                onClick={() => picker.current?.click()}
              >
                <ArrowUpFromLine size={14} /> <span>Upload</span>
              </button>
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                onChange={(event) => {
                  upload(
                    path,
                    Array.from(event.target.files ?? []).map((file) => ({ file, sub: "" })),
                  );
                  event.target.value = "";
                }}
              />
            </>
          )}
        </div>
      </header>

      {used !== null && (
        <div className="files-usage" title="Storage of the router">
          <span>
            <i style={{ width: `${Math.round(used * 100)}%` }} data-high={used > 0.85} />
          </span>
          <small>
            {bytes(usage.free ?? 0)} free of {bytes(usage.total ?? 0)}
            {usage.arch && ` · ${usage.arch} · ${usage.version ?? ""}`}
          </small>
        </div>
      )}

      {notice && (
        <div className="files-strip" data-tone="warn" role="status">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice("")} aria-label="Dismiss">
            <X size={13} />
          </button>
        </div>
      )}
      {packageCheck && (
        <div
          className="files-strip"
          data-tone="danger"
          role="alertdialog"
          aria-label="Package check"
        >
          <span>{packageCheck.warnings.join("\n")}</span>
          <button
            type="button"
            onClick={() => {
              packageCheck.go();
              setPackageCheck(null);
            }}
          >
            Upload anyway
          </button>
          <button type="button" onClick={() => setPackageCheck(null)}>
            Cancel
          </button>
        </div>
      )}
      {pending && (
        <div className="files-strip" data-tone="warn" role="alertdialog" aria-label="Replace files">
          <span>
            <strong>{pending.existing.length}</strong> already in {pending.dir}:{" "}
            {pending.existing.slice(0, 3).join(", ")}
            {pending.existing.length > 3 && "…"}
          </span>
          <button
            type="button"
            onClick={() => {
              pending.start(new Set());
              setPending(null);
            }}
          >
            Replace
          </button>
          <button
            type="button"
            onClick={() => {
              pending.start(new Set(pending.existing));
              setPending(null);
            }}
          >
            Skip these
          </button>
          <button type="button" onClick={() => setPending(null)}>
            Cancel
          </button>
        </div>
      )}
      {confirmDelete && chosen.length > 0 && (
        <div
          className="files-strip"
          data-tone="danger"
          role="alertdialog"
          aria-label="Delete files"
        >
          <span>
            Delete <strong>{chosen.length}</strong> from {device}? Folders go with everything in
            them. This cannot be undone.
          </span>
          <button
            type="button"
            data-danger="true"
            onClick={() =>
              act(
                filesApi.remove(
                  device,
                  chosen.map((entry) => joinPath(path, entry.name)),
                ),
              )
            }
          >
            Delete
          </button>
          <button type="button" onClick={() => setConfirmDelete(false)}>
            Cancel
          </button>
        </div>
      )}

      <div className="files-cols" role="row">
        {(["name", "size", "mtime"] as const).map((key) => (
          <button key={key} type="button" onClick={() => sortBy(key)} data-on={sort.key === key}>
            {key === "mtime" ? "Modified" : key === "size" ? "Size" : "Name"}
            {sort.key === key && <ArrowUp size={11} data-down={sort.down} />}
          </button>
        ))}
      </div>

      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the list takes the keyboard */}
      <div
        className="files-rows"
        role="listbox"
        aria-multiselectable
        tabIndex={0}
        onKeyDown={onKey}
      >
        {creating && (
          <div className="files-row" data-kind="folder">
            <Folder size={15} />
            <input
              // eslint-disable-next-line jsx-a11y/no-autofocus -- opened by a click
              autoFocus
              value={draft}
              placeholder="Folder name"
              aria-label="Folder name"
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => setCreating(false)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitDraft();
                if (event.key === "Escape") setCreating(false);
              }}
            />
          </div>
        )}
        {shown.map((entry) => {
          const kind = kindOf(entry);
          const Icon = ICONS[kind];
          return (
            <div
              key={entry.name}
              className="files-row"
              role="option"
              tabIndex={-1}
              aria-selected={selected.has(entry.name)}
              data-kind={kind}
              data-over={over === entry.name}
              draggable={renaming !== entry.name}
              onClick={(event) => pick(entry, event)}
              onDoubleClick={() => activate(entry)}
              onKeyDown={(event) => {
                if (event.key === " ") pick(entry, event);
              }}
              onDragStart={(event) => {
                const group = selected.has(entry.name) ? chosen : [entry];
                dragState.current = { device, dir: path, entries: group };
                event.dataTransfer.setData(DRAG_TYPE, String(group.length));
                event.dataTransfer.effectAllowed = "copy";
              }}
              onDragEnd={() => {
                dragState.current = null;
              }}
              onDragOver={entry.dir ? (event) => onDragOver(event, entry.name) : undefined}
              onDrop={entry.dir ? (event) => onDrop(event, joinPath(path, entry.name)) : undefined}
            >
              <Icon size={15} />
              {renaming === entry.name ? (
                <input
                  // eslint-disable-next-line jsx-a11y/no-autofocus -- opened by a click
                  autoFocus
                  value={draft}
                  aria-label="New name"
                  onFocus={(event) => event.target.select()}
                  onChange={(event) => setDraft(event.target.value)}
                  onBlur={() => setRenaming(null)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") submitDraft();
                    if (event.key === "Escape") setRenaming(null);
                  }}
                />
              ) : (
                <span className="files-name" title={entry.name}>
                  {entry.name}
                </span>
              )}
              <span className="files-size">{entry.dir ? "—" : bytes(entry.size)}</span>
              <span className="files-time">{when(entry.mtime)}</span>
            </div>
          );
        })}
        {entries === null && <p className="files-empty">Reading {device}…</p>}
        {entries !== null && error && (
          <p className="files-empty" data-tone="danger">
            {error}
          </p>
        )}
        {entries !== null && !error && shown.length === 0 && !creating && (
          <p className="files-empty">
            {filter
              ? "No name matches the filter."
              : "This folder is empty. Drop files here to upload."}
          </p>
        )}
      </div>

      {chosen.length > 0 && (
        <footer className="files-selection">
          <span>
            <strong>{chosen.length}</strong> selected
            {chosenFiles.length > 0 &&
              ` · ${bytes(chosenFiles.reduce((sum, e) => sum + e.size, 0))}`}
          </span>
          <button
            type="button"
            disabled={chosenFiles.length === 0}
            onClick={() => {
              for (const entry of chosenFiles)
                transferQueue.download(device, joinPath(path, entry.name), entry.size);
            }}
          >
            <ArrowDownToLine size={13} /> Download
          </button>
          {(chosen.length > 1 || chosen.some((entry) => entry.dir)) && (
            <button
              type="button"
              title="Download the selection, folders included, as one ZIP archive"
              onClick={() =>
                transferQueue.downloadZip(
                  device,
                  path,
                  chosen.map((entry) => joinPath(path, entry.name)),
                  chosenFiles.length === chosen.length
                    ? chosenFiles.reduce((sum, entry) => sum + entry.size, 0)
                    : 0,
                )
              }
            >
              <FileArchive size={13} /> ZIP
            </button>
          )}
          {chosen.length === 1 && chosen[0] && canPreview(chosen[0]) && (
            <button
              type="button"
              onClick={() =>
                viewerStore.set({ device, path: joinPath(path, chosen[0]?.name ?? "") })
              }
            >
              <Eye size={13} /> View
            </button>
          )}
          {chosenFiles.length === 1 && chosen.length === 1 && (
            <button
              type="button"
              title="SHA-256 of the file on the router"
              onClick={() => {
                const name = chosenFiles[0]?.name ?? "";
                setBusy(true);
                filesApi
                  .hash({ device, path: joinPath(path, name) })
                  .then((sha) => {
                    void navigator.clipboard?.writeText(sha).catch(() => {});
                    setNotice(`sha256 of ${name} (copied):\n${sha}`);
                  })
                  .catch((e: unknown) => setNotice(e instanceof Error ? e.message : String(e)))
                  .finally(() => setBusy(false));
              }}
            >
              <Fingerprint size={13} /> Checksum
            </button>
          )}
          {chosenFiles.length > 0 && chosenFiles.length <= 2 && chosenFiles.every(canPreview) && (
            <button
              type="button"
              title="Compare two text files, on one router or on two"
              onClick={() => {
                const refs = chosenFiles.map((entry) => ({
                  device,
                  path: joinPath(path, entry.name),
                }));
                if (refs.length === 2) compareStore.set(refs);
                else if (refs[0]) pickForCompare(refs[0]);
              }}
            >
              <GitCompareArrows size={13} /> Compare
            </button>
          )}
          {!readOnly && (
            <>
              {targets.length > 0 && chosenFiles.length > 0 && (
                <span className="files-send">
                  <Send size={13} />
                  <Select
                    size="sm"
                    className="term-select"
                    aria-label="Copy the selected files to"
                    placeholder="Copy to…"
                    value=""
                    options={targets}
                    onValueChange={(value) => {
                      const [toDevice = "", toDir = "/"] = value.split("\n");
                      for (const entry of chosenFiles)
                        transferQueue.copy(
                          { device, path: joinPath(path, entry.name), size: entry.size },
                          { device: toDevice, dir: toDir },
                        );
                    }}
                  />
                </span>
              )}
              {chosen.length === 1 && chosen[0] && /\.rsc$/i.test(chosen[0].name) && (
                <button
                  type="button"
                  title="Check this script on the router, then run it"
                  onClick={() =>
                    importStore.set({ device, path: joinPath(path, chosen[0]?.name ?? "") })
                  }
                >
                  <Play size={13} /> Import…
                </button>
              )}
              {chosen.length === 1 && chosen[0] && (
                <button
                  type="button"
                  onClick={() => {
                    setCreating(false);
                    setDraft(chosen[0]?.name ?? "");
                    setRenaming(chosen[0]?.name ?? null);
                  }}
                >
                  <Pencil size={13} /> Rename
                </button>
              )}
              <button type="button" data-danger="true" onClick={() => setConfirmDelete(true)}>
                <Trash2 size={13} /> Delete
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            aria-label="Clear the selection"
          >
            <X size={13} />
          </button>
        </footer>
      )}

      {over !== null && (
        <div className="files-drop" aria-hidden="true">
          <div>
            <ArrowUpFromLine size={26} />
            <strong>{dragLabel}</strong>
            <span>
              to {device}:{over ? joinPath(path, over) : path}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
