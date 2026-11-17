/**
 * Shared view: one router's terminal activity from the moment of sharing, for
 * a second person to follow. It shows commands and outputs and has no input.
 *
 * It is a view, not a permission: whoever opens the link still needs access to
 * this dashboard, and that access is not limited by the link.
 */
import { Eye } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { HistoryEntry } from "./terminal-lib";
import { cleanOutput } from "./terminal-lib";

export function SharedView({ id }: { id: string }): ReactNode {
  const [view, setView] = useState<{ device: string; since: number; entries: HistoryEntry[] }>();
  const [error, setError] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const count = view?.entries.length ?? 0;

  useEffect(() => {
    let alive = true;
    const load = (): void => {
      api<{ device: string; since: number; entries: HistoryEntry[] }>(
        `/api/terminal/shared?id=${encodeURIComponent(id)}`,
      )
        .then((next) => alive && (setView(next), setError("")))
        .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    };
    load();
    const timer = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [id]);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [count]);

  return (
    <div className="term-page">
      <div className="term-toolbar">
        <span className="term-toolbar-label">
          <Eye size={14} /> Shared view{view ? ` · ${view.device}` : ""} · read only
        </span>
        {view && (
          <span className="term-toolbar-label">
            since {new Date(view.since).toLocaleTimeString()} · {count} command
            {count === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <div className="term-dock term-shared">
        {error && <div className="term-banner">{error}</div>}
        {view && count === 0 && (
          <div className="term-welcome">
            <strong>{view.device}</strong>
            <span>Waiting for the first command. This view updates every two seconds.</span>
          </div>
        )}
        {view?.entries.map((entry) => (
          <article key={entry.id} className="term-block" data-status={entry.ok ? "ok" : "error"}>
            <header className="term-block-head">
              <span className="term-prompt">
                <span className="term-prompt-device">{entry.device}</span>
                <span className="term-prompt-mark">&gt;</span>
              </span>
              <code className="term-block-command">{entry.command}</code>
              <span className="term-block-meta">
                <span className="term-chip" data-tone={entry.ok ? "ok" : "err"}>
                  {entry.ok ? `${entry.ms} ms` : "failed"}
                </span>
                <time className="term-time">{new Date(entry.ts).toLocaleTimeString()}</time>
              </span>
            </header>
            {entry.output && (
              <pre className="term-output">{cleanOutput(entry.output).trimEnd()}</pre>
            )}
            {entry.error && <div className="term-error">{entry.error}</div>}
          </article>
        ))}
        <div ref={end} />
      </div>
    </div>
  );
}
