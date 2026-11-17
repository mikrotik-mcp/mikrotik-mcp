/**
 * Where the storage of a router goes: space for each top folder, the largest
 * files, and files that are usually safe to remove.
 */
import { ChartPie, Trash2, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { bytes } from "./format";
import type { TreeFile } from "./files-lib";
import { analysisStore, analyzeDisk, filesApi, filesBus, when } from "./files-lib";

export function DiskAnalysis({ readOnly }: { readOnly: boolean }): ReactNode {
  const device = useSyncExternalStore(analysisStore.subscribe, analysisStore.get);
  const [tree, setTree] = useState<{ files: TreeFile[]; truncated: boolean } | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const [round, setRound] = useState(0);

  useEffect(() => {
    setTree(null);
    setError("");
    setPicked(new Set());
    setConfirm(false);
    if (!device) return;
    let current = true;
    filesApi
      .tree(device, "/")
      .then((answer) => current && setTree(answer))
      .catch((e: unknown) => current && setError(e instanceof Error ? e.message : String(e)));
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") analysisStore.set(null);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      current = false;
      window.removeEventListener("keydown", onKey);
    };
  }, [device, round]);

  const report = useMemo(() => (tree ? analyzeDisk(tree.files) : null), [tree]);
  if (!device) return null;

  const toggle = (paths: string[], on: boolean): void => {
    const next = new Set(picked);
    for (const path of paths)
      if (on) next.add(path);
      else next.delete(path);
    setPicked(next);
    setConfirm(false);
  };
  const pickedBytes = (tree?.files ?? [])
    .filter((file) => picked.has(file.path))
    .reduce((sum, file) => sum + file.size, 0);
  const remove = (): void => {
    filesApi
      .remove(device, Array.from(picked))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        filesBus.changed(device, "/");
        setRound((n) => n + 1);
      });
  };
  const row = (file: TreeFile): ReactNode => (
    <label key={file.path} className="files-analysis-file">
      {!readOnly && (
        <Checkbox
          checked={picked.has(file.path)}
          onCheckedChange={(on) => toggle([file.path], on === true)}
        />
      )}
      <span title={file.path}>{file.path}</span>
      <small>{when(file.mtime)}</small>
      <b>{bytes(file.size)}</b>
    </label>
  );

  return (
    <div className="term-modal" role="dialog" aria-modal="true" aria-label="Storage analysis">
      <div className="term-modal-card files-sync files-analysis">
        <header>
          <strong>
            <ChartPie size={15} /> Storage of {device}
          </strong>
          {report && (
            <span className="files-viewer-meta">
              {bytes(report.total)} in {tree?.files.length} files
              {tree?.truncated && " · very large: only a part was read"}
            </span>
          )}
          <button type="button" onClick={() => analysisStore.set(null)} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        {error && (
          <p className="files-empty" data-tone="danger">
            {error}
          </p>
        )}
        {!report && !error && <p className="files-empty">Reading every folder of {device}…</p>}
        {report && (
          <div className="files-analysis-body">
            <div className="files-analysis-map" role="img" aria-label="Space for each top folder">
              {report.groups.map((group, index) => (
                <span
                  key={group.name}
                  data-tone={index % 6}
                  style={{ flexGrow: Math.max(group.bytes, report.total / 60) }}
                  title={`${group.name}: ${bytes(group.bytes)} in ${group.count} files`}
                >
                  <b>{group.name}</b>
                  <small>{bytes(group.bytes)}</small>
                </span>
              ))}
            </div>
            {report.suggestions.map((item) => (
              <section key={item.title}>
                <h3>
                  {item.title}
                  <small>{bytes(item.files.reduce((sum, file) => sum + file.size, 0))}</small>
                  {!readOnly && (
                    <button
                      type="button"
                      onClick={() =>
                        toggle(
                          item.files.map((file) => file.path),
                          !item.files.every((file) => picked.has(file.path)),
                        )
                      }
                    >
                      Select all
                    </button>
                  )}
                </h3>
                <p>{item.why}</p>
                {item.files.map(row)}
              </section>
            ))}
            <section>
              <h3>Largest files</h3>
              {report.largest.map(row)}
            </section>
          </div>
        )}
        {picked.size > 0 && (
          <div
            className="files-strip"
            data-tone="danger"
            role="alertdialog"
            aria-label="Delete files"
          >
            <span>
              <strong>{picked.size}</strong> selected · {bytes(pickedBytes)}
            </span>
            {confirm ? (
              <>
                <button type="button" data-danger="true" onClick={remove}>
                  Yes, delete from {device}
                </button>
                <button type="button" onClick={() => setConfirm(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <button type="button" onClick={() => setConfirm(true)}>
                <Trash2 size={13} /> Delete…
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
