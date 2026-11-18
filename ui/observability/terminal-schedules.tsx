/**
 * Scheduled commands: a read command that the server runs at a time or on a
 * repeat, also when no browser is open. Results go to the command history.
 * Only reads can be scheduled; the server refuses anything else.
 */
import { CalendarDays, Trash2, X } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { useCallback, useEffect, useState } from "react";
import { api, deleteJson, postJson } from "./api";
import { DateTimePicker, Field, Select, TextInput } from "./kit";
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
  onCount,
  ref,
}: {
  devices: string[];
  /** A command to start the form with (from a block's menu). */
  draft: string;
  onClose: () => void;
  /** Told the number of schedules after each refresh, for the toolbar count. */
  onCount?: (count: number) => void;
  ref?: Ref<HTMLElement>;
}): ReactNode {
  const [items, setItems] = useState<Schedule[]>([]);
  const [command, setCommand] = useState(draft);
  const [device, setDevice] = useState(devices[0] ?? "");
  const [everyMs, setEveryMs] = useState(0);
  const [at, setAt] = useState<Date | undefined>(undefined);
  const [error, setError] = useState("");

  const refresh = useCallback((): void => {
    api<{ schedules: Schedule[] }>("/api/terminal/schedules")
      .then((r) => {
        setItems(r.schedules);
        onCount?.(r.schedules.length);
      })
      .catch(() => {});
  }, [onCount]);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 15_000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => setCommand(draft), [draft]);

  const readable = !command.trim() || isReadCommand(command);
  return (
    <aside ref={ref} className="term-dw" aria-label="Scheduled commands">
      <div className="term-dw-hd">
        <div className="term-dw-title">
          <CalendarDays size={16} />
          <b>Scheduled</b>
          <span className="sp" />
          <button type="button" className="term-ib" onClick={onClose} aria-label="Close">
            <X size={15} />
          </button>
        </div>
        <form
          className="term-dw-form"
          onSubmit={(event) => {
            event.preventDefault();
            setError("");
            void postJson<{ error?: string }>("/api/terminal/schedules", {
              device,
              command,
              everyMs,
              at: at ? at.getTime() : undefined,
            }).then((answer) => {
              if (answer.error) setError(answer.error);
              else {
                setCommand("");
                refresh();
              }
            });
          }}
        >
          <TextInput
            mono
            value={command}
            placeholder="/system resource print"
            spellCheck={false}
            label="Command to schedule"
            invalid={!readable}
            onChange={setCommand}
          />
          <div className="term-dw-filters">
            <Select
              size="sm"
              label="Router"
              value={device}
              onChange={setDevice}
              options={devices.map((name) => ({ value: name, label: name }))}
            />
            <Select
              size="sm"
              label="Repeat"
              value={String(everyMs)}
              onChange={(value) => setEveryMs(Number(value))}
              options={REPEATS.map(([label, value]) => ({ value: String(value), label }))}
            />
          </div>
          <Field label="First run">
            <DateTimePicker
              value={at}
              onChange={setAt}
              label="First run (empty: now)"
              placeholder="now"
            />
          </Field>
          <div className="term-dw-submit">
            <p data-bad={!readable || Boolean(error) || undefined}>
              {error ||
                (readable
                  ? "The server runs it, also with the browser closed. Results go to the history."
                  : "Only commands that read (print, export, ping, traceroute) can be scheduled.")}
            </p>
            <button
              type="submit"
              className="term-act"
              data-tone="go"
              disabled={!command.trim() || !readable}
            >
              Schedule
            </button>
          </div>
        </form>
      </div>
      <ol className="term-dw-rows">
        {items.length === 0 && <li className="term-dw-empty">Nothing is scheduled.</li>}
        {items.map((item) => (
          <li
            key={item.id}
            className="term-hrow"
            data-ok={item.lastOk === null ? undefined : String(item.lastOk)}
          >
            <div className="term-hrow-main">
              <code className="term-code">{item.command}</code>
              <span className="m">
                {item.device} · {repeatLabel(item.everyMs)} ·{" "}
                {item.nextRun === null
                  ? "done"
                  : `next ${new Date(item.nextRun).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}`}
              </span>
              {item.lastRun !== null && (
                <span className="m" data-bad={!item.lastOk || undefined}>
                  last {new Date(item.lastRun).toLocaleTimeString()} ·{" "}
                  {item.lastOk ? item.lastNote : `failed: ${item.lastNote}`}
                </span>
              )}
            </div>
            <span className="a">
              <button
                type="button"
                className="term-ib"
                title="Delete this schedule"
                aria-label="Delete this schedule"
                onClick={() =>
                  void deleteJson("/api/terminal/schedules", { id: item.id }).then(refresh)
                }
              >
                <Trash2 size={13} />
              </button>
            </span>
          </li>
        ))}
      </ol>
    </aside>
  );
}
