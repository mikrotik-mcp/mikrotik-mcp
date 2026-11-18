/**
 * Small form pieces the Service Routing boards share: a select styled as the
 * boards' `.field` or `.select`, and a checkbox row.
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

/**
 * A native select with a chevron. By default it is the boards' 36px `.field`;
 * `secondary` gives the 34px `.select` with secondary text. `icon` sits on the
 * left, as on the dialog's "Approved service" select.
 */
export function FieldSelect({
  value,
  onChange,
  options,
  label,
  placeholder,
  disabled,
  mono = false,
  secondary = false,
  icon,
  className,
}: {
  secondary?: boolean;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string; disabled?: boolean }[];
  label: string;
  placeholder?: string;
  disabled?: boolean;
  mono?: boolean;
  icon?: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <span className={cn("sr-select relative flex min-w-0", className)}>
      {icon != null && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-3 flex -translate-y-1/2 text-muted-foreground [&_svg]:size-4"
        >
          {icon}
        </span>
      )}
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "monitor-input w-full min-w-0 cursor-pointer appearance-none truncate pr-9 disabled:cursor-not-allowed disabled:opacity-50",
          mono && "font-mono",
          secondary && "h-[34px] text-fg-secondary",
          icon != null && "pl-9",
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
    <label className={cn("monitor-check", disabled && "opacity-55", className)}>
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
