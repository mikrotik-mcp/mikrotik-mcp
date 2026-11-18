/**
 * Compare the open folders of two panes, and copy what one side does not have.
 * Files are matched by name and compared by size.
 */
import { ArrowLeftRight } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { FileEntry, FolderRow } from "./files-lib";
import {
  compareFolders,
  filePanes,
  filesApi,
  filesBus,
  joinPath,
  syncStore,
  transferQueue,
} from "./files-lib";
import { Dialog, Strip, day, fleetStore, size } from "./files-parts";
import { Select, Switch } from "./kit";

function status(row: FolderRow): { text: string; tone: "miss" | "new" | "same" } {
  if (row.state === "left") return { text: "only left", tone: "miss" };
  if (row.state === "right") return { text: "only right", tone: "miss" };
  if (row.state === "same") return { text: "same", tone: "same" };
  if (row.newer) return { text: `${row.newer} is newer`, tone: "new" };
  return { text: "differs", tone: "new" };
}

export function FolderSync({ readOnly }: { readOnly: boolean }): ReactNode {
  const open = useSyncExternalStore(syncStore.subscribe, syncStore.get);
  const panes = useSyncExternalStore(filePanes.subscribe, filePanes.all);
  const fleet = useSyncExternalStore(fleetStore.subscribe, fleetStore.get);
  const [leftId, setLeftId] = useState("");
  const [rightId, setRightId] = useState("");
  const [lists, setLists] = useState<[FileEntry[], FileEntry[]] | null>(null);
  const [error, setError] = useState("");
  const [showSame, setShowSame] = useState(true);
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
  const options = panes.map((pane) => ({
    value: pane.id,
    label: `${pane.device} : ${pane.path}`,
    led: fleet.tone[pane.device] ?? "off",
  }));
  const shown = rows.filter((row) => showSame || row.state !== "same");
  const cell = (entry: FileEntry | undefined, newer: boolean): ReactNode =>
    entry ? (
      <>
        {size(entry.size)} · {day(entry.mtime)}
        {newer && <b className="sy-newer"> newer</b>}
      </>
    ) : (
      "—"
    );

  return (
    <Dialog
      label="Compare folders"
      icon={<ArrowLeftRight size={16} />}
      title="Compare folders"
      wide
      onClose={() => syncStore.set(false)}
      meta={`${count("left")} only on the left · ${count("right")} only on the right · ${count("different")} differs · ${count("same")} same`}
    >
      <div className="sy-sides">
        <Select label="Left folder" value={left.id} options={options} onChange={setLeftId} />
        {!readOnly ? (
          <div className="sy-bulk">
            <button
              type="button"
              className="fp-act"
              data-tone="primary"
              disabled={count("left") === 0}
              onClick={() =>
                rows.filter((r) => r.state === "left").forEach((r) => copy(r, "right"))
              }
            >
              Copy {count("left")} →
            </button>
            <button
              type="button"
              className="fp-act"
              disabled={count("right") === 0}
              onClick={() =>
                rows.filter((r) => r.state === "right").forEach((r) => copy(r, "left"))
              }
            >
              ← Copy {count("right")}
            </button>
          </div>
        ) : (
          <span />
        )}
        <Select label="Right folder" value={right.id} options={options} onChange={setRightId} />
      </div>
      {error && <Strip tone="danger">{error}</Strip>}
      {!lists && !error && <p className="fl-empty">Reading the two folders…</p>}
      {lists && shown.length === 0 && (
        <p className="fl-empty">The two folders have the same files.</p>
      )}
      <div className="sy-rows">
        {shown.map((row) => {
          const st = status(row);
          const toLeft =
            row.state === "right" || (row.state === "different" && row.newer !== "left");
          const toRight =
            row.state === "left" || (row.state === "different" && row.newer !== "right");
          return (
            <div key={row.name} className="sy-r">
              <span className="l">{cell(row.left, row.newer === "left")}</span>
              {!readOnly && toLeft && row.right ? (
                <button
                  type="button"
                  className="sy-arr"
                  data-go={row.state === "right" || row.newer === "right" || undefined}
                  aria-label={`Copy ${row.name} to the left`}
                  onClick={() => copy(row, "left")}
                >
                  ←
                </button>
              ) : (
                <span />
              )}
              <span className="nm">
                {row.name}
                <small data-tone={st.tone}>{st.text}</small>
              </span>
              {!readOnly && toRight && row.left ? (
                <button
                  type="button"
                  className="sy-arr"
                  data-go={row.state === "left" || row.newer === "left" || undefined}
                  aria-label={`Copy ${row.name} to the right`}
                  onClick={() => copy(row, "right")}
                >
                  →
                </button>
              ) : (
                <span />
              )}
              <span className="rr">{cell(row.right, row.newer === "right")}</span>
            </div>
          );
        })}
      </div>
      <div className="sy-ft">
        <Switch checked={showSame} onCheckedChange={setShowSame} label="Show the same files" />
        <span className="sp" />
        <span className="m">Matched by name, compared by size. Subfolders are left out.</span>
      </div>
    </Dialog>
  );
}
