/**
 * Compare the open folders of two panes, and copy what one side does not have.
 * Files are matched by name and compared by size.
 */
import { ArrowLeft, ArrowRight, FolderSync as FolderSyncIcon, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { bytes } from "./format";
import { Select } from "./geist";
import type { FileEntry, FolderRow } from "./files-lib";
import {
  compareFolders,
  filePanes,
  filesApi,
  filesBus,
  joinPath,
  syncStore,
  transferQueue,
  when,
} from "./files-lib";

const LABEL = { left: "only left", right: "only right", different: "different", same: "same" };

export function FolderSync({ readOnly }: { readOnly: boolean }): ReactNode {
  const open = useSyncExternalStore(syncStore.subscribe, syncStore.get);
  const panes = useSyncExternalStore(filePanes.subscribe, filePanes.all);
  const [leftId, setLeftId] = useState("");
  const [rightId, setRightId] = useState("");
  const [lists, setLists] = useState<[FileEntry[], FileEntry[]] | null>(null);
  const [error, setError] = useState("");
  const [showSame, setShowSame] = useState(false);
  const [tick, setTick] = useState(0);
  const left = panes.find((pane) => pane.id === leftId) ?? panes[0];
  const right = panes.find((pane) => pane.id === rightId) ?? panes.find((pane) => pane !== left);

  useEffect(() => {
    if (!open || !left || !right) return;
    let current = true;
    setError("");
    Promise.all([filesApi.list(left.device, left.path), filesApi.list(right.device, right.path)])
      .then((both) => current && setLists(both))
      .catch((e: unknown) => current && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the two folders, and a reload tick
  }, [open, left?.device, left?.path, right?.device, right?.path, tick]);
  // A finished copy changes one of the two folders.
  useEffect(() => (open ? filesBus.subscribe(() => setTick((n) => n + 1)) : undefined), [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") syncStore.set(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const rows = useMemo(() => (lists ? compareFolders(lists[0], lists[1]) : []), [lists]);
  if (!open || !left || !right) return null;

  const copy = (row: FolderRow, to: "left" | "right"): void => {
    const from = to === "right" ? left : right;
    const target = to === "right" ? right : left;
    const entry = to === "right" ? row.left : row.right;
    if (!entry) return;
    transferQueue.copy(
      { device: from.device, path: joinPath(from.path, row.name), size: entry.size },
      { device: target.device, dir: target.path },
    );
  };
  const count = (state: FolderRow["state"]): number =>
    rows.filter((row) => row.state === state).length;
  const options = panes.map((pane) => ({ value: pane.id, label: `${pane.device}:${pane.path}` }));
  const shown = rows.filter((row) => showSame || row.state !== "same");

  return (
    <div className="term-modal" role="dialog" aria-modal="true" aria-label="Compare folders">
      <div className="term-modal-card files-sync">
        <header>
          <strong>
            <FolderSyncIcon size={15} /> Compare folders
          </strong>
          <span className="files-viewer-meta">
            {count("left")} only left · {count("right")} only right · {count("different")} different
            · {count("same")} same
          </span>
          <button type="button" onClick={() => syncStore.set(false)} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="files-sync-sides">
          <Select
            size="sm"
            className="term-select"
            aria-label="Left folder"
            value={left.id}
            options={options}
            onValueChange={setLeftId}
          />
          <Select
            size="sm"
            className="term-select"
            aria-label="Right folder"
            value={right.id}
            options={options}
            onValueChange={setRightId}
          />
        </div>
        {!readOnly && (
          <div className="files-sync-bulk">
            <button
              type="button"
              disabled={count("left") === 0}
              onClick={() =>
                rows.filter((r) => r.state === "left").forEach((r) => copy(r, "right"))
              }
            >
              Copy {count("left")} missing <ArrowRight size={13} />
            </button>
            <button
              type="button"
              disabled={count("right") === 0}
              onClick={() =>
                rows.filter((r) => r.state === "right").forEach((r) => copy(r, "left"))
              }
            >
              <ArrowLeft size={13} /> Copy {count("right")} missing
            </button>
            <button type="button" data-on={showSame} onClick={() => setShowSame((on) => !on)}>
              Show the same files
            </button>
          </div>
        )}
        {error && (
          <p className="files-empty" data-tone="danger">
            {error}
          </p>
        )}
        {!lists && !error && <p className="files-empty">Reading the two folders…</p>}
        {lists && shown.length === 0 && (
          <p className="files-empty">The two folders have the same files.</p>
        )}
        <div className="files-sync-rows">
          {shown.map((row) => (
            <div key={row.name} className="files-sync-row" data-state={row.state}>
              <span className="files-sync-cell">
                {row.left ? `${bytes(row.left.size)} · ${when(row.left.mtime)}` : "—"}
                {row.newer === "left" && <em>newer</em>}
              </span>
              <span className="files-sync-mid">
                {!readOnly && row.right && row.state !== "same" && (
                  <button type="button" title="Copy to the left" onClick={() => copy(row, "left")}>
                    <ArrowLeft size={13} />
                  </button>
                )}
                <strong title={row.name}>{row.name}</strong>
                <small>{LABEL[row.state]}</small>
                {!readOnly && row.left && row.state !== "same" && (
                  <button
                    type="button"
                    title="Copy to the right"
                    onClick={() => copy(row, "right")}
                  >
                    <ArrowRight size={13} />
                  </button>
                )}
              </span>
              <span className="files-sync-cell">
                {row.right ? `${bytes(row.right.size)} · ${when(row.right.mtime)}` : "—"}
                {row.newer === "right" && <em>newer</em>}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
