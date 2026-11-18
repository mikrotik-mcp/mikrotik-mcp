/**
 * Parts shared by the RADIUS & User Manager page (aaa.tsx, um-reports.tsx):
 * the boards' `.select` and the page's stylesheet.
 */
import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import "./aaa.css";

/**
 * A byte count the way the boards write it: decimal units, three significant
 * digits at most ("1.17 TB", "58 GB", "412 GB", "1.9 GB").
 */
export function compactBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  let v = Math.max(0, n);
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  const digits = i === 0 || v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${Number(v.toFixed(digits))} ${units[i]}`;
}

/**
 * The boards' `.select`: the chosen text with the chevron right after it. A
 * native select sits on top, invisible, so keyboard and screen readers get a
 * real select.
 */
export function AaaSelect({
  value,
  onChange,
  options,
  label,
  disabled,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  label: string;
  disabled?: boolean;
  className?: string;
}): ReactNode {
  const current = options.find((o) => o.value === value)?.label ?? value;
  return (
    <span className={cn("aaa-select", className)} data-disabled={disabled || undefined}>
      <span className="truncate">{current}</span>
      <ChevronDown aria-hidden="true" />
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}
