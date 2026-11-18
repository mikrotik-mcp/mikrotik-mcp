/**
 * Recycle bin: the files that this page deleted or replaced in the last week,
 * kept on the server. Restore puts a file back where it was. Emptying the bin
 * asks first.
 */
import { RotateCcw, Trash2, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import type { TrashItem } from "./files-lib";
import { baseName, filesApi, parentOf } from "./files-lib";
import { Strip, size } from "./files-parts";
import { at } from "./files-vault";
import { RowMenu } from "./kit";

const WEEK = 7 * 24 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

function left(ts: number, now = Date.now()): string {
  const days = Math.ceil((ts + WEEK - now) / DAY);
  if (days <= 0) return "goes today";
  return `${days} ${days === 1 ? "day" : "days"} left`;
}

export function TrashTab({
  readOnly,
  onCount,
}: {
  readOnly: boolean;
  onCount?: (n: number) => void;
}): ReactNode {
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [emptying, setEmptying] = useState(false);

  const load = useCallback((): void => {
    filesApi
      .trash()
      .then((list) => {
        setItems(list);
        onCount?.(list.length);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [onCount]);
  useEffect(() => {
    setError("");
    load();
  }, [load]);

  const act = (id: string, work: Promise<unknown>): void => {
    setBusy(id);
    work
      .then(() => setError(""))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        setBusy("");
        setEmptying(false);
        load();
      });
  };

  return (
    <div className="fl-tool">
      <div className="fl-tool-hd">
        <Trash2 size={16} aria-hidden="true" />
        <h3>Recycle bin</h3>
        <span className="m">kept on the server for 7 days</span>
        <span className="sp" />
        {items && items.length > 0 && (
          <button
            type="button"
            className="fp-act"
            data-tone="danger-text"
            disabled={busy !== ""}
            onClick={() => setEmptying(true)}
          >
            Empty…
          </button>
        )}
      </div>
      {emptying && items && (
        <Strip
          tone="danger"
          role="alertdialog"
          label="Empty the recycle bin"
          icon={<Trash2 size={15} />}
          actions={
            <>
              <button type="button" className="fp-act" onClick={() => setEmptying(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="fp-act"
                data-tone="danger"
                disabled={busy !== ""}
                onClick={() => act("*", filesApi.purge())}
              >
                Empty the recycle bin
              </button>
            </>
          }
        >
          Remove all {items.length} files for good? They cannot be restored after this.
        </Strip>
      )}
      {error && <Strip tone="danger">{error}</Strip>}
      {items === null && !error && <p className="fl-empty">Reading the recycle bin…</p>}
      {items?.length === 0 && <p className="fl-empty">The recycle bin is empty.</p>}
      {(items ?? []).map((item) => (
        <RowMenu
          key={item.id}
          title={baseName(item.path)}
          sub={`${item.device}:${parentOf(item.path)}`}
          copies={[{ label: "Path", value: `${item.device}:${item.path}` }]}
          actions={[
            ...(!readOnly
              ? [
                  {
                    label: "Restore",
                    icon: <RotateCcw />,
                    onSelect: () => act(item.id, filesApi.restore(item.id)),
                    disabled: busy !== "",
                  },
                ]
              : []),
            {
              label: "Remove from the recycle bin",
              icon: <X />,
              danger: true,
              onSelect: () => act(item.id, filesApi.purge(item.id)),
              disabled: busy !== "",
            },
          ]}
        >
          <div className="fl-lr fl-trash-r">
            <span data-col="name">
              <span className="n" title={item.path}>
                {baseName(item.path)}
              </span>
              <span className="m">
                {item.device}:{parentOf(item.path)} · {size(item.size)} ·{" "}
                {at(item.ts).split(",")[0]}
              </span>
            </span>
            <span
              className="fl-badge"
              data-col="reason"
              data-tone={item.reason === "replaced" ? "acc" : "bad"}
            >
              {item.reason}
            </span>
            <span className="fl-left" data-col="left">
              {left(item.ts)}
            </span>
            {!readOnly ? (
              <button
                type="button"
                className="fp-act"
                disabled={busy !== ""}
                title={`Put it back at ${item.device}:${item.path}`}
                onClick={() => act(item.id, filesApi.restore(item.id))}
              >
                {busy === item.id ? "Restoring…" : "Restore"}
              </button>
            ) : (
              <span />
            )}
          </div>
        </RowMenu>
      ))}
    </div>
  );
}
