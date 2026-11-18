/**
 * Follow a file that grows, such as a log that RouterOS writes to disk: the end
 * of the file now, then each line as the router adds it. Shown in the viewer's
 * Follow tab.
 */
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { FileRef } from "./files-lib";
import { filesApi } from "./files-lib";
import { Strip } from "./files-parts";

/** The view keeps this much text; older text is dropped. */
const MAX_CHARS = 400_000;

export function TailView({
  file,
  onState,
}: {
  file: FileRef;
  onState?: (state: "live" | "ended" | "error") => void;
}): ReactNode {
  const [text, setText] = useState("");
  const [state, setState] = useState<"live" | "ended" | "error">("live");
  const [error, setError] = useState("");
  const [follow, setFollow] = useState(true);
  const view = useRef<HTMLPreElement>(null);

  useEffect(() => {
    setText("");
    setError("");
    setState("live");
    setFollow(true);
    const abort = new AbortController();
    filesApi
      .tail(file, (more) => setText((now) => (now + more).slice(-MAX_CHARS)), abort.signal)
      .then(() => setState("ended"))
      .catch((e: unknown) => {
        if (abort.signal.aborted) return;
        setState("error");
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => abort.abort();
  }, [file]);
  useEffect(() => onState?.(state), [state, onState]);

  // Stay at the end while new text arrives, unless the user scrolled up.
  useEffect(() => {
    if (follow && view.current) view.current.scrollTop = view.current.scrollHeight;
  }, [text, follow]);

  return (
    <div className="fl-tail">
      {error && <Strip tone="danger">{error}</Strip>}
      <pre
        ref={view}
        className="fl-tail-out"
        tabIndex={0}
        aria-live="polite"
        onScroll={(event) => {
          const box = event.currentTarget;
          const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
          if (atEnd !== follow) setFollow(atEnd);
        }}
      >
        {text || (state === "live" ? "Waiting for the router…" : "")}
      </pre>
      <Strip
        tone={state === "live" ? "ok" : undefined}
        actions={
          <button
            type="button"
            className="fp-act"
            data-on={follow || undefined}
            aria-pressed={follow}
            onClick={() => setFollow((on) => !on)}
          >
            {follow ? "Following the end" : "Follow the end"}
          </button>
        }
      >
        {state === "live"
          ? "Following. New lines appear as the router writes them."
          : state === "ended"
            ? "Stopped after 30 minutes."
            : "Stopped."}
      </Strip>
    </div>
  );
}
