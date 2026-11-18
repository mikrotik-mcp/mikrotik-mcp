/**
 * Scheduled commands: a read command that the server runs at a time or on a
 * repeat, also when no browser is open. Results go to the command history.
 * Only reads can be scheduled; the server refuses anything else.
 */
import { CalendarClock, Trash2, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { api, deleteJson, postJson } from "./api";
import { Select } from "./geist";
import { isReadCommand } from "./terminal-lib";

interface Schedule {
  id: number;
  device: string;
  command: string;
  everyMs: number;
  nextRun: number | null;
  lastRun: number | null;
  lastOk: boolean | null;
  lastNote: string;
}

const REPEATS: [string, number][] = [
  ["once", 0],
  ["every minute", 60_000],
  ["every 5 minutes", 300_000],
  ["every 15 minutes", 900_000],
  ["every hour", 3_600_000],
  ["every day", 86_400_000],
];
const repeatLabel = (ms: number): string =>
  REPEATS.find(([, value]) => value === ms)?.[0] ?? `every ${Math.round(ms / 60_000)} min`;

export function ScheduleDrawer({
  devices,
  draft,
  onClose,
}: {
  devices: string[];
  /** A command to start the form with (from a block's menu). */
  draft: string;
  onClose: () => void;
}): ReactNode {
  const [items, setItems] = useState<Schedule[]>([]);
  const [command, setCommand] = useState(draft);
  const [device, setDevice] = useState(devices[0] ?? "");
  const [everyMs, setEveryMs] = useState(0);
  const [at, setAt] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback((): void => {
    api<{ schedules: Schedule[] }>("/api/terminal/schedules")
      .then((r) => setItems(r.schedules))
      .catch(() => {});
  }, []);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 15_000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => setCommand(draft), [draft]);

  const readable = !command.trim() || isReadCommand(command);
  return (
    <aside className="term-drawer" aria-label="Scheduled commands">
      <header>
        <strong>
          <CalendarClock size={14} /> Scheduled commands
        </strong>
        <button type="button" onClick={onClose} aria-label="Close">
          <X size={14} />
        </button>
      </header>
      <form
        className="term-schedule-form"
        onSubmit={(event) => {
          event.preventDefault();
          setError("");
          void postJson<{ error?: string }>("/api/terminal/schedules", {
            device,
            command,
            everyMs,
            at: at ? new Date(at).getTime() : undefined,
          }).then((answer) => {
            if (answer.error) setError(answer.error);
            else {
              setCommand("");
              refresh();
            }
          });
        }}
      >
        <input
          value={command}
          placeholder="/system resource print"
          spellCheck={false}
          aria-label="Command to schedule"
          onChange={(event) => setCommand(event.target.value)}
        />
        <div>
          <Select
            size="sm"
            className="term-select"
            aria-label="Router"
            value={device}
            onValueChange={setDevice}
            options={devices.map((name) => ({ value: name, label: name }))}
          />
          <Select
            size="sm"
            className="term-select"
            aria-label="Repeat"
            value={String(everyMs)}
            onValueChange={(value) => setEveryMs(Number(value))}
            options={REPEATS.map(([label, value]) => ({ value: String(value), label }))}
          />
        </div>
        <label>
          first run
          <input
            type="datetime-local"
            value={at}
            onChange={(event) => setAt(event.target.value)}
            aria-label="First run (empty: now)"
          />
        </label>
        <button type="submit" disabled={!command.trim() || !readable}>
          Schedule
        </button>
        <p data-bad={!readable || Boolean(error)}>
          {error ||
            (readable
              ? "The server runs it, also with the browser closed. Results go to the history."
              : "Only commands that read (print, export, ping, traceroute) can be scheduled.")}
        </p>
      </form>
      <ol className="term-rows">
        {items.length === 0 && <li className="term-rows-empty">Nothing is scheduled.</li>}
        {items.map((item) => (
          <li key={item.id} data-ok={item.lastOk === null ? undefined : String(item.lastOk)}>
            <code className="term-code">{item.command}</code>
            <div className="term-row-meta">
              <span className="term-row-device">{item.device}</span>
              <span>{repeatLabel(item.everyMs)}</span>
              <span>
                {item.nextRun === null
                  ? "done"
                  : `next ${new Date(item.nextRun).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}`}
              </span>
            </div>
            {item.lastRun !== null && (
              <div className="term-row-meta">
                last {new Date(item.lastRun).toLocaleTimeString()} ·{" "}
                {item.lastOk ? item.lastNote : `failed: ${item.lastNote}`}
              </div>
            )}
            <div className="term-row-actions">
              <button
                type="button"
                title="Delete this schedule"
                onClick={() =>
                  void deleteJson("/api/terminal/schedules", { id: item.id }).then(refresh)
                }
              >
                <Trash2 size={12} /> Delete
              </button>
            </div>
          </li>
        ))}
      </ol>
    </aside>
  );
}
