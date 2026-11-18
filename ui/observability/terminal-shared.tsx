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
      <div className="term-bar">
        <span className="term-chip" data-on="true">
          <Eye size={14} /> Shared view{view ? ` · ${view.device}` : ""} · read only
        </span>
        {view && (
          <span className="term-chip">
            since {new Date(view.since).toLocaleTimeString()} · {count} command
            {count === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <div className="term-shared">
        {error && <div className="term-banner">{error}</div>}
        {view && count === 0 && (
          <div className="term-welcome">
            <strong>{view.device}</strong>
            <span>Waiting for the first command. This view updates every two seconds.</span>
          </div>
        )}
        {view?.entries.map((entry) => (
          <article key={entry.id} className="term-blk" data-status={entry.ok ? "ok" : "error"}>
            <header className="term-blk-h">
              <span className="pr" title={entry.device}>
                ›
              </span>
              <code className="cmd">{entry.command}</code>
              <span className="sp" />
              <span className="term-ch" data-tone={entry.ok ? "ok" : "bad"}>
                {entry.ok ? `✓ ${entry.ms} ms` : "✕ failed"}
              </span>
              <time className="term-ch">{new Date(entry.ts).toLocaleTimeString()}</time>
            </header>
            {entry.output && (
              <pre className="term-blk-o">{cleanOutput(entry.output).trimEnd()}</pre>
            )}
            {entry.error && (
              <pre className="term-blk-o">
                <span className="err">{entry.error}</span>
              </pre>
            )}
          </article>
        ))}
        <div ref={end} />
      </div>
    </div>
  );
}
