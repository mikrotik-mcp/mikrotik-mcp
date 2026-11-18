/**
 * Date and time (Kit-Overlays 01): replaces the native date, time and
 * datetime-local inputs. A single date with an optional time, or a range with
 * quick presets.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import {
  addDays,
  addMonths,
  endOfMonth,
  format,
  isAfter,
  isBefore,
  isSameDay,
  isSameMonth,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { Calendar, ChevronDown, ChevronLeft, ChevronRight, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { Floating, useIsPhone } from "./floating";
import { useField } from "./field-context";

const WEEK = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

function MonthGrid({
  month,
  onMonth,
  isDisabled,
  rangeOf,
  onPick,
  onHover,
  focusDay,
  setFocusDay,
}: {
  month: Date;
  onMonth: (m: Date) => void;
  isDisabled: (d: Date) => boolean;
  rangeOf: (d: Date) => "start" | "end" | "mid" | "one" | undefined;
  onPick: (d: Date) => void;
  onHover?: (d: Date | null) => void;
  focusDay: Date;
  setFocusDay: (d: Date) => void;
}): ReactNode {
  const grid = useRef<HTMLDivElement>(null);
  const days = useMemo(() => {
    const first = startOfWeek(startOfMonth(month), { weekStartsOn: 1 });
    const last = endOfMonth(month);
    const out: Date[] = [];
    for (
      let d = first;
      out.length < 42 && (out.length % 7 !== 0 || !isAfter(d, last));
      d = addDays(d, 1)
    )
      out.push(d);
    return out;
  }, [month]);
  useEffect(() => {
    grid.current
      ?.querySelector<HTMLButtonElement>(`[data-day="${format(focusDay, "yyyy-MM-dd")}"]`)
      ?.focus({ preventScroll: true });
  }, [focusDay]);
  const move = (n: number): void => {
    const d = addDays(focusDay, n);
    if (!isSameMonth(d, month)) onMonth(startOfMonth(d));
    setFocusDay(d);
  };
  const onKey = (e: KeyboardEvent): void => {
    const map: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (e.key in map) {
      move(map[e.key]!);
      e.preventDefault();
    } else if (e.key === "PageUp" || e.key === "PageDown") {
      const d = addMonths(focusDay, e.key === "PageUp" ? -1 : 1);
      onMonth(startOfMonth(d));
      setFocusDay(d);
      e.preventDefault();
    }
  };
  const today = new Date();
  return (
    <div>
      <div className="kit-cal-hd">
        <span aria-live="polite">{format(month, "MMMM yyyy")}</span>
        <span className="nv">
          <button
            type="button"
            className="kit-ib"
            aria-label="Previous month"
            onClick={() => onMonth(addMonths(month, -1))}
          >
            <ChevronLeft aria-hidden="true" />
          </button>
          <button
            type="button"
            className="kit-ib"
            aria-label="Next month"
            onClick={() => onMonth(addMonths(month, 1))}
          >
            <ChevronRight aria-hidden="true" />
          </button>
        </span>
      </div>
      <div
        ref={grid}
        className="kit-cal"
        role="grid"
        aria-label={format(month, "MMMM yyyy")}
        onKeyDown={onKey}
        onPointerLeave={() => onHover?.(null)}
      >
        {WEEK.map((w) => (
          <span key={w} className="h" role="columnheader">
            {w}
          </span>
        ))}
        {days.map((d) => (
          <button
            key={d.toISOString()}
            type="button"
            role="gridcell"
            data-day={format(d, "yyyy-MM-dd")}
            tabIndex={isSameDay(d, focusDay) ? 0 : -1}
            data-out={!isSameMonth(d, month) || undefined}
            data-today={isSameDay(d, today) || undefined}
            data-range={rangeOf(d)}
            aria-selected={rangeOf(d) != null}
            aria-label={format(d, "EEEE, MMMM d, yyyy")}
            disabled={isDisabled(d)}
            onClick={() => onPick(d)}
            onPointerEnter={() => onHover?.(d)}
          >
            {format(d, "d")}
          </button>
        ))}
      </div>
    </div>
  );
}

function TimeBox({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
}): ReactNode {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      aria-label={label}
      inputMode="numeric"
      value={text}
      maxLength={5}
      onChange={(e) => setText(e.target.value.replace(/[^\d:]/g, ""))}
      onBlur={() => {
        const m = /^(\d{1,2}):?(\d{2})$/.exec(text.trim());
        if (m && Number(m[1]) < 24 && Number(m[2]) < 60)
          onChange(`${m[1]!.padStart(2, "0")}:${m[2]}`);
        else setText(value);
      }}
    />
  );
}

function withTime(d: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const out = new Date(d);
  out.setHours(h ?? 0, m ?? 0, 0, 0);
  return out;
}

function Trigger({
  open,
  text,
  placeholder,
  icon,
  disabled,
  id,
  label,
  className,
  onClick,
}: {
  open: boolean;
  text: string;
  placeholder: string;
  icon: ReactNode;
  disabled?: boolean;
  id?: string;
  label: string;
  className?: string;
  onClick: () => void;
}): ReactNode {
  const f = useField();
  return (
    <button
      type="button"
      id={id ?? f.id}
      className={cn("kit-trigger", className)}
      data-open={open}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={f.id && !id ? undefined : label}
      aria-describedby={f.describedBy}
      aria-invalid={f.invalid || undefined}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="lead" aria-hidden="true">
        {icon}
      </span>
      <span className={cn("v", !text && "ph")}>{text || placeholder}</span>
      <span className="kit-chev" aria-hidden="true">
        <ChevronDown />
      </span>
    </button>
  );
}

/* ----------------------------------------------------------- DateTimePicker */

