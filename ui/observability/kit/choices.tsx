/**
 * Choices (Kit-Choices): checkbox, switch, radio cards, segmented control and
 * slider. Built on Radix for keyboard and screen reader behaviour.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { animate } from "animejs";
import {
  Checkbox as CheckboxPrimitive,
  RadioGroup as RadioPrimitive,
  Slider as SliderPrimitive,
  Switch as SwitchPrimitive,
  ToggleGroup as TogglePrimitive,
} from "radix-ui";
import { cn } from "@/lib/utils";
import { drawCheck, reducedMotion } from "./motion";

/* ----------------------------------------------------------------- Checkbox */

export function Checkbox({
  checked,
  onCheckedChange,
  label,
  description,
  tone,
  disabled,
  id,
  className,
  "aria-label": ariaLabel,
}: {
  checked: boolean | "indeterminate";
  onCheckedChange: (checked: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  /** "warn": amber, for a confirmation that allows a write. */
  tone?: "warn";
  disabled?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
}): ReactNode {
  const auto = useId();
  const cid = id ?? auto;
  const path = useRef<SVGPathElement>(null);
  const was = useRef(checked);
  useEffect(() => {
    if (checked === true && was.current !== true) drawCheck(path.current);
    was.current = checked;
  }, [checked]);
  const box = (
    <CheckboxPrimitive.Root
      id={cid}
      className="kit-box"
      data-tone={tone}
      checked={checked}
      disabled={disabled}
      aria-label={label == null ? ariaLabel : undefined}
      onCheckedChange={(c) => onCheckedChange(c === true)}
    >
      <CheckboxPrimitive.Indicator forceMount className="contents">
        {checked === "indeterminate" ? (
          <span className="mix" />
        ) : checked ? (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path ref={path} d="M5 12.5 10 17 19 7" />
          </svg>
        ) : null}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
  if (label == null) return box;
  return (
    <label
      htmlFor={cid}
      className={cn("kit-check", className)}
      data-tone={tone}
      data-disabled={disabled || undefined}
    >
      {box}
      <span>
        {label}
        {description != null && <small>{description}</small>}
      </span>
    </label>
  );
}

/* ------------------------------------------------------------------- Switch */

export function Switch({
  checked,
  onCheckedChange,
  label,
  busy = false,
  disabled,
  id,
  className,
  "aria-label": ariaLabel,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label?: ReactNode;
  /** While a change saves: a spinner, and it cannot be pressed again. */
  busy?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
}): ReactNode {
  const auto = useId();
  const sid = id ?? auto;
  const track = (
    <SwitchPrimitive.Root
      id={sid}
      className="kit-track"
      checked={checked}
      disabled={disabled || busy}
      data-busy={busy || undefined}
      aria-busy={busy || undefined}
      aria-label={label == null ? ariaLabel : undefined}
      onCheckedChange={onCheckedChange}
    >
      <SwitchPrimitive.Thumb className="kit-thumb">
        {busy && <span className="kit-spin" aria-hidden="true" />}
      </SwitchPrimitive.Thumb>
    </SwitchPrimitive.Root>
  );
  if (label == null) return track;
  return (
    <label
      htmlFor={sid}
      className={cn("kit-switch", className)}
      data-disabled={disabled || undefined}
    >
      {track}
      <span>{label}</span>
    </label>
  );
}

/* --------------------------------------------------------------- RadioCards */

export interface RadioCardOption<V extends string> {
  value: V;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  /** "warn" for an option that writes to a router. */
  tone?: "warn";
  disabled?: boolean;
}

export function RadioCards<V extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: V;
  onChange: (value: V) => void;
  options: readonly RadioCardOption<V>[];
  label: string;
  className?: string;
}): ReactNode {
  return (
    <RadioPrimitive.Root
      className={cn("kit-cards", className)}
      value={value}
      onValueChange={(v) => onChange(v as V)}
      aria-label={label}
    >
      {options.map((o) => (
        <RadioPrimitive.Item
          key={o.value}
          value={o.value}
          disabled={o.disabled}
          className="kit-card"
          data-tone={o.tone}
        >
          {o.icon != null && (
            <span className="ic" aria-hidden="true">
              {o.icon}
            </span>
          )}
          <b>{o.title}</b>
          {o.description != null && <span>{o.description}</span>}
          <span className="rd" aria-hidden="true" />
        </RadioPrimitive.Item>
      ))}
    </RadioPrimitive.Root>
  );
}

/* ---------------------------------------------------------------- Segmented */

