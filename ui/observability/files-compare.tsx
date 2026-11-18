/**
 * Differences between two text files, on one router or on two. Pick a file with
 * Compare, then a second one in any pane. Side by side, matching lines aligned,
 * or as a unified diff.
 */
import { ArrowLeftRight, GitCompareArrows } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { DiffOp } from "../../src/core/diff";
import { diffLines } from "../../src/core/diff";
import { UnifiedDiff } from "./diff-view";
import { compareStore, filesApi } from "./files-lib";
import { Count, Dialog, Strip, day } from "./files-parts";
import { Segmented } from "./kit";

type Cell = { n?: number; text: string; kind: "" | "a" | "r" | "e" };

/** Pairs removed and added lines so the two sides stay aligned. */
function sideBySide(ops: DiffOp[]): [Cell, Cell][] {
  const rows: [Cell, Cell][] = [];
  let dels: DiffOp[] = [];
  let adds: DiffOp[] = [];
  const flush = (): void => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      const d = dels[i];
      const a = adds[i];
      rows.push([
        d ? { n: d.aLine, text: d.text, kind: "r" } : { text: "", kind: "e" },
        a ? { n: a.bLine, text: a.text, kind: "a" } : { text: "", kind: "e" },
      ]);
    }
    dels = [];
    adds = [];
  };
  for (const op of ops) {
    if (op.type === "del") dels.push(op);
    else if (op.type === "add") adds.push(op);
    else {
      flush();
      rows.push([
        { n: op.aLine, text: op.text, kind: "" },
        { n: op.bLine, text: op.text, kind: "" },
      ]);
    }
  }
  flush();
  return rows;
}

export function FileCompare(): ReactNode {
  const picks = useSyncExternalStore(compareStore.subscribe, compareStore.get);
  const [texts, setTexts] = useState<[string, string] | null>(null);
  const [times, setTimes] = useState<[number, number] | null>(null);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"side" | "unified">("side");
  const [first, second] = picks;

  useEffect(() => {
    setTexts(null);
    setError("");
    if (!first || !second) return;
    let current = true;
    Promise.all([filesApi.read(first), filesApi.read(second)])
      .then(([a, b]) => {
        if (!current) return;
        setTexts([a.text, b.text]);
        setTimes([a.mtime, b.mtime]);
      })
      .catch((e: unknown) => current && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      current = false;
    };
  }, [first, second]);

  const labels = picks.map((file) => `${file.device} : ${file.path}`);
  const diff = useMemo(
    () =>
      texts ? diffLines(texts[0], texts[1], { fromLabel: labels[0], toLabel: labels[1] }) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the labels follow the texts
    [texts],
  );
  const rows = useMemo(() => (diff ? sideBySide(diff.ops) : []), [diff]);

  if (!first) return null;
  if (!second) {
    return (
      <div className="fl-pick" role="status">
        <Strip
          icon={<GitCompareArrows size={15} />}
          actions={
            <button type="button" className="fp-act" onClick={() => compareStore.set([])}>
              Cancel
            </button>
          }
        >
          Comparing <code>{labels[0]}</code>. Select a second file in any pane and press Compare.
        </Strip>
      </div>
    );
  }
  const close = (): void => compareStore.set([]);
  return (
    <Dialog
      label="Differences"
      icon={<ArrowLeftRight size={16} />}
      title="Differences"
      wide
      onClose={close}
      meta={
        diff && (
          <>
            <b className="add">
              +<Count value={diff.summary.added} />
            </b>{" "}
            ·{" "}
            <b className="del">
              −<Count value={diff.summary.removed} />
            </b>{" "}
            · <Count value={diff.summary.unchanged} /> unchanged
          </>
        )
      }
      tools={
        <Segmented
          size="sm"
          label="Diff layout"
          value={mode}
          onChange={setMode}
          options={[
            { value: "side", label: "Side by side" },
            { value: "unified", label: "Unified" },
          ]}
        />
      }
    >
      {error && <Strip tone="danger">{error}</Strip>}
      {!diff && !error && <p className="fl-empty">Reading the two files…</p>}
      {diff && !diff.summary.changed && <p className="fl-empty">The two files are identical.</p>}
      {diff && diff.summary.changed && mode === "unified" && (
        <UnifiedDiff unified={diff.unified} maxHeight={600} />
      )}
      {diff && diff.summary.changed && mode === "side" && (
        <div className="fl-fdf">
          <div className="h">
            − {labels[0]}
            {times && ` · ${day(times[0])}`}
          </div>
          <div className="h">
            + {labels[1]}
            {times && ` · ${day(times[1])}`}
          </div>
          {rows.map(([left, right], i) => (
            // eslint-disable-next-line react/no-array-index-key -- rows have no identity
            <div key={i} className="row">
              {[left, right].map((cell, side) => (
                <div key={side} className="l" data-kind={cell.kind || undefined}>
                  <span>{cell.n ?? ""}</span>
                  <span>{cell.text || " "}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}
