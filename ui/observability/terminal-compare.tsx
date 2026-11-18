/**
 * Differences between two terminal outputs: two blocks of one pane, or the same
 * command on two routers. Pick a block, then a second one.
 */
import { GitCompareArrows, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { diffLines } from "../../src/core/diff";
import { UnifiedDiff } from "./diff-view";
import { changesStore, compareStore } from "./terminal-lib";

export function CompareDialog(): ReactNode {
  const { first, second } = useSyncExternalStore(compareStore.subscribe, compareStore.get);
  const changes = useSyncExternalStore(changesStore.subscribe, changesStore.get);
  const diff = useMemo(
    () =>
      first && second
        ? diffLines(first.text, second.text, { fromLabel: first.label, toLabel: second.label })
        : null,
    [first, second],
  );
  useEffect(() => {
    if (!first) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") compareStore.clear();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [first]);

  if (changes) {
    return (
      <div className="term-modal" role="dialog" aria-modal="true" aria-label="What changed">
        <div className="term-modal-card">
          <header>
            <strong>
              <GitCompareArrows size={15} /> {changes.title}
            </strong>
            <button type="button" onClick={changesStore.close} aria-label="Close">
              <X size={16} />
            </button>
          </header>
          <UnifiedDiff unified={changes.text} maxHeight={560} />
        </div>
      </div>
    );
  }
  if (!first) return null;
  if (!second || !diff) {
    return (
      <div className="term-compare-hint" role="status">
        <GitCompareArrows size={14} />
        <span>
          Comparing <code>{first.label}</code> — pick a second block, in any pane.
        </span>
        <button type="button" onClick={compareStore.clear}>
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
          <span className="term-compare-sum">
            <b data-kind="add">+{diff.summary.added}</b>
            <b data-kind="del">−{diff.summary.removed}</b>
            {diff.summary.unchanged} unchanged
          </span>
          <button type="button" onClick={compareStore.clear} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="term-compare-sides">
          <code data-kind="del">− {first.label}</code>
          <code data-kind="add">+ {second.label}</code>
        </div>
        {diff.summary.changed ? (
          <UnifiedDiff unified={diff.unified} maxHeight={560} />
        ) : (
          <p className="term-compare-same">The two outputs are identical.</p>
        )}
      </div>
    </div>
  );
}
