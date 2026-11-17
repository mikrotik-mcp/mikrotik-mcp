/**
 * Recordings of interactive shell sessions: a list on the left, a player on
 * the right. The player has play/pause, a seek bar, speeds and a text search.
 * A recording holds what the router printed (asciicast v2); typed keys are not
 * recorded.
 */
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Pause, Play, RotateCcw, Search, Trash2, Video, X } from "lucide-react";
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

/** The recorded screen size, from the first line; 100×30 when it is missing. */
export function castSize(text: string): { cols: number; rows: number } {
  try {
    const header = JSON.parse(text.split("\n", 1)[0] ?? "") as { width?: number; height?: number };
    return { cols: header.width || 100, rows: header.height || 30 };
  } catch {
    return { cols: 100, rows: 30 };
  }
}

/** Pauses longer than this are played as this, so idle time does not stall playback. */
const MAX_GAP = 2;
/** Playback time of each frame, with long pauses shortened. */
export function frameTimes(frames: Frame[]): number[] {
  const times: number[] = [];
  let clock = 0;
  frames.forEach((frame, i) => {
    const previous = frames[i - 1];
    if (previous) clock += Math.min(MAX_GAP, Math.max(0, frame[0] - previous[0]));
    times.push(clock);
  });
  return times;
}

const bytes = (n: number): string =>
  n < 1024
    ? `${n} B`
    : n < 1_048_576
      ? `${(n / 1024).toFixed(0)} KB`
      : `${(n / 1_048_576).toFixed(1)} MB`;
