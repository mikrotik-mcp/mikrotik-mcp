/**
 * Shared building blocks for every dashboard page, after the approved "Signal"
 * boards. Styles live in monitoring.css.
 *
 * - `PageIntro`: the page header: teal eyebrow, title or a large verdict,
 *   status, lead and actions, with an optional graphic beside it. The shell
 *   hides its own header on pages that use it and passes the group, title and
 *   the Help toggle through `MonitorPageProvider`.
 * - `MetricStrip` + `Metric`: a row of glass KPI cards, optional sparkline.
 * - `Ticker`: a number that eases to its new value (anime.js).
 * - `MonitorPanel`: a glass panel with a title, one line of context and a
 *   controls slot.
 * - `MonitorEmpty`, `MonitorNote`, `StatusDot` (LED), `StatusBadge` (pill),
 *   `RiskBadge`, `Segmented`, `MonitorTabs`, `MonitorSelect`, `RouterPicker`,
 *   `MonitorSearch`, `MonitorSwitch`, `MonitorDialog` (dialog or drawer).
 * - Charts: `Sparkline`, `Ring`, `Donut` in signal-charts.tsx.
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
import { ChevronDown, HelpCircle, Info, Search, Server, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { Scope } from "animejs";
import { cn } from "@/lib/utils";
import type { Risk } from "./types";
import { Sparkline } from "./signal-charts";

export { Donut, Ring, Sparkline } from "./signal-charts";
export type { ChartTone, DonutPart } from "./signal-charts";

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

const REDUCE = "(prefers-reduced-motion: reduce)";

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.(REDUCE).matches;
}

/**
 * The boards' `.btn`. `primary` is the one teal action per page; `inverse` is
 * its older name and looks the same.
 */
