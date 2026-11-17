/**
 * Recordings of interactive shell sessions: pick one, then play it back in a
 * terminal at 1x, 4x or at once, or search its text. A recording holds what
 * the router printed (asciicast v2); typed keys are not recorded.
 */
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Play, Trash2, Video, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, deleteJson, withToken } from "./api";
import { cleanOutput } from "./terminal-lib";

interface Recording {
  id: string;
  device: string;
  started: number;
  bytes: number;
}
type Frame = [number, string];

/** The output frames of an asciicast v2 text: `[seconds, "o", data]` per line. */
export function parseCast(text: string): Frame[] {
  const frames: Frame[] = [];
  for (const line of text.split("\n").slice(1)) {
    if (!line.startsWith("[")) continue;
    try {
      const [at, kind, data] = JSON.parse(line) as [number, string, string];
      if (kind === "o" && typeof data === "string") frames.push([at, data]);
    } catch {
      /* a cut-off last line */
    }
  }
  return frames;
}

const size = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1_048_576
      ? `${(bytes / 1024).toFixed(0)} KB`
      : `${(bytes / 1_048_576).toFixed(1)} MB`;

export function RecordingsDialog({ onClose }: { onClose: () => void }): ReactNode {
  const [items, setItems] = useState<Recording[] | null>(null);
  const [open, setOpen] = useState<Recording | null>(null);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [speed, setSpeed] = useState(4);
  const [run, setRun] = useState(0);
  const [query, setQuery] = useState("");
  const host = useRef<HTMLDivElement>(null);

  const refresh = useCallback((): void => {
    api<{ recordings: Recording[] }>("/api/terminal/recordings")
      .then((r) => setItems(r.recordings))
      .catch(() => setItems([]));
  }, []);
  useEffect(refresh, [refresh]);

  useEffect(() => {
    if (!open) return;
    setFrames([]);
    void fetch(withToken(`/api/terminal/recording?id=${encodeURIComponent(open.id)}`))
      .then((r) => r.text())
      .then((text) => setFrames(parseCast(text)))
      .catch(() => {});
  }, [open]);

  // Play the frames into a terminal, with long pauses shortened to two seconds.
  useEffect(() => {
    const element = host.current;
    if (!element || !frames.length) return;
    const term = new Terminal({ fontSize: 12.5, scrollback: 10_000, disableStdin: true });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    fit.fit();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let index = 0;
    const next = (): void => {
      const frame = frames[index];
      if (!frame) return;
      term.write(frame[1]);
      index++;
      const following = frames[index];
      if (!following) return;
      if (speed === 0) next();
      else timer = setTimeout(next, (Math.min(2, following[0] - frame[0]) * 1000) / speed);
    };
    next();
    return () => {
      clearTimeout(timer);
      term.dispose();
    };
  }, [frames, speed, run]);

  const hits = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return cleanOutput(frames.map((frame) => frame[1]).join(""))
      .split("\n")
      .filter((line) => line.toLowerCase().includes(needle))
      .slice(0, 200);
  }, [frames, query]);

  return (
    <div className="term-modal" role="dialog" aria-modal="true" aria-label="Shell recordings">
      <div className="term-modal-card term-recordings">
        <header>
          <strong>
            <Video size={15} /> Shell recordings
          </strong>
          <button type="button" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="term-recordings-body">
          <ol>
            {items?.length === 0 && (
              <li className="term-rows-empty">
                No recording yet. Each interactive shell session is recorded here.
              </li>
            )}
            {items?.map((item) => (
              <li key={item.id} data-on={open?.id === item.id}>
                <button type="button" onClick={() => setOpen(item)}>
                  <b>{item.device}</b>
                  <span>{new Date(item.started).toLocaleString()}</span>
                  <small>{size(item.bytes)}</small>
                </button>
                <button
                  type="button"
                  aria-label="Delete this recording"
                  title="Delete this recording"
                  onClick={() => {
                    if (open?.id === item.id) setOpen(null);
                    void deleteJson("/api/terminal/recordings", { id: item.id }).then(refresh);
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </li>
            ))}
          </ol>
          <section>
            {open ? (
              <>
                <div className="term-recordings-tools">
                  <button type="button" onClick={() => setRun((n) => n + 1)}>
                    <Play size={12} /> Play again
                  </button>
                  {[1, 4, 0].map((value) => (
                    <button
                      key={value}
                      type="button"
                      data-on={speed === value}
                      onClick={() => setSpeed(value)}
                    >
                      {value === 0 ? "at once" : `${value}×`}
                    </button>
                  ))}
                  <input
                    value={query}
                    placeholder="Search this recording…"
                    spellCheck={false}
                    aria-label="Search this recording"
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </div>
                {query.trim() ? (
                  <pre className="term-recordings-hits">
                    {hits.length ? hits.join("\n") : "No line matches."}
                  </pre>
                ) : (
                  <div className="term-recordings-screen" ref={host} />
                )}
              </>
            ) : (
              <p className="term-compare-same">Pick a recording to play it.</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