/** `m:ss`, with tenths of a second for a recording shorter than ten seconds. */
const clock = (seconds: number, short = false): string => {
  const whole = `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
  return short ? `${whole}.${Math.floor((seconds % 1) * 10)}` : whole;
};
const day = (ts: number): string => {
  const date = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
};
const ink = (element: Element, name: string): string =>
  getComputedStyle(element).getPropertyValue(name).trim();

function Player({ recording, cast }: { recording: Recording; cast: string }): ReactNode {
  const frames = useMemo(() => parseCast(cast), [cast]);
  const times = useMemo(() => frameTimes(frames), [frames]);
  const total = times.at(-1) ?? 0;
  const screen = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  /** Index of the next frame to write. */
  const cursor = useRef(0);
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(2);
  const [query, setQuery] = useState("");

  // One terminal per recording, at the size the session had.
  useEffect(() => {
    const element = screen.current;
    if (!element) return;
    const created = new Terminal({
      disableStdin: true,
      cursorBlink: false,
      fontFamily: ink(element, "--term-mono") || "monospace",
      fontSize: 12.5,
      scrollback: 10_000,
      theme: {
        background: ink(element, "--term-bg"),
        foreground: ink(element, "--term-ink"),
        cursor: ink(element, "--term-accent"),
        selectionBackground: ink(element, "--term-line"),
      },
    });
    // Sized to the player, not to the recorded window: the session must fit here.
    const fit = new FitAddon();
    created.loadAddon(fit);
    created.open(element);
    fit.fit();
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* hidden while the search results show */
      }
    });
    observer.observe(element);
    term.current = created;
    cursor.current = 0;
    setAt(0);
    setPlaying(true);
    return () => {
      observer.disconnect();
      term.current = null;
      created.dispose();
    };
  }, [cast]);

  // The playback clock: write the next frame, then wait for the one after it.
  useEffect(() => {
    if (!playing) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const step = (): void => {
      const frame = frames[cursor.current];
      if (!frame || !term.current) {
        setPlaying(false);
        return;
      }
      term.current.write(frame[1]);
      setAt(times[cursor.current] ?? 0);
      cursor.current++;
      const next = times[cursor.current];
      if (next === undefined) {
        setPlaying(false);
        return;
      }
      timer = setTimeout(step, ((next - (times[cursor.current - 1] ?? 0)) * 1000) / speed);
    };
    step();
    return () => clearTimeout(timer);
  }, [playing, speed, frames, times]);

  /** Show the screen as it was at `seconds`: replay everything up to there at once. */
  const seek = useCallback(
    (seconds: number): void => {
      const screenTerm = term.current;
      if (!screenTerm) return;
      let index = times.findIndex((time) => time > seconds);
      if (index === -1) index = frames.length;
      screenTerm.reset();
      screenTerm.write(
        frames
          .slice(0, index)
          .map((frame) => frame[1])
          .join(""),
      );
      cursor.current = index;
      setAt(seconds);
    },
    [frames, times],
  );

  const text = useMemo(() => cleanOutput(frames.map((frame) => frame[1]).join("")), [frames]);
  const needle = query.trim().toLowerCase();
  const hits = useMemo(
    () =>
      needle
        ? text
            .split("\n")
            .filter((line) => line.toLowerCase().includes(needle))
            .slice(0, 300)
        : [],
    [text, needle],
  );
  const ended = cursor.current >= frames.length && !playing;

  return (
    <section className="term-player">
      <header>
        <span className="term-player-dot" />
        <b>{recording.device}</b>
        <span>
          {day(recording.started)} · {new Date(recording.started).toLocaleTimeString()}
        </span>
        <span>{clock(total, total < 10)} long</span>
        <span>{bytes(recording.bytes)}</span>
        <label className="term-player-search">
          <Search size={12} />
          <input
            value={query}
            placeholder="Search this recording…"
            spellCheck={false}
            aria-label="Search this recording"
            onChange={(event) => setQuery(event.target.value)}
          />
          {needle && <small>{hits.length === 300 ? "300+" : hits.length}</small>}
        </label>
      </header>
      <div className="term-player-stage">
        <div className="term-player-screen" ref={screen} data-hidden={Boolean(needle)} />
        {needle && (
          <ol className="term-player-hits">
            {hits.length === 0 && <li className="term-rows-empty">No line matches.</li>}
            {hits.map((line, i) => {
              const from = line.toLowerCase().indexOf(needle);
              return (
                // eslint-disable-next-line react/no-array-index-key -- a line may repeat
                <li key={i}>
                  {line.slice(0, from)}
                  <mark>{line.slice(from, from + needle.length)}</mark>
                  {line.slice(from + needle.length)}
                </li>
              );
            })}
          </ol>
        )}
      </div>
      <footer>
        <button
          type="button"
          className="term-player-play"
          onClick={() => {
            if (ended) seek(0);
            setPlaying((on) => !on || ended);
          }}
          aria-label={playing ? "Pause" : ended ? "Play again" : "Play"}
          title={playing ? "Pause" : ended ? "Play again" : "Play"}
        >
          {playing ? <Pause size={15} /> : ended ? <RotateCcw size={15} /> : <Play size={15} />}
        </button>
        <span className="term-player-time">
          {clock(at, total < 10)} / {clock(total, total < 10)}
        </span>
        <input
          type="range"
          className="term-player-seek"
          min={0}
          max={Math.max(total, 0.01)}
          step={0.01}
          value={Math.min(at, total)}
          aria-label="Position"
          style={{ "--done": `${total ? (Math.min(at, total) / total) * 100 : 0}%` } as never}
          onChange={(event) => seek(Number(event.target.value))}
        />
        <span className="term-player-speeds" role="group" aria-label="Speed">
          {[1, 2, 4, 8].map((value) => (
            <button
              key={value}
              type="button"
              data-on={speed === value}
              onClick={() => setSpeed(value)}
            >
              {value}×
            </button>
          ))}
        </span>
      </footer>
    </section>
  );
}

export function RecordingsDialog({ onClose }: { onClose: () => void }): ReactNode {
  const [items, setItems] = useState<Recording[] | null>(null);
  const [open, setOpen] = useState<Recording | null>(null);
  const [cast, setCast] = useState("");
  const [filter, setFilter] = useState("");

  const refresh = useCallback((): void => {
    api<{ recordings: Recording[] }>("/api/terminal/recordings")
      .then((r) => {
        setItems(r.recordings);
        setOpen((current) => current ?? r.recordings[0] ?? null);
      })
      .catch(() => setItems([]));
  }, []);
  useEffect(refresh, [refresh]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    setCast("");
    if (!open) return;
    let alive = true;
    void fetch(withToken(`/api/terminal/recording?id=${encodeURIComponent(open.id)}`))
      .then((r) => r.text())
      .then((text) => alive && setCast(text))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open]);

  const shown = (items ?? []).filter((item) =>
    item.device.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  // Group the list by day, newest first.
  const groups = useMemo(() => {
    const byDay = new Map<string, Recording[]>();
    for (const item of shown)
      byDay.set(day(item.started), [...(byDay.get(day(item.started)) ?? []), item]);
    return Array.from(byDay);
  }, [shown]);

  return (
    <div
      className="term-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Shell recordings"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="term-modal-card term-recordings">
        <header>
          <span className="term-recordings-badge">
            <Video size={16} />
          </span>
          <div>
            <strong>Shell recordings</strong>
            <p>What the router printed in each interactive shell. Typed keys are not recorded.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <X size={16} />
          </button>
        </header>
        <div className="term-recordings-body">
          <aside>
            <label className="term-search">
              <Search size={13} />
              <input
                value={filter}
                placeholder="Filter by router…"
                spellCheck={false}
                aria-label="Filter recordings by router"
                onChange={(event) => setFilter(event.target.value)}
              />
              {items && <small>{shown.length}</small>}
            </label>
            <div className="term-recordings-list">
              {items?.length === 0 && (
                <p className="term-recordings-none">
                  No recording yet. Open a <b>Shell</b> terminal: each session is recorded here.
                </p>
              )}
              {groups.map(([label, list]) => (
                <section key={label}>
                  <h4>{label}</h4>
                  {list.map((item) => (
                    <div key={item.id} className="term-recording" data-on={open?.id === item.id}>
                      <button type="button" onClick={() => setOpen(item)}>
                        <b>{item.device}</b>
                        <span>
                          {new Date(item.started).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                          <i>{bytes(item.bytes)}</i>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="term-recording-delete"
                        aria-label={`Delete the recording of ${item.device}`}
                        title="Delete this recording"
                        onClick={() => {
                          if (open?.id === item.id) setOpen(null);
                          void deleteJson("/api/terminal/recordings", { id: item.id }).then(
                            refresh,
                          );
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </section>
              ))}
            </div>
          </aside>
          {open && cast ? (
            <Player key={open.id} recording={open} cast={cast} />
          ) : (
            <section className="term-player term-player-empty">
              <Video size={30} />
              <p>{open ? "Loading the recording…" : "Pick a recording to play it."}</p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