export function MonitorButton({
  variant = "glass",
  size = "md",
  icon,
  children,
  type = "button",
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "glass" | "primary" | "inverse" | "ghost" | "danger";
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
 * The page header from the Signal boards (`.ph1`): a teal uppercase eyebrow
 * (the sidebar group), the page title at 34px, a status line, a lead and the
 * page's actions on the right.
 *
 * - `title` + `tone`: the status line, with an LED. `small` keeps the status
 *   and `children` on one line (Live Feed, Flows).
 * - `children` or `lead`: the lead paragraph.
 * - `heading`: replaces the page title, e.g. `<>Wi-Fi is healthy, <em>2
 *   channels overlap</em>.</>`. Inside it `<em>` is pink, `.s` teal, `.w` amber.
 * - `verdict`: the large 40px answer line from the Overview board. It takes the
 *   title's place, the actions move under the lead, and `aside` (a graphic,
 *   e.g. a radar) sits on the right. Pass `eyebrow` to say what it covers
 *   ("Last hour").
 * - `controls` and `actions` are the same slot.
 */
export function PageIntro({
  tone,
  live = false,
  title,
  status,
  small = false,
  children,
  lead,
  controls,
  actions,
  eyebrow,
  heading,
  verdict,
  aside,
}: {
  /** Leave out for a plain status with no LED. */
  tone?: Tone;
  live?: boolean;
  /** The status line. */
  title?: ReactNode;
  /** Same as `title`. */
  status?: ReactNode;
  small?: boolean;
  children?: ReactNode;
  /** Same as `children`. */
  lead?: ReactNode;
  controls?: ReactNode;
  /** Same as `controls`. */
  actions?: ReactNode;
  /** Replaces the sidebar group shown above the title. */
  eyebrow?: ReactNode;
  /** Replaces the page title. */
  heading?: ReactNode;
  /** The large answer line; replaces the title. */
  verdict?: ReactNode;
  /** A graphic beside a verdict header. */
  aside?: ReactNode;
}): ReactNode {
  const page = useContext(MonitorPageContext);
  const statusLine = status ?? title;
  const leadText = lead ?? children;
  const buttons = actions ?? controls;
  const eyebrowText = eyebrow ?? page?.eyebrow;
  const titleText = heading ?? page?.title;
  const isVerdict = verdict != null;
  const help = page != null && (
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
  );
  const statusBlock =
    statusLine == null ? null : small ? (
      <p className="monitor-status-sm">
        {tone != null && <StatusDot tone={tone} pulse={live} />}
        <b>{statusLine}</b>
        {leadText != null && <span>· {leadText}</span>}
      </p>
    ) : (
      <p className="monitor-status">
        {tone != null && <StatusDot tone={tone} pulse={live} />}
        {statusLine}
      </p>
    );
  const leadBlock =
    leadText != null && !(small && statusLine != null) ? (
      <p className="monitor-lead">{leadText}</p>
    ) : null;

  if (isVerdict)
    return (
      <>
        <header
          className="monitor-head"
          data-layout="verdict"
          data-aside={aside != null || undefined}
          data-group={page?.eyebrow}
        >
          <div className="monitor-head-main">
            {eyebrowText != null && <p className="monitor-eyebrow">{eyebrowText}</p>}
            <h1 className="monitor-verdict">{verdict}</h1>
            {statusBlock}
            {leadBlock}
            {buttons != null && <div className="monitor-head-controls">{buttons}</div>}
            {/* Help sits in the text column, so it never covers the graphic beside it. */}
            {help}
          </div>
          {aside != null && <div className="monitor-head-aside">{aside}</div>}
        </header>
        {page?.helpOpen && page.helpPanel}
      </>
    );

  return (
    <>
      <header className="monitor-head" data-group={page?.eyebrow}>
        <div className="monitor-head-main">
          {eyebrowText != null && <p className="monitor-eyebrow">{eyebrowText}</p>}
          {titleText != null && <h1 className="monitor-title">{titleText}</h1>}
          {statusBlock}
          {leadBlock}
        </div>
        {buttons != null && <div className="monitor-head-controls">{buttons}</div>}
        {help}
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

/**
 * One glass KPI card inside a `MetricStrip`. A warn or bad tone colours the
 * value and adds a glowing bar along the top. `spark` draws a trend line in
 * the bottom-right corner. Put a unit in `<small>` inside `value`: `412<small>ms</small>`.
 */
export function Metric({
  label,
  value,
  hint,
  tone = "default",
  primary = false,
  spark,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  /** Kept for older call sites; every card uses the same size in Signal. */
  primary?: boolean;
  /** Recent values for the sparkline, oldest first. Two or more. */
  spark?: number[];
}): ReactNode {
  const showSpark = spark != null && spark.length > 1;
  return (
    <div
      className="monitor-metric"
      data-tone={tone}
      data-primary={primary || undefined}
      data-spark={showSpark || undefined}
    >
      <p className="monitor-metric-label">{label}</p>
      <p className="monitor-metric-value">{value}</p>
      {hint != null && <p className="monitor-metric-hint">{hint}</p>}
      {showSpark && <Sparkline values={spark} tone={tone === "bad" ? "bad" : "good"} />}
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
        <div className="min-w-0 flex-[1_1_220px]">
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

/**
 * A glowing LED (the boards' `.led`). Always put a word next to it. `pulse`
 * means live right now: a halo, and the LED breathes.
 */
export function StatusDot({
  tone = "default",
  pulse = false,
}: {
  tone?: Tone;
  pulse?: boolean;
}): ReactNode {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const dot = ref.current;
    if (!pulse || !dot || prefersReducedMotion()) return;
    const breathe = animate(dot, {
      opacity: [1, 0.45, 1],
      duration: 2400,
      loop: true,
      ease: "inOutSine",
    });
    return () => {
      breathe.revert();
    };
  }, [pulse]);
  return (
    <span
      ref={ref}
      className="monitor-dot"
      data-tone={tone}
      data-pulse={pulse || undefined}
      aria-hidden="true"
    />
  );
}

/**
 * A pill with an LED and a word, e.g. "Recording", "Firing" (the boards'
 * `.pill`). The tone colours the whole pill; `quiet` keeps it neutral with
 * only the LED in colour. `dot={false}` drops the LED.
 */
export function StatusBadge({
  tone = "default",
  pulse = false,
  quiet = false,
  dot = true,
  children,
}: {
  tone?: Tone;
  pulse?: boolean;
  quiet?: boolean;
  dot?: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <span className="monitor-badge" data-tone={quiet ? undefined : tone}>
      {dot && <StatusDot tone={tone} pulse={pulse} />}
      {children}
    </span>
  );
}

/** A note box (the boards' `.note`): an icon and a sentence, toned by status. */
export function MonitorNote({
  tone,
  icon,
  children,
  className,
  role,
}: {
  tone?: "good" | "warn" | "bad";
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
  role?: "status" | "alert";
}): ReactNode {
  return (
    <div className={cn("monitor-note", className)} data-tone={tone} role={role}>
      {icon ?? <Info aria-hidden="true" />}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
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
      {risk === "WRITE_IDEMPOTENT" ? (short ? "WRITE·I" : "IDEMPOTENT") : risk}
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
 * A dialog over a dimmed page (the boards' `.dialog`): a header with title,
 * one line of description and a close button, a body, and a footer bar.
 * `variant="drawer"` slides the same parts in from the right edge, full height
 * (the boards' `.drawer`, 440px by default).
 */
export function MonitorDialog({
  open,
  onOpenChange,
  title,
  description,
  eyebrow,
  width,
  footer,
  children,
  dismissible = true,
  confirm = false,
  closeDisabled = false,
  variant = "dialog",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  /** Max width in px: 560 for a dialog, 440 for a drawer. */
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
  variant?: "dialog" | "drawer";
}): ReactNode {
  const drawer = variant === "drawer";
  const overlayRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // The scrim fades in; the dialog scales up from 0.98, the drawer slides in.
  useEffect(() => {
    if (!open || prefersReducedMotion()) return;
    const overlay = overlayRef.current;
    const content = contentRef.current;
    if (!overlay || !content) return;
    const motion = [
      animate(overlay, { opacity: [0, 1], duration: 160, ease: "outQuad" }),
      drawer
        ? animate(content, { x: ["100%", "0%"], duration: 240, ease: "outQuart" })
        : animate(content, { opacity: [0, 1], scale: [0.98, 1], duration: 180, ease: "outQuart" }),
    ];
    return () => {
      for (const m of motion) m.revert();
    };
  }, [open, drawer]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay ref={overlayRef} className="monitor-scrim fixed inset-0 z-50" />
        <DialogPrimitive.Content
          ref={contentRef}
          className={cn(
            "monitor-dialog fixed z-50 flex flex-col outline-none",
            drawer
              ? "inset-y-0 right-0 w-full"
              : confirm
                ? "top-[min(120px,8dvh)] left-0 right-0 mx-auto max-h-[calc(100dvh-min(120px,8dvh)-16px)] w-[calc(100%-32px)]"
                : "inset-0 m-auto h-fit max-h-[calc(100dvh-32px)] w-[calc(100%-32px)]",
          )}
          data-variant={variant}
          style={{ maxWidth: width ?? (drawer ? 440 : 560) }}
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
                <button
                  type="button"
                  className="monitor-icon-btn"
                  aria-label="Close"
                  disabled={closeDisabled}
                >
                  <X aria-hidden="true" />
                </button>
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
