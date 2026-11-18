/**
 * One Files pane: the files of one router, one folder at a time.
 *
 * Drop files from the computer to upload them. Drag rows to another pane (or to
 * a folder) to copy them there; the server relays a router-to-router copy.
 */
import type { IDockviewPanelProps } from "dockview-react";
import {
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUp,
  ArrowUpFromLine,
  Eye,
  FileArchive,
  Fingerprint,
  Plus,
  GitCompareArrows,
  HardDrive,
  MoreHorizontal,
  Pencil,
  Play,
  Radio,
  RefreshCw,
  Star,
  Trash2,
  Upload,
  Vault,
  X,
} from "lucide-react";
import type { DragEvent, KeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { FileEntry, RouterSystem } from "./files-lib";
import {
  DRAG_TYPE,
  analysisStore,
  bookmarkStore,
  broadcastStore,
  canPreview,
  compareStore,
  conflicts,
  dragState,
  droppedFiles,
  filePanes,
  filesApi,
  filesBus,
  importStore,
  isBookmarked,
  joinPath,
  kindOf,
  packageWarnings,
  parentOf,
  pickForCompare,
  tailStore,
  toggleBookmark,
  transferQueue,
  uploadTargets,
  viewerStore,
} from "./files-lib";
import { rise } from "./files-motion";
import {
  KindTile,
  Strip,
  activePaneStore,
  fleetStore,
  size,
  stamp,
  usageStore,
  viewerSiblings,
  viewerTab,
} from "./files-parts";
import type { MenuItem, RowAction } from "./kit";
import { Menu, RowMenu, RowMore, TextInput } from "./kit";

type SortKey = "name" | "size" | "mtime";

/** A drop that waits for an answer because some names already exist. */
interface PendingDrop {
  dir: string;
  existing: string[];
  start: (skip: Set<string>) => void;
}

export interface PaneProps {
  id: string;
  device: string;
  path: string;
  readOnly: boolean;
  trash: boolean;
  s3: boolean;
  /** The phone layout: no tools row, no column heads, no date column. */
  phone?: boolean;
  active?: boolean;
  onPath?: (path: string) => void;
  onFocus?: () => void;
}

/** Opens a file in the viewer drawer, with the files beside it for J / K. */
export function openInViewer(
  device: string,
  dir: string,
  name: string,
  siblings: FileEntry[],
  tab = "view",
): void {
  const files = siblings.filter((entry) => !entry.dir);
  viewerSiblings.set({
    device,
    dir,
    names: files.map((entry) => entry.name),
    meta: Object.fromEntries(
      files.map((entry) => [
        entry.name,
        { size: entry.size, mtime: entry.mtime, preview: canPreview(entry) },
      ]),
    ),
  });
  viewerTab.set(tab);
  viewerStore.set({ device, path: joinPath(dir, name) });
}

/** The drag image: the count and what a drop would do, next to the pointer. */
function dragGhost(event: DragEvent, count: number, total: number): void {
  const ghost = document.createElement("div");
  ghost.className = "fp-ghost";
  const badge = document.createElement("span");
  badge.className = "c";
  badge.textContent = String(count);
  ghost.append(
    badge,
    `Copy ${count} ${count === 1 ? "file" : "files"}${total ? ` · ${size(total)}` : ""}`,
  );
  document.body.append(ghost);
  event.dataTransfer.setDragImage(ghost, 14, 18);
  setTimeout(() => ghost.remove(), 0);
}

export function FilesPane(props: PaneProps): ReactNode {
  const { id, device, readOnly, phone = false, onPath, onFocus } = props;
  const [path, setPath] = useState(props.path);
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
  const bookmarks = useSyncExternalStore(bookmarkStore.subscribe, bookmarkStore.get);
  const anchor = useRef<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const reveal = useRef<string | undefined>(undefined);
  const others = useSyncExternalStore(filePanes.subscribe, filePanes.all);
  const broadcasting = useSyncExternalStore(broadcastStore.subscribe, broadcastStore.get);

  // The parent can move this pane to another folder (a bookmark, a workspace).
  useEffect(() => setPath(props.path), [props.path]);

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
    onPath?.(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onPath is the parent's setter
  }, [load, path]);

  // Rows arrive in a stagger each time a folder is read.
  useEffect(() => rise(rowsRef.current, ".fp-r"), [entries]);

  useEffect(() => {
    const refreshUsage = (): void => {
      filesApi
        .usage(device)
        .then((answer) => {
          setUsage(answer);
          usageStore.set(device, answer);
        })
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
    filePanes.set(id, {
      device,
      path,
      reveal: (dir, name) => {
        if (dir === path) {
          reveal.current = name;
          load(path);
        } else open(dir, name);
        onFocus?.();
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onFocus is the parent's
  }, [id, device, load, open, path]);
  useEffect(() => () => filePanes.remove(id), [id]);
  useEffect(() => {
    if (props.active) activePaneStore.set({ id, device, path });
  }, [props.active, id, device, path]);

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
  const chosenBytes = chosenFiles.reduce((sum, e) => sum + e.size, 0);

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
  const toggle = (name: string): void => {
    const next = new Set(selected);
    if (!next.delete(name)) next.add(name);
    setSelected(next);
  };

  const view = (entry: FileEntry, tab = "view"): void =>
    openInViewer(device, path, entry.name, shown, tab);

  const activate = (entry: FileEntry): void => {
    if (entry.dir) open(joinPath(path, entry.name));
    else if (canPreview(entry)) view(entry);
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

  const startRename = (name: string): void => {
    setCreating(false);
    setDraft(name);
    setRenaming(name);
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
    else if (event.key === "F2" && chosen.length === 1 && chosen[0] && !readOnly)
      startRename(chosen[0].name);
  };

  const crumbs = path.split("/").filter(Boolean);
  const used = usage.total && usage.free !== undefined ? 1 - usage.free / usage.total : null;
  const fleet = useSyncExternalStore(fleetStore.subscribe, fleetStore.get);
  const targets = useMemo(() => {
    const seen = new Set<string>();
    // On a phone only one pane is open: offer the root of every other router.
    const candidates = phone
      ? fleet.names.filter((name) => name !== device).map((name) => ({ device: name, path: "/" }))
      : others;
    return candidates
      .filter((pane) => !(pane.device === device && pane.path === path))
      .map((pane) => ({ device: pane.device, dir: pane.path, key: `${pane.device}\n${pane.path}` }))
      .filter((option) => !seen.has(option.key) && seen.add(option.key));
  }, [others, fleet, phone, device, path]);
  const sortBy = (key: SortKey): void =>
    setSort((now) => ({ key, down: now.key === key ? !now.down : key !== "name" }));
  const copyText = (text: string): void =>
    void navigator.clipboard?.writeText(text).catch(() => {});

  const downloadChosen = (): void => {
    for (const entry of chosenFiles)
      transferQueue.download(device, joinPath(path, entry.name), entry.size);
  };
  const copyTo = (to: { device: string; dir: string }): void => {
    for (const entry of chosenFiles)
      transferQueue.copy(
        { device, path: joinPath(path, entry.name), size: entry.size },
        { device: to.device, dir: to.dir },
      );
  };
  const zip = (): void =>
    transferQueue.downloadZip(
      device,
      path,
      chosen.map((entry) => joinPath(path, entry.name)),
      chosenFiles.length === chosen.length ? chosenBytes : 0,
    );
  const toVault = (s3: boolean): void => {
    setBusy(true);
    filesApi
      .saveToVault(
        device,
        chosenFiles.map((entry) => joinPath(path, entry.name)),
        s3,
      )
      .then((names) => setNotice(`Saved to the vault${s3 ? " and S3" : ""}:\n${names.join("\n")}`))
      .catch((e: unknown) => setNotice(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  const checksum = (name: string): void => {
    setBusy(true);
    filesApi
      .hash({ device, path: joinPath(path, name) })
      .then((sha) => {
        copyText(sha);
        setNotice(`sha256 of ${name} (copied):\n${sha}`);
      })
      .catch((e: unknown) => setNotice(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  const compare = (): void => {
    const refs = chosenFiles.map((entry) => ({ device, path: joinPath(path, entry.name) }));
    if (refs.length === 2) compareStore.set(refs);
    else if (refs[0]) pickForCompare(refs[0]);
  };
  const makeOnRouter = (kind: "backup" | "export"): void => {
    setBusy(true);
    filesApi
      .make(device, kind)
      .then((file) => setNotice(`${device} made ${file}.`))
      .catch((e: unknown) => setNotice(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const one = chosen.length === 1 ? chosen[0] : undefined;
  const canZip = chosen.length > 1 || chosen.some((entry) => entry.dir);
  const canCompare =
    chosenFiles.length > 0 && chosenFiles.length <= 2 && chosenFiles.every(canPreview);

  /** Everything the selection bar can do beyond its visible buttons. */
  const moreItems: MenuItem[][] = [
    [
      ...(one && !one.dir && canPreview(one)
        ? [{ label: "View", icon: <Eye />, onSelect: () => view(one) }]
        : []),
      ...(one && !one.dir
        ? [{ label: "Checksum", icon: <Fingerprint />, onSelect: () => checksum(one.name) }]
        : []),
      ...(canCompare ? [{ label: "Compare", icon: <GitCompareArrows />, onSelect: compare }] : []),
      ...(props.s3 && chosenFiles.length > 0
        ? [{ label: "Save to the vault and S3", icon: <Vault />, onSelect: () => toVault(true) }]
        : []),
    ],
    readOnly
      ? []
      : [
          ...(one && /\.rsc$/i.test(one.name)
            ? [
                {
                  label: "Import…",
                  icon: <Play />,
                  onSelect: () => importStore.set({ device, path: joinPath(path, one.name) }),
                },
              ]
            : []),
          ...(one
            ? [{ label: "Rename", icon: <Pencil />, onSelect: () => startRename(one.name) }]
            : []),
        ],
    [
      {
        label: "Clear the selection",
        icon: <X />,
        shortcut: "Esc",
        onSelect: () => setSelected(new Set()),
      },
      ...(readOnly
        ? []
        : [
            {
              label: "Delete…",
              icon: <Trash2 />,
              danger: true,
              onSelect: () => setConfirmDelete(true),
            },
          ]),
    ],
  ].filter((group) => group.length > 0);

  /** The row menu of one file: the same actions as the selection bar and the old menu. */
  const rowActions = (entry: FileEntry): RowAction[] => {
    const full = joinPath(path, entry.name);
    const list: RowAction[] = [];
    if (!entry.dir && canPreview(entry)) {
      list.push({
        label: "Download",
        icon: <ArrowDownToLine />,
        onSelect: () => transferQueue.download(device, full, entry.size),
      });
      list.push({
        label: "Compare with…",
        icon: <GitCompareArrows />,
        onSelect: () => pickForCompare({ device, path: full }),
      });
    }
    if (!entry.dir && canPreview(entry))
      list.push({
        label: "Follow (live tail)",
        icon: <Radio />,
        onSelect: () => tailStore.set({ device, path: full }),
      });
    if (entry.dir)
      list.push({
        label: isBookmarked(bookmarks, device, full)
          ? "Remove the bookmark"
          : "Bookmark this folder",
        icon: <Star />,
        onSelect: () => toggleBookmark(device, full),
      });
    if (!readOnly && /\.rsc$/i.test(entry.name))
      list.push({
        label: "Import…",
        icon: <Play />,
        onSelect: () => importStore.set({ device, path: full }),
      });
    if (!readOnly) {
      list.push({
        label: "Rename",
        icon: <Pencil />,
        shortcut: "F2",
        onSelect: () => startRename(entry.name),
      });
      list.push({
        label: "Delete…",
        icon: <Trash2 />,
        danger: true,
        onSelect: () => {
          if (!selected.has(entry.name)) setSelected(new Set([entry.name]));
          setConfirmDelete(true);
        },
      });
    }
    return list;
  };

  const selectionActions: RowAction[] = [
    {
      label: "Download",
      icon: <ArrowDownToLine />,
      onSelect: downloadChosen,
      disabled: chosenFiles.length === 0,
    },
    ...(canZip ? [{ label: "Download as ZIP", icon: <FileArchive />, onSelect: zip }] : []),
    ...(chosenFiles.length > 0
      ? [{ label: "Save to the vault", icon: <Vault />, onSelect: () => toVault(false) }]
      : []),
    ...(readOnly
      ? []
      : [
          {
            label: "Delete…",
            icon: <Trash2 />,
            danger: true,
            onSelect: () => setConfirmDelete(true),
          },
        ]),
  ];

  const dropLabel =
    over === null
      ? ""
      : dragState.current
        ? `Copy ${dragState.current.entries.length} from ${dragState.current.device}`
        : broadcasting
          ? "Drop to upload to every open router"
          : "Drop to upload";

  return (
    <section
      className="fp"
      data-active={props.active || undefined}
      data-phone={phone || undefined}
      data-over={over === "" || undefined}
      onPointerDown={onFocus}
      onDragOver={(event) => onDragOver(event, "")}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null);
      }}
      onDrop={(event) => onDrop(event, path)}
    >
      <nav className="fp-crumb" aria-label="Folder">
        <HardDrive size={13} strokeWidth={1.7} aria-hidden="true" />
        <button
          type="button"
          onClick={() => open("/")}
          title={`${device}: root`}
          data-last={crumbs.length === 0 || undefined}
        >
          <span>/</span>
        </button>
        {crumbs.map((part, index) => (
          // eslint-disable-next-line react/no-array-index-key -- a path may repeat a name
          <span key={index} className="seg">
            <i aria-hidden="true">/</i>
            <button
              type="button"
              data-last={index === crumbs.length - 1 || undefined}
              onClick={() => open(`/${crumbs.slice(0, index + 1).join("/")}`)}
            >
              <span>{part}</span>
            </button>
          </span>
        ))}
      </nav>

      {!phone && (
        <div className="fp-tools">
          <button
            type="button"
            className="fp-ib"
            disabled={path === "/"}
            onClick={() => open(parentOf(path))}
            aria-label="Up one folder"
            title="Up one folder"
          >
            <ArrowUp size={14} />
          </button>
          <button
            type="button"
            className="fp-ib"
            onClick={() => load(path)}
            aria-label="Reload"
            title="Reload"
            data-spin={busy || undefined}
          >
            <RefreshCw size={16} />
          </button>
          <TextInput
            size="sm"
            wrapClassName="fp-filter"
            value={filter}
            onChange={setFilter}
            placeholder="Filter this folder"
            label="Filter this folder"
            icon={<SearchIcon />}
          />
          <button
            type="button"
            className="fp-ib"
            data-on={isBookmarked(bookmarks, device, path) || undefined}
            aria-pressed={isBookmarked(bookmarks, device, path)}
            onClick={() => toggleBookmark(device, path)}
            title={
              isBookmarked(bookmarks, device, path) ? "Remove the bookmark" : "Bookmark this folder"
            }
          >
            <Star size={14} />
          </button>
          {!readOnly && (
            <>
              <button
                type="button"
                className="fp-ib"
                title="New folder"
                aria-label="New folder"
                onClick={() => {
                  setDraft("");
                  setRenaming(null);
                  setCreating(true);
                }}
              >
                <Plus size={16} />
              </button>
              <button
                type="button"
                className="fp-ib"
                title="Upload"
                aria-label="Upload"
                onClick={() => picker.current?.click()}
              >
                <Upload size={14} />
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
          <Menu
            label={`More for ${device}`}
            trigger={
              <button type="button" className="fp-ib" aria-label={`More for ${device}`}>
                <MoreHorizontal size={14} />
              </button>
            }
            groups={[
              [{ label: "Analyse the storage", onSelect: () => analysisStore.set(device) }],
              readOnly
                ? []
                : [
                    { label: "Backup now (.backup)", onSelect: () => makeOnRouter("backup") },
                    { label: "Export now (.rsc)", onSelect: () => makeOnRouter("export") },
                  ],
            ].filter((group) => group.length > 0)}
          />
        </div>
      )}

      {used !== null && (
        <div className="fp-store" title="Storage of the router">
          <span>
            <b>{size(usage.free ?? 0)}</b> free of {size(usage.total ?? 0)}
          </span>
          <span className="tr" aria-hidden="true">
            <i
              style={{ width: `${Math.round(used * 100)}%` }}
              data-high={used > 0.85 || undefined}
            />
          </span>
          {!phone && <span>{Math.round(used * 100)}%</span>}
        </div>
      )}

      {notice && (
        <Strip
          tone="warn"
          className="fp-note"
          actions={
            <button
              type="button"
              className="fp-ib"
              onClick={() => setNotice("")}
              aria-label="Dismiss"
            >
              <X size={13} />
            </button>
          }
        >
          {notice}
        </Strip>
      )}
      {packageCheck && (
        <Strip
          tone="danger"
          role="alertdialog"
          label="Package check"
          className="fp-note"
          actions={
            <>
              <button type="button" className="fp-act" onClick={() => setPackageCheck(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="fp-act"
                data-tone="danger"
                onClick={() => {
                  packageCheck.go();
                  setPackageCheck(null);
                }}
              >
                Upload anyway
              </button>
            </>
          }
        >
          {packageCheck.warnings.join("\n")}
        </Strip>
      )}
      {pending && (
        <Strip
          tone="warn"
          role="alertdialog"
          label="Replace files"
          className="fp-note"
          actions={
            <>
              <button type="button" className="fp-act" onClick={() => setPending(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="fp-act"
                onClick={() => {
                  pending.start(new Set(pending.existing));
                  setPending(null);
                }}
              >
                Skip these
              </button>
              <button
                type="button"
                className="fp-act"
                data-tone="primary"
                onClick={() => {
                  pending.start(new Set());
                  setPending(null);
                }}
              >
                Replace
              </button>
            </>
          }
        >
          <b>{pending.existing.length}</b> already in {pending.dir}:{" "}
          {pending.existing.slice(0, 3).join(", ")}
          {pending.existing.length > 3 && "…"}
        </Strip>
      )}
      {confirmDelete && chosen.length > 0 && (
        <Strip
          tone="danger"
          role="alertdialog"
          label="Delete files"
          icon={<Trash2 size={14} />}
          className="fp-note"
          actions={
            <>
              <button type="button" className="fp-act" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="fp-act"
                data-tone="danger"
                onClick={() =>
                  act(
                    filesApi.remove(
                      device,
                      chosen.map((entry) => joinPath(path, entry.name)),
                    ),
                  )
                }
              >
                Delete from {device}
              </button>
            </>
          }
        >
          Delete <b>{chosen.length}</b>? Folders go with everything in them.{" "}
          {props.trash
            ? "Files up to 64 MiB stay in the recycle bin for 7 days."
            : "This cannot be undone."}
        </Strip>
      )}

      {!phone && (
        <div className="fp-th">
          <span />
          {(["name", "size", "mtime"] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => sortBy(key)}
              data-on={sort.key === key || undefined}
              data-col={key}
              aria-label={`Sort by ${key === "mtime" ? "modified" : key}`}
            >
              {key === "mtime" ? "Modified" : key === "size" ? "Size" : "Name"}
              {sort.key === key && (sort.down ? " ↓" : " ↑")}
            </button>
          ))}
          <span />
        </div>
      )}

      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the list takes the keyboard */}
      <div
        ref={rowsRef}
        className="fp-rows"
        role="listbox"
        aria-label={`Files of ${device}:${path}`}
        aria-multiselectable
        tabIndex={0}
        onKeyDown={onKey}
      >
        {creating && (
          <div className="fp-r" data-kind="folder">
            <KindTile kind="folder" />
            <TextInput
              size="sm"
              wrapClassName="fp-name-in"
              // eslint-disable-next-line jsx-a11y/no-autofocus -- opened by a click
              autoFocus
              value={draft}
              placeholder="Folder name"
              label="Folder name"
              onChange={setDraft}
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
          const full = joinPath(path, entry.name);
          const isSelected = selected.has(entry.name);
          return (
            <RowMenu
              key={entry.name}
              title={entry.name}
              sub={`${device}:${path}`}
              onOpen={
                entry.dir ? undefined : () => view(entry, canPreview(entry) ? "view" : "details")
              }
              opens={
                entry.dir
                  ? [{ label: "Open", onSelect: () => open(full) }]
                  : canPreview(entry)
                    ? []
                    : [
                        {
                          label: "Download",
                          icon: <ArrowDownToLine />,
                          onSelect: () => activate(entry),
                        },
                      ]
              }
              cells={{
                name: { value: entry.name, sort: () => sortBy("name") },
                size: { value: entry.dir ? "" : size(entry.size), sort: () => sortBy("size") },
                mtime: { value: stamp(entry.mtime), sort: () => sortBy("mtime") },
              }}
              copies={[
                { label: "Path", value: `${device}:${full}` },
                ...(/\.rsc$/i.test(entry.name)
                  ? [{ label: "Import command", value: `/import file-name=${full.slice(1)}` }]
                  : []),
              ]}
              select={{ selected: isSelected, toggle: () => toggle(entry.name) }}
              actions={rowActions(entry)}
              selection={{
                count: chosen.length,
                summary: chosenBytes ? size(chosenBytes) : undefined,
                actions: selectionActions,
                clear: () => setSelected(new Set()),
              }}
            >
              <div
                className="fp-r"
                role="option"
                tabIndex={-1}
                aria-selected={isSelected}
                data-kind={kind}
                data-drop={over === entry.name || undefined}
                data-drop-label={
                  over === entry.name
                    ? dragState.current
                      ? `Drop to copy into ${entry.name}`
                      : `Drop to upload into ${entry.name}`
                    : undefined
                }
                draggable={renaming !== entry.name}
                onClick={(event) => pick(entry, event)}
                onDoubleClick={() => activate(entry)}
                onContextMenu={() => {
                  if (!selected.has(entry.name)) setSelected(new Set([entry.name]));
                }}
                onKeyDown={(event) => {
                  if (event.key === " ") pick(entry, event);
                }}
                onDragStart={(event) => {
                  const group = isSelected ? chosen : [entry];
                  dragState.current = { device, dir: path, entries: group };
                  event.dataTransfer.setData(DRAG_TYPE, String(group.length));
                  event.dataTransfer.effectAllowed = "copy";
                  dragGhost(
                    event,
                    group.length,
                    group.filter((e) => !e.dir).reduce((sum, e) => sum + e.size, 0),
                  );
                }}
                onDragEnd={() => {
                  dragState.current = null;
                }}
                onDragOver={entry.dir ? (event) => onDragOver(event, entry.name) : undefined}
                onDrop={entry.dir ? (event) => onDrop(event, full) : undefined}
              >
                <span data-col="kind">
                  <KindTile kind={kind} />
                </span>
                {renaming === entry.name ? (
                  <TextInput
                    size="sm"
                    wrapClassName="fp-name-in"
                    // eslint-disable-next-line jsx-a11y/no-autofocus -- opened by a click
                    autoFocus
                    value={draft}
                    label="New name"
                    onFocus={(event) => event.target.select()}
                    onChange={setDraft}
                    onBlur={() => setRenaming(null)}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === "Enter") submitDraft();
                      if (event.key === "Escape") setRenaming(null);
                    }}
                  />
                ) : (
                  <span className="n" data-col="name" title={entry.name}>
                    {entry.name}
                  </span>
                )}
                <span className="z" data-col="size">
                  {entry.dir ? "—" : size(entry.size)}
                </span>
                {!phone && (
                  <span className="d" data-col="mtime">
                    {stamp(entry.mtime)}
                  </span>
                )}
                <span className="mo">
                  <RowMore />
                </span>
              </div>
            </RowMenu>
          );
        })}
        {entries === null && <p className="fp-empty">Reading {device}…</p>}
        {entries !== null && error && (
          <p className="fp-empty" data-tone="danger">
            {error}
          </p>
        )}
        {entries !== null && !error && shown.length === 0 && !creating && (
          <p className="fp-empty">
            {filter
              ? "No name matches the filter."
              : "This folder is empty. Drop files here to upload."}
          </p>
        )}
      </div>

      {chosen.length > 0 && (
        <footer className="fp-sel" aria-label={`${chosen.length} selected`}>
          <b>{chosen.length}</b>
          <span className="t">selected{chosenFiles.length > 0 && ` · ${size(chosenBytes)}`}</span>
          <button
            type="button"
            className="fp-act"
            disabled={chosenFiles.length === 0}
            onClick={downloadChosen}
            aria-label="Download"
          >
            <ArrowDownToLine size={phone ? 13 : 16} />
            {!phone && "Download"}
          </button>
          {!readOnly && (
            <Menu
              label="Copy the selected files to"
              trigger={
                <button
                  type="button"
                  className="fp-act"
                  disabled={targets.length === 0 || chosenFiles.length === 0}
                  aria-label="Copy to"
                  title={targets.length === 0 ? "Open another pane to copy into it" : undefined}
                >
                  <ArrowLeftRight size={13} />
                  {!phone && "Copy to"}
                </button>
              }
              groups={[
                targets.map((to) => ({
                  label: `${to.device}:${to.dir}`,
                  onSelect: () => copyTo(to),
                })),
              ]}
            />
          )}
          {!phone && canZip && (
            <button
              type="button"
              className="fp-ib"
              onClick={zip}
              aria-label="Download as ZIP"
              title="Download the selection, folders included, as one ZIP archive"
            >
              <FileArchive size={14} />
            </button>
          )}
          {chosenFiles.length > 0 && (
            <button
              type="button"
              className={phone ? "fp-act" : "fp-ib"}
              onClick={() => toVault(false)}
              aria-label="Save to the vault"
              title="Copy the selected files to the backup vault of the server"
            >
              <Vault size={phone ? 13 : 14} />
            </button>
          )}
          <Menu
            label="More for the selection"
            trigger={
              <button
                type="button"
                className={phone ? "fp-act" : "fp-ib"}
                aria-label="More for the selection"
              >
                <MoreHorizontal size={phone ? 13 : 14} />
              </button>
            }
            groups={
              phone && canZip
                ? [
                    [{ label: "Download as ZIP", icon: <FileArchive />, onSelect: zip }],
                    ...moreItems,
                  ]
                : moreItems
            }
          />
        </footer>
      )}

      {over === "" && (
        <div className="fp-drop" aria-hidden="true">
          <ArrowUpFromLine size={15} />
          <b>{dropLabel}</b>
          <span>
            to {device}:{path}
          </span>
        </div>
      )}
    </section>
  );
}

function SearchIcon(): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

/** A pane inside dockview: the pane keeps the panel's folder and active state. */
export function FilesDockPane(
  props: IDockviewPanelProps<{
    device: string;
    path?: string;
    readOnly?: boolean;
    trash?: boolean;
    s3?: boolean;
  }>,
): ReactNode {
  const { api, params } = props;
  const [active, setActive] = useState(api.isActive);
  useEffect(() => {
    const sub = api.onDidActiveChange((event) => setActive(event.isActive));
    return () => sub.dispose();
  }, [api]);
  const onPath = useCallback(
    (path: string) => api.updateParameters({ ...api.getParameters(), path }),
    [api],
  );
  return (
    <FilesPane
      id={api.id}
      device={params.device}
      path={params.path ?? "/"}
      readOnly={params.readOnly === true}
      trash={params.trash === true}
      s3={params.s3 === true}
      active={active}
      onPath={onPath}
      onFocus={() => api.setActive()}
    />
  );
}