export interface SegmentOption<V extends string> {
  value: V;
  label: ReactNode;
  count?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

/** Replaces rows of tab-like buttons. The pill slides under the chosen option. */
export function Segmented<V extends string>({
  value,
  onChange,
  options,
  label,
  size = "md",
  className,
}: {
  value: V;
  onChange: (value: V) => void;
  options: readonly SegmentOption<V>[];
  label: string;
  size?: "md" | "sm";
  className?: string;
}): ReactNode {
  const root = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLSpanElement>(null);
  const placed = useRef(false);
  useLayoutEffect(() => {
    const el = root.current?.querySelector<HTMLElement>('[data-state="on"]');
    const p = pill.current;
    if (!p) return;
    if (!el) {
      p.style.opacity = "0";
      return;
    }
    const to = { translateX: el.offsetLeft, width: el.offsetWidth };
    if (!placed.current || reducedMotion()) {
      p.style.transform = `translateX(${to.translateX}px)`;
      p.style.width = `${to.width}px`;
      p.style.opacity = "1";
      placed.current = true;
      return;
    }
    p.style.opacity = "1";
    animate(p, { ...to, duration: 260, ease: "outBack(1.2)" });
  }, [value, options]);
  // Labels change width when fonts load or counts change.
  useEffect(() => {
    const r = root.current;
    if (!r || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const el = r.querySelector<HTMLElement>('[data-state="on"]');
      if (el && pill.current) {
        pill.current.style.transform = `translateX(${el.offsetLeft}px)`;
        pill.current.style.width = `${el.offsetWidth}px`;
      }
    });
    ro.observe(r);
    return () => ro.disconnect();
  }, []);
  return (
    <TogglePrimitive.Root
      ref={root}
      type="single"
      value={value}
      onValueChange={(v) => {
        if (v) onChange(v as V);
      }}
      aria-label={label}
      data-size={size}
      className={cn("kit-seg", className)}
    >
      <span ref={pill} className="kit-seg-pill" aria-hidden="true" />
      {options.map((o) => (
        <TogglePrimitive.Item key={o.value} value={o.value} disabled={o.disabled}>
          {o.icon}
          {o.label}
          {o.count != null && <span className="c">{o.count}</span>}
        </TogglePrimitive.Item>
      ))}
    </TogglePrimitive.Root>
  );
}

/* ------------------------------------------------------------------- Slider */

export function Slider({
  value,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  label,
  showLabel = true,
  format = (n) => String(n),
  marks,
  disabled,
  className,
}: {
  /** One number, or two for a range. */
  value: number | [number, number];
  onChange: (value: number | [number, number]) => void;
  min?: number;
  max?: number;
  step?: number;
  label: string;
  showLabel?: boolean;
  format?: (n: number) => string;
  /** Labels under the track, spread evenly: ["0", "50", "100%"]. */
  marks?: readonly ReactNode[];
  disabled?: boolean;
  className?: string;
}): ReactNode {
  const values = Array.isArray(value) ? value : [value];
  const [bubble, setBubble] = useState(false);
  useEffect(() => {
    if (!bubble) return;
    const t = setTimeout(() => setBubble(false), 900);
    return () => clearTimeout(t);
  }, [bubble, value]);
  const shown =
    values.length === 2 ? `${format(values[0]!)} to ${format(values[1]!)}` : format(values[0]!);
  return (
    <div className={cn("kit-slider", className)}>
      {showLabel && (
        <div className="kit-slider-hd">
          <span>{label}</span>
          <b>{shown}</b>
        </div>
      )}
      <SliderPrimitive.Root
        className="kit-slider-root"
        value={values}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        data-bubble={bubble || undefined}
        onKeyDown={() => setBubble(true)}
        onValueChange={(v) => onChange(values.length === 2 ? [v[0]!, v[1]!] : v[0]!)}
      >
        <SliderPrimitive.Track className="kit-slider-track">
          <SliderPrimitive.Range className="kit-slider-range" />
        </SliderPrimitive.Track>
        {values.map((v, i) => (
          <SliderPrimitive.Thumb
            key={i}
            className="kit-slider-thumb"
            aria-label={values.length === 2 ? `${label} ${i === 0 ? "from" : "to"}` : label}
          >
            {values.length === 1 && <span className="kit-bubble">{format(v)}</span>}
          </SliderPrimitive.Thumb>
        ))}
      </SliderPrimitive.Root>
      {marks && (
        <div className="kit-marks" aria-hidden="true">
          {marks.map((m, i) => (
            <span key={i}>{m}</span>
          ))}
        </div>
      )}
    </div>
  );
}
