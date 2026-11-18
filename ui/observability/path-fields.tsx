/**
 * Form pieces the Tunnel Bandwidth and Round-trip boards share: a labelled
 * field (the boards' `.fl`), a full-width 34px select (`.select`) and a
 * checkbox row (`.check`). Styles live in path-fields.css.
 */
import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import "./path-fields.css";

/** A label above its control, with an optional hint below. */
export function FormField({
  label,
  hint,
  children,
  className,
  group = false,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
  /** A div instead of a label, for button groups that name themselves. */
  group?: boolean;
}): ReactNode {
  const Tag = group ? "div" : "label";
  return (
    <Tag className={cn("monitor-fl", className)}>
      <span className="monitor-label">{label}</span>
      {children}
      {hint != null && <span className="monitor-hint">{hint}</span>}
    </Tag>
  );
}

/** A native select drawn as the boards' `.select`, filling its cell. */
export function FormSelect({
  value,
  onChange,
  options,
  label,
  placeholder,
  disabled,
  mono = false,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string; disabled?: boolean }[];
  label: string;
  /** Shown while nothing is chosen. */
  placeholder?: string;
  disabled?: boolean;
  mono?: boolean;
}): ReactNode {
  const known = options.some((o) => o.value === value);
  return (
    <span className="monitor-select pf-select" data-mono={mono || undefined}>
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="" disabled>
          {placeholder ?? "Select…"}
        </option>
        {/* A saved value the router no longer offers still shows, greyed. */}
        {!known && value !== "" && (
          <option value={value} disabled>
            {value}
          </option>
        )}
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown aria-hidden="true" />
    </span>
  );
}

/** The boards' `.check`: a box and its sentence. */
export function FormCheck({
  checked,
  onChange,
  disabled,
  label,
  children,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Accessible name when the visible text differs. */
  label?: string;
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <label className={cn("monitor-check pf-check", className)}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="min-w-0 text-foreground">{children}</span>
    </label>
  );
}
