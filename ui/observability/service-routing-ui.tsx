/**
 * Small form pieces the Service Routing boards share: a select styled as the
 * boards' `.field` or `.select`, and a checkbox row. Both are kit controls.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Checkbox, Select } from "./kit";

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
 * A select drawn by the kit (Kit-Select). By default it is the boards' 36px
 * `.field`; `secondary` gives the 34px `.select` with secondary text. `icon`
 * sits on the left, as on the dialog's "Approved service" select.
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
    <span className={cn("sr-select flex min-w-0", className)}>
      <Select
        value={value}
        onChange={onChange}
        options={options}
        label={label}
        placeholder={placeholder}
        disabled={disabled}
        leading={icon}
        className={cn("min-w-0", mono && "font-mono", secondary && "h-[34px] text-fg-secondary")}
      />
    </span>
  );
}

/** The boards' `.check`: a box and its sentence (Kit-Checkbox). */
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
    <Checkbox
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      className={className}
      label={<span className="flex min-w-0 flex-col">{children}</span>}
    />
  );
}
