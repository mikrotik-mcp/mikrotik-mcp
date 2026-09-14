/**
 * Small UI atoms, built on the shadcn primitives in `components/ui/*`.
 *
 * `Panel` and `StatCard` are Cards; `CopyButton` is a Button. `HBars` stays a
 * hand-rolled bar list — a horizontal bar whose width is a data-driven
 * percentage is an inline style, not a utility class.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** A titled surface grouping related content, with an optional right-aligned slot. */
export function Panel({
  title,
  extra,
  children,
  className,
}: {
  title?: string;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <Card className={cn("dashboard-panel gap-0 py-5", className)}>
      {title != null && (
        <CardHeader className="flex flex-row flex-wrap items-center gap-3 px-5 pb-3">
          <CardTitle className="text-base font-semibold">{title}</CardTitle>
          {extra != null && (
            <>
              <span className="flex-1" />
              {extra}
            </>
          )}
        </CardHeader>
      )}
      <CardContent className="px-5">{children}</CardContent>
    </Card>
  );
}

/**
 * A single headline metric: label, value, and an optional trailing unit.
 *
 * `cls` tones the VALUE, not the card — the legacy rule was `.stat.is-bad .v`,
 * i.e. the modifier sat on the card but only ever coloured the number.
 */
export function StatCard({
  k,
  v,
  sub,
  cls,
}: {
  k: string;
  v: string;
  sub?: string;
  cls?: string;
}): ReactNode {
  return (
    <Card className="dashboard-stat gap-2 px-4 py-4">
      <p className="text-muted-foreground text-xs tracking-wide uppercase">{k}</p>
      <div className={cn("text-2xl font-semibold tabular-nums", cls)}>
        {v}
        {sub != null && <small className="text-muted-foreground ml-1 text-sm"> {sub}</small>}
      </div>
    </Card>
  );
}

/** A horizontal bar chart for a handful of labelled values. */
export function HBars({
  rows,
}: {
  rows: { label: string; value: number; sub?: string; color?: string }[];
}): ReactNode {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="flex flex-col gap-2">
      {rows.map((r) => (
        <div className="grid grid-cols-[minmax(0,7rem)_1fr_auto] items-center gap-3" key={r.label}>
          <span className="text-muted-foreground truncate text-xs" title={r.label}>
            {r.label}
          </span>
          <div className="bg-muted h-2 overflow-hidden rounded-full">
            <div
              className={cn("h-full rounded-full", !r.color && "bg-brand")}
              // Width is data-driven, so it can't be a utility class.
              style={{ width: `${(r.value / max) * 100}%`, background: r.color }}
            />
          </div>
          <span className="text-xs tabular-nums">{r.sub ?? String(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

/** A clipboard glyph for icon-only copy affordances. */
export function CopyIcon(): ReactNode {
  return <Copy aria-hidden="true" />;
}

/**
 * Copy-to-clipboard button that swaps to a check for a moment on success. Pass
 * `icon` for an icon-only affordance (e.g. next to a title); otherwise a text
 * label is shown.
 */
export function CopyButton({
  text,
  label = "Copy",
  className,
  icon = false,
  title,
}: {
  text: string;
  label?: ReactNode;
  className?: string;
  icon?: boolean;
  title?: string;
}): ReactNode {
  const [copied, setCopied] = useState(false);
  const tRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (tRef.current && clearTimeout(tRef.current)), []);
  const onClick = (): void => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        if (tRef.current) clearTimeout(tRef.current);
        tRef.current = setTimeout(() => setCopied(false), 1400);
      },
      () => {},
    );
  };
  return (
    <Button
      type="button"
      variant="outline"
      size={icon ? "icon-sm" : "sm"}
      className={className}
      onClick={onClick}
      title={title ?? "Copy to clipboard"}
      aria-label={title ?? "Copy to clipboard"}
    >
      {copied ? <Check className="text-success" /> : icon ? <Copy /> : label}
      {copied && (
        <span className="sr-only" role="status" aria-live="polite">
          Copied!
        </span>
      )}
    </Button>
  );
}
