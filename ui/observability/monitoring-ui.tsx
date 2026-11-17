/**
 * Shared building blocks for the Monitoring pages (Overview, Home Internet,
 * Service Health, Flows, Site Activity, Live Feed, Alerts, Schedules) and the
 * Network pages (Devices, Interfaces, Topology, L2 Fabric, CAPsMAN, Service
 * Routing). They follow the approved "Monitoring Redesign" and "Network
 * Redesign" canvases.
 *
 * - `PageIntro`: the page header (title, status or description, controls).
 *   The shell hides its own header on Monitoring pages and passes the title
 *   and the Help toggle through `MonitorPageProvider`.
 * - `MetricStrip` + `Metric`: one surface split by hairlines.
 * - `Ticker`: a number that eases to its new value (anime.js).
 * - `MonitorPanel`: title, one line of context, a controls slot.
 * - `MonitorEmpty`, `StatusDot`, `RiskBadge`, `Segmented`.
 * - Network: `RouterPicker`, `MonitorTabs`, `MonitorSwitch`, `MonitorDialog`.
 */
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type {
  ButtonHTMLAttributes,
  CSSProperties,
  KeyboardEvent,
  ReactNode,
  RefObject,
} from "react";
import { animate, createScope, stagger, svg } from "animejs";
import { ChevronDown, HelpCircle, Search, Server, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { Scope } from "animejs";
import { cn } from "@/lib/utils";
import type { Risk } from "./types";

/** Milliseconds the way the design system writes them: "412 ms", "1.2 s", "<1 ms". */
export function formatMs(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value < 1) return "<1 ms";
  if (value < 1000) return `${Math.round(value)} ms`;
  const s = value / 1000;
  return `${s < 10 ? Math.round(s * 10) / 10 : Math.round(s)} s`;
}

/** Bytes with a space before the unit: "4.6 MB", "412 KB", "18.4 GB". */
export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log10(value) / 3));
  const n = value / 1000 ** i;
  return `${i === 0 ? Math.round(n) : n < 100 ? n.toFixed(1).replace(/\.0$/, "") : Math.round(n)} ${units[i]}`;
}

export type Tone = "default" | "good" | "warn" | "bad" | "brand";

const TONE_TEXT: Record<Tone, string> = {
  default: "",
  good: "text-success",
  warn: "text-warning",
  bad: "text-destructive",
  brand: "text-brand",
};

const REDUCE = "(prefers-reduced-motion: reduce)";

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.(REDUCE).matches;
}

