/**
 * Import a `.rsc` file on its router. The dialog first asks the router for a
 * dry run, which reports the errors and changes nothing; the real import needs
 * a second, explicit click.
 */
import { Play, ShieldCheck, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { filesApi, importStore } from "./files-lib";

export function ImportDialog(): ReactNode {
  const file = useSyncExternalStore(importStore.subscribe, importStore.get);
  const [check, setCheck] = useState<{ ok: boolean; output: string } | null>(null);
  const [result, setResult] = useState<{ ok: boolean; output: string } | null>(null);
  const [error, setError] = useState("");
  const [armed, setArmed] = useState(false);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    setCheck(null);
    setResult(null);
    setError("");
    setArmed(false);
    if (!file) return;
    let current = true;
    filesApi
      .importScript(file, true)
      .then((answer) => current && setCheck(answer))
      .catch((e: unknown) => current && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      current = false;
    };
  }, [file]);

  if (!file) return null;
  const run = (): void => {
    setRunning(true);
    filesApi
      .importScript(file, false)
      .then(setResult)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setRunning(false));
  };
  const shown = result ?? check;

  return (
    <div className="term-modal" role="dialog" aria-modal="true" aria-label="Import a script">
      <div className="term-modal-card files-viewer">
        <header>
          <strong>
            <Play size={15} /> Import {file.path}
          </strong>
          <span className="files-viewer-meta">on {file.device}</span>
          <span className="files-viewer-actions">
            <button type="button" onClick={() => importStore.set(null)} aria-label="Close">
              <X size={16} />
            </button>
          </span>
        </header>
        {!shown && !error && (
          <p className="files-empty">The router is checking the script (dry run)…</p>
        )}
        {error && (
          <p className="files-empty" data-tone="danger">
            {error}
          </p>
        )}
        {shown && (
          <>
            <div className="files-strip" data-tone={shown.ok ? "ok" : "danger"} role="status">
              <span>
                <ShieldCheck size={13} />{" "}
                {result
                  ? result.ok
                    ? "The import ran."
                    : "The import stopped with an error."
                  : check?.ok
                    ? "Dry run: the router accepts every line. Nothing was changed."
                    : "Dry run: the router found an error. Nothing was changed."}
              </span>
              {!result && !armed && (
                <button type="button" onClick={() => setArmed(true)}>
                  Run the import…
                </button>
              )}
              {!result && armed && (
                <>
                  <button type="button" data-danger="true" disabled={running} onClick={run}>
                    {running ? "Importing…" : `Yes, change ${file.device}`}
                  </button>
                  <button type="button" onClick={() => setArmed(false)}>
                    Cancel
                  </button>
                </>
              )}
            </div>
            <pre className="files-code">{shown.output || "(no output)"}</pre>
          </>
        )}
      </div>
    </div>
  );
}
