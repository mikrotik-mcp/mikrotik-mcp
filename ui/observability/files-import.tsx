/**
 * Import a `.rsc` file on its router. The dialog first asks the router for a
 * dry run, which reports the errors and changes nothing; the real import needs
 * a second, explicit click.
 */
import { Play, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { filesApi, importStore } from "./files-lib";
import { Dialog, Strip } from "./files-parts";

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
    <Dialog
      label="Import a script"
      icon={<Play size={16} />}
      title={`Import ${file.path}`}
      meta={`on ${file.device}`}
      onClose={() => importStore.set(null)}
    >
      {!shown && !error && <p className="fl-empty">The router is checking the script (dry run)…</p>}
      {error && <Strip tone="danger">{error}</Strip>}
      {shown && (
        <>
          <Strip
            tone={shown.ok ? "ok" : "danger"}
            icon={<ShieldCheck size={15} />}
            actions={
              !result &&
              (armed ? (
                <>
                  <button type="button" className="fp-act" onClick={() => setArmed(false)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="fp-act"
                    data-tone="danger"
                    disabled={running}
                    onClick={run}
                  >
                    {running ? "Importing…" : `Yes, change ${file.device}`}
                  </button>
                </>
              ) : (
                <button type="button" className="fp-act" onClick={() => setArmed(true)}>
                  Run the import…
                </button>
              ))
            }
          >
            {result
              ? result.ok
                ? "The import ran."
                : "The import stopped with an error."
              : check?.ok
                ? "Dry run: the router accepts every line. Nothing was changed."
                : "Dry run: the router found an error. Nothing was changed."}
          </Strip>
          <pre className="fl-out">{shown.output || "(no output)"}</pre>
        </>
      )}
    </Dialog>
  );
}
