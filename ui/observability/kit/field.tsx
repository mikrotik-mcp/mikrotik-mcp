/**
 * Field and inputs (Kit-Inputs): text, search, number stepper, secret and text
 * area. Same 36 px height, 10 px radius and focus ring as the select.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type {
  InputHTMLAttributes,
  KeyboardEvent,
  ReactNode,
  Ref,
  TextareaHTMLAttributes,
} from "react";
import { animate } from "animejs";
import { AlertTriangle, Check, Copy, Eye, EyeOff, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { FieldContext, useField } from "./field-context";
import { Kbd } from "./listbox";
import { reducedMotion, shake } from "./motion";

/* -------------------------------------------------------------------- Field */

export function Field({
  label,
  optional,
  help,
  error,
  children,
  className,
  id: forcedId,
}: {
  label?: ReactNode;
  /** Small grey text after the label: "optional", "RouterOS". */
  optional?: ReactNode;
  help?: ReactNode;
  /** Shown instead of the help, in pink, and marks the control invalid. */
  error?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}): ReactNode {
  const auto = useId().replace(/:/g, "");
  const id = forcedId ?? `${auto}-c`;
  const helpId = `${auto}-h`;
  const ref = useRef<HTMLDivElement>(null);
  const hasNote = error != null && error !== false ? true : help != null;
  // A new error shakes the control and slides the message in.
  const prevError = useRef<ReactNode>(null);
  useEffect(() => {
    const el = ref.current;
    if (error && !prevError.current && el) {
      const control = el.querySelector<HTMLElement>(
        ".kit-input, .kit-trigger, .kit-step, .kit-ta, .kit-tags",
      );
      if (control) shake(control);
      const msg = el.querySelector<HTMLElement>(".kit-help");
      if (msg && !reducedMotion())
        animate(msg, { opacity: [0, 1], translateY: [-4, 0], duration: 180, ease: "outQuart" });
    }
    prevError.current = error ?? null;
  }, [error]);
  return (
    <FieldContext.Provider
      value={{ id, describedBy: hasNote ? helpId : undefined, invalid: Boolean(error) }}
    >
      <div ref={ref} className={cn("kit-field", className)}>
        {label != null && (
          <label className="kit-label" htmlFor={id}>
            {label}
            {optional != null && <span className="opt">{optional}</span>}
          </label>
        )}
        {children}
        {error ? (
          <p id={helpId} className="kit-help" data-error="true" role="alert">
            <AlertTriangle aria-hidden="true" />
            {error}
          </p>
        ) : (
          help != null && (
            <p id={helpId} className="kit-help">
              {help}
            </p>
          )
        )}
      </div>
    </FieldContext.Provider>
  );
}

/* ---------------------------------------------------------------- TextInput */

type NativeInput = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "size" | "prefix"
>;

export interface TextInputProps extends NativeInput {
  value: string;
  onChange: (value: string) => void;
  /** Accessible name when the input has no Field label. */
  label?: string;
  icon?: ReactNode;
  /** Mono tag before the value: "IPv4". */
  prefix?: ReactNode;
  /** Mono tag after the value: "ms". */
  unit?: ReactNode;
  /** Buttons or marks at the end of the field. */
  end?: ReactNode;
  mono?: boolean;
  invalid?: boolean;
  /** Shows a teal check once the value is accepted. */
  valid?: boolean;
  size?: "md" | "sm";
  /** Adds a copy button (read-only values, ids). */
  copyable?: boolean;
  wrapClassName?: string;
  ref?: Ref<HTMLInputElement>;
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }): ReactNode {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1600);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      className="kit-ib"
      aria-label={done ? "Copied" : label}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => setDone(true));
      }}
    >
      {done ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
    </button>
  );
}

export function TextInput({
  value,
  onChange,
  label,
  icon,
  prefix,
  unit,
  end,
  mono,
  invalid,
  valid,
  size = "md",
  copyable,
  disabled,
  readOnly,
  className,
  wrapClassName,
  id,
  type = "text",
  ref,
  ...rest
}: TextInputProps): ReactNode {
  const f = useField();
  const bad = invalid ?? f.invalid;
  return (
    <div
      className={cn("kit-input", wrapClassName)}
      data-size={size}
      data-mono={mono || undefined}
      data-invalid={bad || undefined}
      data-valid={valid || undefined}
      data-disabled={disabled || undefined}
      data-readonly={readOnly || undefined}
    >
      {icon}
      {prefix != null && <span className="kit-prefix">{prefix}</span>}
      <input
        {...rest}
        ref={ref}
        id={id ?? f.id}
        type={type}
        aria-label={f.id && !id ? rest["aria-label"] : (rest["aria-label"] ?? label)}
        aria-describedby={rest["aria-describedby"] ?? f.describedBy}
        aria-invalid={bad || undefined}
        className={className}
        value={value}
        disabled={disabled}
        readOnly={readOnly}
        onChange={(e) => onChange(e.target.value)}
      />
      {unit != null && <span className="kit-unit">{unit}</span>}
      {(end != null || copyable || valid) && (
        <span className="kit-end">
          {valid && !end && <Check aria-hidden="true" />}
          {end}
          {copyable && <CopyButton text={value} />}
        </span>
      )}
    </div>
  );
}

