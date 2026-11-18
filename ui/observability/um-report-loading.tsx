import { LoadingState } from "./loading-state";
import type { UmCollectionState } from "../../src/observability/um-reports";

/** Progress describes verified rows, not invented accounting or an estimated ETA. */
export function UmReportLoading({ progress }: { progress?: UmCollectionState["progress"] }) {
  return (
    <div className="um-loading glass" role="status" aria-live="polite">
      <LoadingState label="Preparing accounting charts" layout="chart" />
      <h3>Preparing your first saved report</h3>
      <p>
        Building the first cached snapshot in the background. You can leave this page; collection
        continues and the saved report survives server restarts.
      </p>
      {progress?.source === "sessions" && progress.total != null ? (
        <div className="grid w-full max-w-sm gap-2">
          <span className="um-loading-count">
            {progress.completed.toLocaleString()} / {progress.total.toLocaleString()} sessions
            verified
          </span>
          <progress
            className="um-progress"
            aria-label="Accounting collection"
            max={Math.max(1, progress.total)}
            value={progress.completed}
          />
        </div>
      ) : progress ? (
        <span className="monitor-hint">Reading {progress.source}…</span>
      ) : null}
      <small>
        Only complete reports are shown. Slow or failed reads are reported, not counted as zero.
      </small>
    </div>
  );
}