export function DateTimePicker({
  value,
  onChange,
  label = "Date and time",
  showTime = true,
  min,
  max,
  disabled,
  placeholder = "Pick a date",
  id,
  className,
}: {
  value?: Date;
  onChange: (value: Date | undefined) => void;
  label?: string;
  showTime?: boolean;
  min?: Date;
  max?: Date;
  disabled?: boolean;
  placeholder?: string;
  id?: string;
  className?: string;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(startOfMonth(value ?? new Date()));
  const [focusDay, setFocusDay] = useState(value ?? new Date());
  const phone = useIsPhone(open);
  useEffect(() => {
    if (open) {
      setMonth(startOfMonth(value ?? new Date()));
      setFocusDay(value ?? new Date());
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps -- reset when opened
  const time = value ? format(value, "HH:mm") : "00:00";
  const isDisabled = (d: Date): boolean =>
    (min != null && isBefore(d, startOfDay(min))) || (max != null && isAfter(startOfDay(d), max));
  const text = value ? format(value, showTime ? "MMM d, yyyy · HH:mm" : "MMM d, yyyy") : "";
  return (
    <Floating
      open={open}
      onOpenChange={setOpen}
      title={label}
      phone={phone}
      className="kit-pop"
      animate
      anchor={
        <Trigger
          open={open}
          text={text}
          placeholder={placeholder}
          icon={showTime ? <Clock /> : <Calendar />}
          disabled={disabled}
          id={id}
          label={label}
          className={className}
          onClick={() => setOpen((o) => !o)}
        />
      }
    >
      <MonthGrid
        month={month}
        onMonth={setMonth}
        isDisabled={isDisabled}
        rangeOf={(d) => (value && isSameDay(d, value) ? "one" : undefined)}
        onPick={(d) => {
          onChange(withTime(d, time));
          if (!showTime) setOpen(false);
        }}
        focusDay={focusDay}
        setFocusDay={setFocusDay}
      />
      {!showTime && value && (
        <div className="kit-time">
          <span className="sp" />
          <button
            type="button"
            className="kit-btn"
            onClick={() => {
              onChange(undefined);
              setOpen(false);
            }}
          >
            Clear
          </button>
        </div>
      )}
      {showTime && (
        <div className="kit-time">
          <span className="kit-help">Time</span>
          <TimeBox
            value={time}
            label="Time"
            onChange={(t) => onChange(withTime(value ?? new Date(), t))}
          />
          <span className="sp" />
          {value && (
            <button
              type="button"
              className="kit-btn"
              onClick={() => {
                onChange(undefined);
                setOpen(false);
              }}
            >
              Clear
            </button>
          )}
          <button
            type="button"
            className="kit-btn"
            data-variant="primary"
            onClick={() => setOpen(false)}
          >
            Done
          </button>
        </div>
      )}
    </Floating>
  );
}

/* ---------------------------------------------------------- DateRangePicker */

export interface DateRange {
  from: Date;
  to: Date;
}

export interface RangePreset {
  label: string;
  range: () => DateRange;
}

export const DEFAULT_PRESETS: readonly RangePreset[] = [
  { label: "Last hour", range: () => ({ from: new Date(Date.now() - 3_600_000), to: new Date() }) },
  {
    label: "Last 24 hours",
    range: () => ({ from: new Date(Date.now() - 86_400_000), to: new Date() }),
  },
  {
    label: "Last 7 days",
    range: () => ({ from: startOfDay(addDays(new Date(), -6)), to: new Date() }),
  },
  { label: "This month", range: () => ({ from: startOfMonth(new Date()), to: new Date() }) },
];

export function DateRangePicker({
  value,
  onChange,
  label = "Time range",
  presets = DEFAULT_PRESETS,
  max = new Date(),
  disabled,
  id,
  className,
}: {
  value: DateRange | null;
  onChange: (value: DateRange) => void;
  label?: string;
  presets?: readonly RangePreset[];
  max?: Date;
  disabled?: boolean;
  id?: string;
  className?: string;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<{ from: Date | null; to: Date | null }>({
    from: null,
    to: null,
  });
  const [hover, setHover] = useState<Date | null>(null);
  const [times, setTimes] = useState({ from: "00:00", to: "23:59" });
  const [month, setMonth] = useState(startOfMonth(value?.to ?? new Date()));
  const [focusDay, setFocusDay] = useState(value?.to ?? new Date());
  const [preset, setPreset] = useState<string | null>(null);
  const phone = useIsPhone(open);
  useEffect(() => {
    if (!open) return;
    setDraft({ from: value?.from ?? null, to: value?.to ?? null });
    setTimes({
      from: value ? format(value.from, "HH:mm") : "00:00",
      to: value ? format(value.to, "HH:mm") : "23:59",
    });
    setMonth(startOfMonth(value?.to ?? new Date()));
    setFocusDay(value?.to ?? new Date());
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps -- reset when opened

  const end = draft.to ?? (draft.from && hover && !isBefore(hover, draft.from) ? hover : null);
  const rangeOf = (d: Date): "start" | "end" | "mid" | "one" | undefined => {
    const a = draft.from;
    if (!a) return undefined;
    if (!end || isSameDay(a, end)) return isSameDay(d, a) ? "one" : undefined;
    if (isSameDay(d, a)) return "start";
    if (isSameDay(d, end)) return "end";
    return isAfter(d, a) && isBefore(d, end) ? "mid" : undefined;
  };
  const pickDay = (d: Date): void => {
    setPreset(null);
    if (!draft.from || draft.to || isBefore(d, draft.from)) setDraft({ from: d, to: null });
    else setDraft({ from: draft.from, to: d });
  };
  const apply = (): void => {
    if (!draft.from) return;
    onChange({
      from: withTime(draft.from, times.from),
      to: withTime(draft.to ?? draft.from, times.to),
    });
    setOpen(false);
  };
  const text = value
    ? isSameDay(value.from, value.to)
      ? `${format(value.from, "MMM d, yyyy · HH:mm")} – ${format(value.to, "HH:mm")}`
      : `${format(value.from, "MMM d")} – ${format(value.to, "MMM d, yyyy")}`
    : "";
  return (
    <Floating
      open={open}
      onOpenChange={setOpen}
      title={label}
      phone={phone}
      className="kit-pop"
      animate
      anchor={
        <Trigger
          open={open}
          text={text}
          placeholder="Choose a range"
          icon={<Calendar />}
          disabled={disabled}
          id={id}
          label={label}
          className={className}
          onClick={() => setOpen((o) => !o)}
        />
      }
    >
      <div className={cn("kit-dt", phone && "flex-col gap-3")}>
        <div className="kit-presets" role="group" aria-label="Quick ranges">
          <span className="cap">Quick</span>
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              data-on={preset === p.label}
              onClick={() => {
                setPreset(p.label);
                onChange(p.range());
                setOpen(false);
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div>
          <MonthGrid
            month={month}
            onMonth={setMonth}
            isDisabled={(d) => isAfter(startOfDay(d), max)}
            rangeOf={rangeOf}
            onPick={pickDay}
            onHover={setHover}
            focusDay={focusDay}
            setFocusDay={setFocusDay}
          />
          <div className="kit-time">
            <span className="kit-help">From</span>
            <TimeBox
              value={times.from}
              label="From time"
              onChange={(t) => setTimes((s) => ({ ...s, from: t }))}
            />
            <span className="kit-help">to</span>
            <TimeBox
              value={times.to}
              label="To time"
              onChange={(t) => setTimes((s) => ({ ...s, to: t }))}
            />
            <span className="sp" />
            <button
              type="button"
              className="kit-btn"
              data-variant="primary"
              disabled={!draft.from}
              onClick={apply}
            >
              Apply
            </button>
          </div>
        </div>
      </div>
    </Floating>
  );
}