/** Search field with an optional shortcut hint. */
export function SearchInput({
  shortcut,
  ...props
}: Omit<TextInputProps, "icon" | "type"> & { shortcut?: string[] }): ReactNode {
  return (
    <TextInput
      {...props}
      type="search"
      icon={<Search aria-hidden="true" />}
      end={shortcut && !props.value ? shortcut.map((k) => <Kbd key={k}>{k}</Kbd>) : props.end}
    />
  );
}

/* -------------------------------------------------------------- NumberInput */

export interface NumberInputProps {
  value: number | null;
  onChange: (value: number | null) => void;
  label?: string;
  min?: number;
  max?: number;
  step?: number;
  unit?: ReactNode;
  invalid?: boolean;
  disabled?: boolean;
  /** Allow an empty field (null). Default: false, empty snaps back to min or 0. */
  allowEmpty?: boolean;
  placeholder?: string;
  id?: string;
  className?: string;
  "aria-label"?: string;
}

function clamp(n: number, min?: number, max?: number): number {
  return Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
}

/** Replaces type="number": − and + buttons, arrow keys and typing. */
export function NumberInput({
  value,
  onChange,
  label,
  min,
  max,
  step = 1,
  unit,
  invalid,
  disabled,
  allowEmpty = false,
  placeholder,
  id,
  className,
  ...aria
}: NumberInputProps): ReactNode {
  const f = useField();
  const [text, setText] = useState(value == null ? "" : String(value));
  const numRef = useRef<HTMLInputElement>(null);
  const last = useRef(value);
  // Follow outside changes; roll the digits up or down.
  useLayoutEffect(() => {
    if (value === last.current) return;
    const up = (value ?? 0) > (last.current ?? 0);
    last.current = value;
    setText(value == null ? "" : String(value));
    const el = numRef.current;
    if (el && !reducedMotion() && document.activeElement !== el)
      animate(el, {
        translateY: [up ? 8 : -8, 0],
        opacity: [0.3, 1],
        duration: 180,
        ease: "outQuart",
      });
  }, [value]);

  const decimals = (String(step).split(".")[1] ?? "").length;
  const bump = (dir: 1 | -1): void => {
    const next = clamp(Number(((value ?? min ?? 0) + dir * step).toFixed(decimals)), min, max);
    if (next !== value) onChange(next);
  };
  const commit = (): void => {
    if (text.trim() === "") {
      if (allowEmpty) onChange(null);
      else setText(value == null ? "" : String(value));
      return;
    }
    const n = Number(text);
    if (Number.isFinite(n)) {
      const c = clamp(n, min, max);
      if (c !== value) onChange(c);
      setText(String(c));
    } else setText(value == null ? "" : String(value));
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "ArrowUp") bump(1);
    else if (e.key === "ArrowDown") bump(-1);
    else if (e.key === "Enter") commit();
    else return;
    e.preventDefault();
  };
  const name = aria["aria-label"] ?? label;
  return (
    <div
      className={cn("kit-step", className)}
      data-invalid={invalid || f.invalid || undefined}
      data-disabled={disabled || undefined}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label={`Decrease${name ? ` ${name}` : ""}`}
        disabled={disabled || (min != null && value != null && value <= min)}
        onClick={() => bump(-1)}
      >
        −
      </button>
      <span className="v">
        <input
          ref={numRef}
          id={id ?? f.id}
          type="text"
          inputMode="decimal"
          role="spinbutton"
          aria-label={f.id && !id ? undefined : name}
          aria-describedby={f.describedBy}
          aria-valuenow={value ?? undefined}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-invalid={invalid || f.invalid || undefined}
          disabled={disabled}
          placeholder={placeholder}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const n = Number(e.target.value);
            if (e.target.value.trim() !== "" && Number.isFinite(n) && clamp(n, min, max) === n) {
              last.current = n;
              onChange(n);
            }
          }}
          onBlur={commit}
          onKeyDown={onKey}
        />
        {unit != null && <small>{unit}</small>}
      </span>
      <button
        type="button"
        tabIndex={-1}
        aria-label={`Increase${name ? ` ${name}` : ""}`}
        disabled={disabled || (max != null && value != null && value >= max)}
        onClick={() => bump(1)}
      >
        +
      </button>
    </div>
  );
}

