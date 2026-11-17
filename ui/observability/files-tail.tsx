/**
 * Follow a file that grows, such as a log that RouterOS writes to disk: the end
 * of the file now, then each line as the router adds it.
 */
import { Radio, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { filesApi, tailStore } from "./files-lib";

/** The dialog keeps this much text; older text is dropped. */
const MAX_CHARS = 400_000;

export function TailDialog(): ReactNode {
  const file = useSyncExternalStore(tailStore.subscribe, tailStore.get);
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
    if (!file) return;
    const abort = new AbortController();
    filesApi
      .tail(file, (more) => setText((now) => (now + more).slice(-MAX_CHARS)), abort.signal)
      .then(() => setState("ended"))
      .catch((e: unknown) => {
        if (abort.signal.aborted) return;
        setState("error");
        setError(e instanceof Error ? e.message : String(e));
      });
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") tailStore.set(null);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      abort.abort();
      window.removeEventListener("keydown", onKey);
    };
  }, [file]);

  // Stay at the end while new text arrives, unless the user scrolled up.
  useEffect(() => {
    if (follow && view.current) view.current.scrollTop = view.current.scrollHeight;
  }, [text, follow]);

  if (!file) return null;
  return (
    <div className="term-modal" role="dialog" aria-modal="true" aria-label={`Follow ${file.path}`}>
      <div className="term-modal-card files-viewer">
        <header>
          <strong>
            <Radio size={15} /> {file.path}
          </strong>
          <span className="files-viewer-meta" data-live={state === "live"}>
            {file.device} ·{" "}
            {state === "live"
              ? "following"
              : state === "ended"
                ? "ended after 30 minutes"
                : "stopped"}
          </span>
          <span className="files-viewer-actions">
            <button type="button" data-on={follow} onClick={() => setFollow((on) => !on)}>
              {follow ? "Following the end" : "Follow the end"}
            </button>
            <button type="button" onClick={() => tailStore.set(null)} aria-label="Close">
              <X size={16} />
            </button>
          </span>
        </header>
        {error && (
          <p className="files-empty" data-tone="danger">
            {error}
          </p>
        )}
        <pre
          ref={view}
          className="files-code files-tail"
          tabIndex={0}
          onScroll={(event) => {
            const box = event.currentTarget;
            const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
            if (atEnd !== follow) setFollow(atEnd);
          }}
        >
          {text || (state === "live" ? "Waiting for the router…" : "")}
        </pre>
      </div>
    </div>
  );
}
