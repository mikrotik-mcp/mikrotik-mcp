/**
 * Differences between two text files, on one router or on two. Pick a file with
 * Compare, then a second one in any pane.
 */
import { GitCompareArrows, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { diffLines } from "../../src/core/diff";
import { UnifiedDiff } from "./diff-view";
import { compareStore, filesApi } from "./files-lib";

export function FileCompare(): ReactNode {
  const picks = useSyncExternalStore(compareStore.subscribe, compareStore.get);
  const [texts, setTexts] = useState<[string, string] | null>(null);
  const [error, setError] = useState("");
  const [first, second] = picks;

  useEffect(() => {
    setTexts(null);
    setError("");
    if (!first || !second) return;
    let current = true;
    Promise.all([filesApi.read(first), filesApi.read(second)])
      .then(([a, b]) => current && setTexts([a.text, b.text]))
      .catch((e: unknown) => current && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      current = false;
    };
  }, [first, second]);
  useEffect(() => {
    if (!first) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") compareStore.set([]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [first]);

  const labels = picks.map((file) => `${file.device}:${file.path}`);
  const diff = useMemo(
    () =>
      texts ? diffLines(texts[0], texts[1], { fromLabel: labels[0], toLabel: labels[1] }) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the labels follow the texts
    [texts],
  );

  if (!first) return null;
  if (!second) {
    return (
      <div className="term-compare-hint" role="status">
        <GitCompareArrows size={14} />
        <span>
          Comparing <code>{labels[0]}</code> — select a second file in any pane and click Compare.
        </span>
        <button type="button" onClick={() => compareStore.set([])}>
          Cancel
        </button>
      </div>
    );
  }
  return (
    <div className="term-modal" role="dialog" aria-modal="true" aria-label="Differences">
      <div className="term-modal-card">
        <header>
          <strong>
            <GitCompareArrows size={15} /> Differences
          </strong>
          {diff && (
            <span className="term-compare-sum">
              <b data-kind="add">+{diff.summary.added}</b>
              <b data-kind="del">−{diff.summary.removed}</b>
              {diff.summary.unchanged} unchanged
            </span>
          )}
          <button type="button" onClick={() => compareStore.set([])} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="term-compare-sides">
          <code data-kind="del">− {labels[0]}</code>
          <code data-kind="add">+ {labels[1]}</code>
        </div>
        {error && (
          <p className="files-empty" data-tone="danger">
            {error}
          </p>
        )}
        {!diff && !error && <p className="files-empty">Reading the two files…</p>}
        {diff &&
          (diff.summary.changed ? (
            <UnifiedDiff unified={diff.unified} maxHeight={600} />
          ) : (
            <p className="term-compare-same">The two files are identical.</p>
          ))}
      </div>
    </div>
  );
}
