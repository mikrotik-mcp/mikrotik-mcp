import type { UmCollectionState } from "../../src/observability/um-reports";

/** Progress describes verified rows, not invented accounting or an estimated ETA. */
export function UmReportLoading({ progress }: { progress?: UmCollectionState["progress"] }) {
  return (
    <div className="um-loading" role="status" aria-live="polite">
      <div className="um-loading-bars" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
        <i />
      </div>
      <h3>Preparing your first saved report</h3>
      <p>
        Building the first cached snapshot in the background. You can leave this page; collection
        continues and the saved report survives server restarts.
      </p>
      {progress?.source === "sessions" && progress.total != null ? (
        <div className="grid w-full max-w-sm gap-2">
          <span className="text-sm tabular-nums">
            {progress.completed.toLocaleString()} / {progress.total.toLocaleString()} sessions
            verified
          </span>
          <progress
            className="h-2 w-full accent-primary"
            aria-label="Accounting collection"
            max={Math.max(1, progress.total)}
            value={progress.completed}
          />
        </div>
      ) : progress ? (
        <span className="text-sm text-muted-foreground">Reading {progress.source}…</span>
      ) : null}
      <small>
        Only complete reports are shown. Slow or failed reads are reported, not counted as zero.
      </small>
    </div>
  );
}
