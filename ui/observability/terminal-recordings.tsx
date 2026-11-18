/**
 * Recordings of interactive shell sessions: a list on the left, a player on
 * the right. The player has play/pause, a seek bar, speeds and a text search.
 * A recording holds what the router printed (asciicast v2); typed keys are not
 * recorded.
 */
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { CircleDot, Pause, Play, RotateCcw, Trash2, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, deleteJson, withToken } from "./api";
import { SearchInput, Segmented, Select, Slider } from "./kit";
import { popIn } from "./kit/motion";
import { followTheme, xtermFont, xtermTheme } from "./terminal-xterm";
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
      fontFamily: xtermFont(element),
      fontSize: 12.5,
      lineHeight: 1.2,
      scrollback: 10_000,
      theme: xtermTheme(element),
    });
    const unfollow = followTheme(created, element);
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
      unfollow();
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
      <header className="term-mod-hd">
        <b className="term-player-dev">{recording.device}</b>
        <span className="m">
          {new Date(recording.started).toLocaleString([], {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          })}{" "}
          · {clock(total, total < 10)} · {bytes(recording.bytes)}
        </span>
        <span className="sp" />
        <SearchInput
          size="sm"
          wrapClassName="term-player-search"
          value={query}
          placeholder="Search the recording"
          spellCheck={false}
          label="Search the recording"
          onChange={setQuery}
          end={needle && <small>{hits.length === 300 ? "300+" : hits.length}</small>}
        />
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
      <footer className="term-player-ctl">
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
        <span className="term-player-time">{clock(at, total < 10)}</span>
        <Slider
          className="term-player-seek"
          showLabel={false}
          min={0}
          max={Math.max(total, 0.01)}
          step={0.01}
          value={Math.min(at, total)}
          label="Position"
          format={(n) => clock(n, total < 10)}
          onChange={(value) => seek(typeof value === "number" ? value : value[0])}
        />
        <span className="term-player-time">{clock(total, total < 10)}</span>
        <Segmented
          size="sm"
          label="Speed"
          className="term-player-speed"
          value={String(speed)}
          onChange={(value) => setSpeed(Number(value))}
          options={["1", "2", "4", "8"].map((value) => ({ value, label: `${value}×` }))}
        />
      </footer>
    </section>
  );
}

export function RecordingsDialog({
  devices = [],
  onClose,
}: {
  /** Router names for the filter; recordings of other routers are listed too. */
  devices?: string[];
  onClose: () => void;
}): ReactNode {
  const [items, setItems] = useState<Recording[] | null>(null);
  const [open, setOpen] = useState<Recording | null>(null);
  const [cast, setCast] = useState("");
  const [filter, setFilter] = useState("*");
  const card = useRef<HTMLDivElement>(null);

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
    if (card.current) return popIn(card.current);
  }, []);
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

  const shown = (items ?? []).filter((item) => filter === "*" || item.device === filter);
  const routers = [...new Set([...devices, ...(items ?? []).map((item) => item.device)])];
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
      <div className="term-mod term-recordings" ref={card}>
        <header className="term-mod-hd">
          <CircleDot size={16} />
          <h2>Recordings</h2>
          <span className="m">
            What the router printed in each shell. Typed keys are not recorded.
          </span>
          <span className="sp" />
          <button
            type="button"
            className="term-ib"
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
          >
            <X size={15} />
          </button>
        </header>
        <div className="term-pl">
          <aside className="term-pl-l">
            <div className="term-pl-filter">
              <Select
                size="sm"
                label="Recordings of"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: "*", label: "Every router" },
                  ...routers.map((name) => ({ value: name, label: name })),
                ]}
              />
            </div>
            <div className="term-pl-list">
              {items?.length === 0 && (
                <p className="term-pl-none">
                  No recording yet. Open a <b>Shell</b> console: each session is recorded here.
                </p>
              )}
              {groups.map(([label, list]) => (
                <section key={label}>
                  <h4 className="term-pl-g">{label}</h4>
                  {list.map((item) => (
                    <div
                      key={item.id}
                      className="term-pl-it"
                      data-on={open?.id === item.id || undefined}
                    >
                      <button type="button" onClick={() => setOpen(item)}>
                        {item.device}
                        <small>
                          {new Date(item.started).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                            hour12: false,
                          })}{" "}
                          · {bytes(item.bytes)}
                        </small>
                      </button>
                      <button
                        type="button"
                        className="term-ib"
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
              <CircleDot size={28} />
              <p>{open ? "Loading the recording…" : "Pick a recording to play it."}</p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