/** The boards' pill button. `inverse` is the one solid action per page. */
export function MonitorButton({
  variant = "glass",
  size = "md",
  icon,
  children,
  type = "button",
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "glass" | "inverse" | "ghost" | "danger";
  size?: "md" | "sm";
  icon?: ReactNode;
}): ReactNode {
  return (
    <button
      type={type}
      className={cn("monitor-btn", className)}
      data-variant={variant}
      data-size={size}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

/** The boards' `.select`: a native select, 32px, with a chevron. */
export function MonitorSelect({
  value,
  onChange,
  options,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  label: string;
}): ReactNode {
  return (
    <span className="monitor-select">
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown aria-hidden="true" />
    </span>
  );
}

/** The boards' `.field` search box: 36px, search icon, plain input. */
export function MonitorSearch({
  value,
  onChange,
  placeholder,
  label,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
  className?: string;
}): ReactNode {
  return (
    <label className={cn("monitor-field", className)}>
      <Search aria-hidden="true" />
      <input
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/** What the shell hands every Monitoring page for its header. */
export interface MonitorPageInfo {
  /** The sidebar group the page sits in: "Monitoring" or "Network". */
  eyebrow: string;
  title: string;
  helpOpen: boolean;
  onToggleHelp: () => void;
  helpPanel: ReactNode;
}

const MonitorPageContext = createContext<MonitorPageInfo | null>(null);
export const MonitorPageProvider = MonitorPageContext.Provider;

/**
 * The page header from the boards: "Monitoring", the page title, a status line
 * and/or one line of description, and the page's controls on the right.
 *
 * - `title` + `tone`: the status line. `small` is the 13px variant the boards
 *   use for live streams (Live Feed, Flows), where `children` follows it.
 * - `children` alone: the one-line description.
 */
export function PageIntro({
  tone,
  live = false,
  title,
  small = false,
  children,
  controls,
}: {
  /** Leave out for a plain description with no status dot. */
  tone?: Tone;
  live?: boolean;
  title?: ReactNode;
  small?: boolean;
  children?: ReactNode;
  controls?: ReactNode;
}): ReactNode {
  const page = useContext(MonitorPageContext);
  return (
    <>
      <header className="monitor-head" data-group={page?.eyebrow}>
        <div className="monitor-head-main">
          {page != null && (
            <>
              <p className="monitor-eyebrow">{page.eyebrow}</p>
              <h1 className="monitor-title">{page.title}</h1>
            </>
          )}
          {small && title != null ? (
            <p className="monitor-status-sm">
              {tone != null && <StatusDot tone={tone} pulse={live} />}
              <span className="text-foreground">{title}</span>
              {children != null && <span>· {children}</span>}
            </p>
          ) : (
            <>
              {title != null && (
                <p className="monitor-status">
                  {tone != null && <StatusDot tone={tone} pulse={live} />}
                  {title}
                </p>
              )}
              {children != null && (
                <p className={title != null ? "monitor-lead" : "monitor-lead monitor-lead-only"}>
                  {children}
                </p>
              )}
            </>
          )}
        </div>
        {(controls != null || page != null) && (
          <div className="monitor-head-controls">
            {controls}
            {page != null && (
              <button
                type="button"
                className="monitor-icon-btn"
                aria-label="About this page"
                aria-expanded={page.helpOpen}
                title="About this page"
                onClick={page.onToggleHelp}
              >
                <HelpCircle aria-hidden="true" />
              </button>
            )}
          </div>
        )}
      </header>
      {page?.helpOpen && page.helpPanel}
    </>
  );
}

/**
 * Shows `value` through `format`, easing from the previous value when it
 * changes. The first render shows the real value, so a page never opens on a
 * row of zeros counting up.
 */
export function Ticker({
  value,
  format,
  className,
}: {
  value: number;
  format: (n: number) => string;
  className?: string;
}): ReactNode {
  // The in-between number while an animation runs; null means "show value".
  const [tween, setTween] = useState<number | null>(null);
  const last = useRef(value);

  useEffect(() => {
    const from = last.current;
    last.current = value;
    if (from === value || !Number.isFinite(from) || !Number.isFinite(value)) return;
    if (prefersReducedMotion()) return;
    const state = { n: from };
    const anim = animate(state, {
      n: value,
      duration: 420,
      ease: "outQuart",
      onUpdate: () => setTween(state.n),
      onComplete: () => setTween(null),
    });
    return () => {
      anim.pause();
      setTween(null);
    };
  }, [value]);

  return <span className={cn("tabular-nums", className)}>{format(tween ?? value)}</span>;
}

/**
 * A row of related KPIs on one surface. Like the boards' `.strip`, cells fill
 * the row with `auto-fit`; `minCell` is the board's minimum cell width.
 */
export function MetricStrip({
  children,
  className,
  label,
  minCell = 180,
}: {
  children: ReactNode;
  className?: string;
  /** Accessible name for the group, e.g. "Call metrics". */
  label?: string;
  minCell?: number;
}): ReactNode {
  const style = { "--strip-min": `${minCell}px` } as CSSProperties;
  return (
    <section aria-label={label} className={cn("monitor-strip", className)} style={style}>
      {children}
    </section>
  );
}

/** One KPI cell inside a `MetricStrip`. A warn or bad tone adds an edge mark. */
export function Metric({
  label,
  value,
  hint,
  tone = "default",
  primary = false,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  /** Larger value, for the one or two numbers the page is about. */
  primary?: boolean;
}): ReactNode {
  return (
    <div className="monitor-metric" data-tone={tone} data-primary={primary || undefined}>
      <p className="monitor-metric-label">{label}</p>
      <p className={cn("monitor-metric-value", TONE_TEXT[tone])}>{value}</p>
      {hint != null && <p className="monitor-metric-hint">{hint}</p>}
    </div>
  );
}

/** A titled panel with an optional description and a controls slot. */
export function MonitorPanel({
  title,
  description,
  extra,
  children,
  className,
  bodyClassName,
  flush = false,
  tone,
  ...rest
}: {
  title: ReactNode;
  description?: ReactNode;
  extra?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  /** Lists and tables run edge to edge under the header. */
  flush?: boolean;
  /** Outline the panel in a status colour (an active change, a failure). */
  tone?: "warn" | "bad";
  "aria-label"?: string;
}): ReactNode {
  return (
    <section className={cn("monitor-panel", className)} data-tone={tone} {...rest}>
      <header className="monitor-panel-head">
        <div className="min-w-0 flex-1">
          <h2 className="monitor-panel-title">{title}</h2>
          {description != null && <p className="monitor-panel-desc">{description}</p>}
        </div>
        {extra != null && <div className="monitor-panel-extra">{extra}</div>}
      </header>
      {children != null && (
        <div className={cn(flush ? "monitor-panel-flush" : "monitor-panel-body", bodyClassName)}>
          {children}
        </div>
      )}
    </section>
  );
}

/** The one empty state for the section: icon, one sentence, next step. */
export function MonitorEmpty({
  icon,
  title,
  children,
  action,
  compact = false,
  className,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  className?: string;
}): ReactNode {
  return (
    <div className={cn("monitor-empty", compact && "monitor-empty-compact", className)}>
      {icon != null && (
        <span aria-hidden="true" className="monitor-empty-icon">
          {icon}
        </span>
      )}
      <p className="monitor-empty-title">{title}</p>
      {children != null && <div className="monitor-empty-body">{children}</div>}
      {action != null && <div className="monitor-empty-action">{action}</div>}
    </div>
  );
}

/** A status dot. Always put a word next to it; `pulse` means live right now. */
export function StatusDot({
  tone = "default",
  pulse = false,
}: {
  tone?: Tone;
  pulse?: boolean;
}): ReactNode {
  return (
    <span
      className="monitor-dot"
      data-tone={tone}
      data-pulse={pulse || undefined}
      aria-hidden="true"
    />
  );
}

/** A pill with a status dot and a word, e.g. "Recording", "Firing". */
export function StatusBadge({
  tone = "default",
  pulse = false,
  children,
}: {
  tone?: Tone;
  pulse?: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <span className="monitor-badge">
      <StatusDot tone={tone} pulse={pulse} />
      {children}
    </span>
  );
}

const RISK_KIND: Record<Risk, string> = {
  READ: "read",
  WRITE: "write",
  WRITE_IDEMPOTENT: "idem",
  DESTRUCTIVE: "destructive",
  DANGEROUS: "dangerous",
};

/** The tool's risk preset as a mono pill. DANGEROUS is the only solid one. */
export function RiskBadge({ risk, short = false }: { risk: Risk; short?: boolean }): ReactNode {
  return (
    <span className="monitor-risk" data-risk={RISK_KIND[risk]}>
      {short && risk === "WRITE_IDEMPOTENT" ? "WRITE·I" : risk}
    </span>
  );
}

/**
 * A pill segmented control. Single choice, arrow keys move the choice.
 * Use it for time windows and small "group by" switches.
 */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  label: string;
  className?: string;
}): ReactNode {
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = options.findIndex((o) => o.value === value);
    const step = e.key === "ArrowRight" ? 1 : -1;
    const next = options[(i + step + options.length) % options.length];
    onChange(next.value);
    const group = e.currentTarget.parentElement;
    requestAnimationFrame(() =>
      group?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus(),
    );
  };
  return (
    <div className={cn("monitor-seg", className)} role="radiogroup" aria-label={label}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className="monitor-seg-item"
            onClick={() => onChange(o.value)}
            onKeyDown={onKeyDown}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Fades and lifts `selector` children of `root` in, a few ms apart, each time
 * `key` changes. Pass a key that changes on a new query, not on every poll.
 */
export function useStaggerIn(
  root: RefObject<HTMLElement | null>,
  selector: string,
  key: unknown,
): void {
  const scope = useRef<Scope | null>(null);
  useEffect(() => {
    if (!root.current) return;
    scope.current = createScope({ root, mediaQueries: { reduceMotion: REDUCE } }).add((self) => {
      if (self?.matches.reduceMotion) return;
      animate(selector, {
        opacity: [0, 1],
        y: [6, 0],
        duration: 280,
        delay: stagger(24),
        ease: "outQuart",
      });
    });
    return () => scope.current?.revert();
  }, [root, selector, key]);
}

/** Draws every `path[data-draw]` inside `root` from start to end when `key` changes. */
export function useLineDraw(root: RefObject<HTMLElement | null>, key: unknown): void {
  const scope = useRef<Scope | null>(null);
  useEffect(() => {
    if (!root.current) return;
    scope.current = createScope({ root, mediaQueries: { reduceMotion: REDUCE } }).add((self) => {
      if (self?.matches.reduceMotion) return;
      const paths = root.current?.querySelectorAll<SVGPathElement>("path[data-draw]");
      if (!paths?.length) return;
      animate(svg.createDrawable(paths), { draw: ["0 0", "0 1"], duration: 700, ease: "outQuart" });
    });
    return () => scope.current?.revert();
  }, [root, key]);
}

/**
 * The router picker from the Network boards: server icon, the router name, a
 * muted "(default)" on the default router, and a chevron. A native select sits
 * on top, invisible, so keyboard and screen readers get a real select.
 */
export function RouterPicker({
  value,
  onChange,
  routers,
  defaultRouter,
  disabled,
  label = "Router",
}: {
  value: string;
  onChange: (value: string) => void;
  routers: string[];
  defaultRouter?: string | null;
  disabled?: boolean;
  label?: string;
}): ReactNode {
  return (
    <span className="monitor-router" data-disabled={disabled || undefined}>
      <Server aria-hidden="true" />
      <span className="truncate">
        {value || "Choose a router"}
        {value !== "" && value === defaultRouter && (
          <span className="text-muted-foreground"> (default)</span>
        )}
      </span>
      <ChevronDown aria-hidden="true" />
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {value === "" && <option value="">Choose a router</option>}
        {routers.map((r) => (
          <option key={r} value={r}>
            {r === defaultRouter ? `${r} (default)` : r}
          </option>
        ))}
      </select>
    </span>
  );
}

/** Underline tabs inside a panel (the boards' `.tabs`). */
export function MonitorTabs<T extends string>({
  value,
  onChange,
  tabs,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  tabs: { value: T; label: string; count?: ReactNode }[];
  label: string;
}): ReactNode {
  const move = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = tabs.findIndex((t) => t.value === value);
    const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    onChange(next.value);
  };
  return (
    <div className="monitor-tabs" role="tablist" aria-label={label} onKeyDown={move}>
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          className="monitor-tab"
          aria-selected={t.value === value}
          tabIndex={t.value === value ? 0 : -1}
          onClick={() => onChange(t.value)}
        >
          {t.label}
          {t.count != null && <span className="monitor-tab-n">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** The boards' 32×18 switch. */
export function MonitorSwitch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      className="monitor-switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

/**
 * A dialog over a dimmed page, as on the Network boards: a header with title,
 * one line of description and a close button, a body, and a footer bar.
 */
export function MonitorDialog({
  open,
  onOpenChange,
  title,
  description,
  eyebrow,
  width = 560,
  footer,
  children,
  dismissible = true,
  confirm = false,
  closeDisabled = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  width?: number;
  footer?: ReactNode;
  children: ReactNode;
  /** false: outside clicks do nothing (forms with a draft). */
  dismissible?: boolean;
  /**
   * A confirm before a write, as on the CAPsMAN confirm board: an alertdialog
   * with no close icon, set 120px from the top. Cancel lives in the footer.
   */
  confirm?: boolean;
  /** Disables the close icon, e.g. while a save runs. */
  closeDisabled?: boolean;
}): ReactNode {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/55" />
        <DialogPrimitive.Content
          className={cn(
            "monitor-dialog fixed left-1/2 z-50 flex w-[calc(100%-32px)] -translate-x-1/2 flex-col outline-none",
            confirm
              ? "top-[min(120px,8dvh)] max-h-[calc(100dvh-min(120px,8dvh)-16px)]"
              : "top-1/2 max-h-[calc(100dvh-32px)] -translate-y-1/2",
          )}
          style={{ maxWidth: width }}
          role={confirm ? "alertdialog" : "dialog"}
          onEscapeKeyDown={closeDisabled ? (e) => e.preventDefault() : undefined}
          onPointerDownOutside={dismissible ? undefined : (e) => e.preventDefault()}
          onInteractOutside={dismissible ? undefined : (e) => e.preventDefault()}
          {...(description == null ? { "aria-describedby": undefined } : {})}
        >
          <div className="monitor-dialog-head">
            <div className="min-w-0 flex-1">
              {eyebrow != null && <p className="monitor-eyebrow">{eyebrow}</p>}
              <DialogPrimitive.Title asChild>
                <h2>{title}</h2>
              </DialogPrimitive.Title>
              {description != null && (
                <DialogPrimitive.Description asChild>
                  <p>{description}</p>
                </DialogPrimitive.Description>
              )}
            </div>
            {!confirm && (
              <DialogPrimitive.Close asChild>
                <MonitorButton
                  size="sm"
                  variant="ghost"
                  aria-label="Close"
                  icon={<X />}
                  disabled={closeDisabled}
                />
              </DialogPrimitive.Close>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
          {footer != null && <div className="monitor-dialog-foot">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
