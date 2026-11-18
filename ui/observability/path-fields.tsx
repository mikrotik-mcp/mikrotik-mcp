/**
 * Form pieces the Tunnel Bandwidth and Round-trip boards share: a labelled
 * field (the boards' `.fl`), a full-width select (`.select`) and a checkbox
 * row (`.check`), both kit controls. Styles live in path-fields.css.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Checkbox, Select } from "./kit";
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

/** The boards' `.select`, drawn by the kit (Kit-Select), filling its cell. */
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
  // A saved value the router no longer offers still shows, greyed.
  const all =
    !known && value !== "" ? [{ value, label: value, disabled: true }, ...options] : options;
  return (
    <Select
      value={value}
      onChange={onChange}
      options={all}
      label={label}
      placeholder={placeholder ?? "Select…"}
      disabled={disabled}
      className={cn("pf-select", mono && "pf-mono")}
    />
  );
}

/** The boards' `.check`: a box and its sentence (Kit-Checkbox). */
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
  const text = <span className="min-w-0 text-foreground">{children}</span>;
  if (label == null)
    return (
      <Checkbox
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        className={cn("pf-check", className)}
        label={text}
      />
    );
  // The kit drops aria-label when it draws its own label, so the box keeps the
  // name here and a plain label makes the sentence clickable.
  return (
    <label className={cn("kit-check pf-check", className)} data-disabled={disabled || undefined}>
      <Checkbox
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        aria-label={label}
      />
      {text}
    </label>
  );
}
