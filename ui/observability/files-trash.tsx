/**
 * Recycle bin: the files that this page deleted or replaced in the last week,
 * kept on the server. Restore puts a file back where it was.
 */
import { RotateCcw, Trash2, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { bytes } from "./format";
import type { TrashItem } from "./files-lib";
import { baseName, filesApi, parentOf, trashStore } from "./files-lib";

export function RecycleBin({ readOnly }: { readOnly: boolean }): ReactNode {
  const open = useSyncExternalStore(trashStore.subscribe, trashStore.get);
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback((): void => {
    filesApi
      .trash()
      .then(setItems)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => {
    if (!open) return;
    setError("");
    load();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") trashStore.set(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, load]);

  if (!open) return null;
  const act = (id: string, work: Promise<unknown>): void => {
    setBusy(id);
    work
      .then(() => setError(""))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        setBusy("");
        load();
      });
  };

  return (
    <div className="term-modal" role="dialog" aria-modal="true" aria-label="Recycle bin">
      <div className="term-modal-card files-sync">
        <header>
          <strong>
            <Trash2 size={15} /> Recycle bin
          </strong>
          <span className="files-viewer-meta">
            Files this page deleted or replaced, kept on the server for 7 days
          </span>
          <button type="button" onClick={() => trashStore.set(false)} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        {error && (
          <p className="files-empty" data-tone="danger">
            {error}
          </p>
        )}
        {items === null && !error && <p className="files-empty">Reading the recycle bin…</p>}
        {items?.length === 0 && <p className="files-empty">The recycle bin is empty.</p>}
        {items && items.length > 0 && (
          <>
            <div className="files-sync-bulk">
              <span />
              <span />
              <button
                type="button"
                disabled={busy !== ""}
                onClick={() => act("*", filesApi.purge())}
              >
                Empty the recycle bin
              </button>
            </div>
            <div className="files-sync-rows">
              {items.map((item) => (
                <div
                  key={item.id}
                  className="files-sync-row files-trash-row"
                  data-state={item.reason}
                >
                  <span className="files-sync-mid">
                    <strong title={item.path}>{baseName(item.path)}</strong>
                    <small>{item.reason}</small>
                  </span>
                  <span className="files-sync-cell">
                    {item.device}:{parentOf(item.path)} · {bytes(item.size)} ·{" "}
                    {new Date(item.ts).toLocaleString()}
                  </span>
                  <span className="files-sync-mid">
                    {!readOnly && (
                      <button
                        type="button"
                        disabled={busy !== ""}
                        title={`Put it back at ${item.device}:${item.path}`}
                        onClick={() => act(item.id, filesApi.restore(item.id))}
                      >
                        <RotateCcw size={13} /> {busy === item.id ? "Restoring…" : "Restore"}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busy !== ""}
                      title="Remove from the recycle bin"
                      onClick={() => act(item.id, filesApi.purge(item.id))}
                    >
                      <X size={13} />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
