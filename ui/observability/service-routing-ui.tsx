/**
 * Small form pieces the Service Routing boards share: a 36px select styled as
 * the boards' `.input`, a checkbox row, and the 13px header status line.
 */
import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/** "14:02": the boards write read times as 24-hour hours and minutes. */
export function hhmm(at: number | undefined): string {
  if (at == null || !Number.isFinite(at)) return "—";
  return new Date(at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

/** A native select that looks like the boards' 36px `.input` with a chevron. */
export function FieldSelect({
  value,
  onChange,
  options,
  label,
  placeholder,
  disabled,
  mono = false,
  secondary = false,
  className,
}: {
  /** The boards' `.select` look (secondary text) instead of `.input`. */
  secondary?: boolean;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string; disabled?: boolean }[];
  label: string;
  placeholder?: string;
  disabled?: boolean;
  mono?: boolean;
  className?: string;
}): ReactNode {
  return (
    <span className={cn("relative flex min-w-0", className)}>
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "monitor-input w-full min-w-0 cursor-pointer appearance-none truncate pr-9 disabled:cursor-not-allowed disabled:opacity-50",
          mono && "font-mono text-[12px]",
          secondary && "text-fg-secondary",
        )}
      >
        {placeholder != null && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </span>
  );
}

/** The boards' `.check`: a box and its sentence. */
export function CheckRow({
  checked,
  onChange,
  disabled,
  children,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <label className={cn("monitor-check", disabled && "opacity-50", className)}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="flex min-w-0 flex-col">{children}</span>
    </label>
  );
}

/** The 13px status line under the page title: a bold lead-in, then details. */
export function StatusLine({ lead, rest }: { lead: ReactNode; rest?: ReactNode }): ReactNode {
  return (
    <span className="min-w-0 text-[13px] font-normal text-muted-foreground">
      <b className="font-[510] text-foreground">{lead}</b>
      {rest != null && <> · {rest}</>}
    </span>
  );
}