/* -------------------------------------------------------------- SecretInput */

function strength(s: string): number {
  if (!s) return 0;
  let n = 0;
  if (s.length >= 8) n++;
  if (s.length >= 14) n++;
  if (/[a-z]/.test(s) && /[A-Z]/.test(s)) n++;
  if (/\d/.test(s) && /[^A-Za-z0-9]/.test(s)) n++;
  return Math.max(1, n);
}

/** Password, key or token: hidden by default, with show and copy. */
export function SecretInput({
  showStrength = false,
  copyable = false,
  ...props
}: Omit<TextInputProps, "type" | "end" | "copyable"> & {
  showStrength?: boolean;
  copyable?: boolean;
}): ReactNode {
  const [shown, setShown] = useState(false);
  const n = strength(props.value);
  return (
    <>
      <TextInput
        {...props}
        type={shown ? "text" : "password"}
        mono
        autoComplete={props.autoComplete ?? "off"}
        end={
          <>
            <button
              type="button"
              className="kit-ib"
              aria-label={shown ? "Hide" : "Show"}
              aria-pressed={shown}
              onClick={() => setShown((s) => !s)}
            >
              {shown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
            </button>
            {copyable && props.value && <CopyButton text={props.value} />}
          </>
        }
      />
      {showStrength && props.value && (
        <div className="kit-meter" aria-label={`Strength ${n} of 4`} role="img">
          {[1, 2, 3, 4].map((i) => (
            <i key={i} data-on={i <= n} />
          ))}
        </div>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- TextArea */

export function TextArea({
  value,
  onChange,
  label,
  mono = false,
  maxLength,
  showCount = maxLength != null,
  showPosition = false,
  actions,
  invalid,
  className,
  id,
  rows = 4,
  ref,
  ...rest
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & {
  ref?: Ref<HTMLTextAreaElement>;
  value: string;
  onChange: (value: string) => void;
  label?: string;
  mono?: boolean;
  showCount?: boolean;
  /** Line and column of the cursor (scripts). */
  showPosition?: boolean;
  /** Buttons in the footer bar, e.g. "Check syntax". */
  actions?: ReactNode;
  invalid?: boolean;
}): ReactNode {
  const f = useField();
  const [pos, setPos] = useState({ ln: 1, col: 1 });
  const track = (el: HTMLTextAreaElement): void => {
    const before = el.value.slice(0, el.selectionStart);
    const lines = before.split("\n");
    setPos({ ln: lines.length, col: (lines.at(-1)?.length ?? 0) + 1 });
  };
  const bar = showCount || showPosition || actions != null;
  return (
    <div
      className={cn("kit-ta", className)}
      data-mono={mono || undefined}
      data-invalid={invalid || f.invalid || undefined}
    >
      <textarea
        {...rest}
        ref={ref}
        id={id ?? f.id}
        rows={rows}
        aria-label={f.id && !id ? rest["aria-label"] : (rest["aria-label"] ?? label)}
        aria-describedby={rest["aria-describedby"] ?? f.describedBy}
        aria-invalid={invalid || f.invalid || undefined}
        value={value}
        maxLength={maxLength}
        spellCheck={mono ? false : rest.spellCheck}
        onChange={(e) => {
          onChange(e.target.value);
          if (showPosition) track(e.target);
        }}
        onKeyUp={showPosition ? (e) => track(e.currentTarget) : rest.onKeyUp}
        onClick={showPosition ? (e) => track(e.currentTarget) : rest.onClick}
      />
      {bar && (
        <div className="kit-ta-bar">
          {showPosition && (
            <span>
              Ln {pos.ln}, Col {pos.col}
            </span>
          )}
          <span className="sp" />
          {showCount && (
            <span data-over={maxLength != null && value.length >= maxLength}>
              {value.length.toLocaleString("en-US")}
              {maxLength != null && ` / ${maxLength.toLocaleString("en-US")}`}
            </span>
          )}
          {actions}
        </div>
      )}
    </div>
  );
}
