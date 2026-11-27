/**
 * The option list shared by Select, Combobox, MultiSelect and the router picker:
 * groups, LEDs, icons, two-line options, a meta value, a check on the chosen
 * option, the matched part of the label in teal, and a stationary active-row highlight.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { Check } from "lucide-react";
import { popIn } from "./motion";

export type Tone = "ok" | "bad" | "warn" | "acc" | "off";

export interface KitOption<V extends string = string> {
  value: V;
  label: string;
  /** Second line under the label. */
  description?: string;
  /** Right-aligned value: "12 ms", "up", "24 entries". */
  meta?: ReactNode;
  led?: Tone;
  icon?: ReactNode;
  disabled?: boolean;
  /** Options with the same group are listed under one heading. */
  group?: string;
  danger?: boolean;
  /** Extra words the search matches. */
  keywords?: string;
}

export function Led({ tone }: { tone: Tone }): ReactNode {
  return <span className="kit-led" data-tone={tone} aria-hidden="true" />;
}

export function Kbd({ children }: { children: ReactNode }): ReactNode {
  return <span className="kit-kbd">{children}</span>;
}

/** Wraps the first match of `query` in <mark>. */
export function Highlight({ text, query }: { text: string; query: string }): ReactNode {
  const q = query.trim().toLowerCase();
  const at = q ? text.toLowerCase().indexOf(q) : -1;
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + q.length)}</mark>
      {text.slice(at + q.length)}
    </>
  );
}

export function matches(o: KitOption, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return `${o.label} ${o.description ?? ""} ${o.keywords ?? ""} ${o.value}`
    .toLowerCase()
    .includes(q);
}

/** Next enabled index from `from` in direction `dir`, wrapping. -1 if none. */
export function step(options: readonly KitOption[], from: number, dir: 1 | -1): number {
  const n = options.length;
  for (let i = 1; i <= n; i++) {
    const j = (((from + dir * i) % n) + n) % n;
    if (!options[j]!.disabled) return j;
  }
  return -1;
}

export function edge(options: readonly KitOption[], last: boolean): number {
  const idx = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
  return (last ? idx.at(-1) : idx[0]) ?? -1;
}

export function optionId(base: string, i: number): string {
  return `${base}-o${i}`;
}

export function OptionList({
  id,
  options,
  active,
  selected,
  query = "",
  onPick,
  onHover,
  label,
  multi = false,
  animate = true,
  footer,
  children,
  focusRef,
  onKeyDown,
}: {
  id: string;
  options: readonly KitOption[];
  active: number;
  selected: ReadonlySet<string>;
  query?: string;
  onPick: (o: KitOption) => void;
  onHover: (i: number) => void;
  label: string;
  multi?: boolean;
  animate?: boolean;
  /** Rows after the options, such as "Use what you typed". */
  footer?: ReactNode;
  children?: ReactNode;
  /** Set when the list itself takes focus (no search box). */
  focusRef?: RefObject<HTMLDivElement | null>;
  onKeyDown?: (e: KeyboardEvent) => void;
}): ReactNode {
  const ownRef = useRef<HTMLDivElement>(null);
  const listRef = focusRef ?? ownRef;

  // Rows rise in once, when the list first shows.
  useEffect(() => {
    const list = listRef.current;
    if (!list || !animate) return;
    return popIn(
      list.closest<HTMLElement>(".kit-menu, .kit-sheet") ?? list,
      list.querySelectorAll<HTMLElement>(".kit-opt"),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on mount
  }, []);

  // Keep the active option visible during keyboard navigation.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const row =
      active >= 0 ? list.querySelector<HTMLElement>(`#${CSS.escape(optionId(id, active))}`) : null;
    row?.scrollIntoView({ block: "nearest" });
  }, [active, id, options, listRef]);

  let lastGroup: string | undefined;
  return (
    <div
      ref={listRef}
      id={id}
      role="listbox"
      aria-label={label}
      aria-multiselectable={multi || undefined}
      aria-activedescendant={focusRef && active >= 0 ? optionId(id, active) : undefined}
      tabIndex={focusRef ? -1 : undefined}
      onKeyDown={onKeyDown}
      className="kit-list"
    >
      {options.map((o, i) => {
        const head =
          o.group && o.group !== lastGroup ? (
            <div className="kit-group" role="presentation">
              {o.group}
            </div>
          ) : null;
        lastGroup = o.group;
        const isSel = selected.has(o.value);
        return (
          <div key={o.value} className="contents">
            {head}
            <div
              id={optionId(id, i)}
              role="option"
              aria-selected={isSel}
              aria-disabled={o.disabled || undefined}
              data-active={i === active}
              data-danger={o.danger || undefined}
              className="kit-opt"
              onPointerMove={() => {
                if (!o.disabled && i !== active) onHover(i);
              }}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => {
                if (!o.disabled) onPick(o);
              }}
            >
              {o.led && <Led tone={o.led} />}
              {o.icon && (
                <span className="ico" aria-hidden="true">
                  {o.icon}
                </span>
              )}
              {o.description ? (
                <span className="two">
                  <span className="t">
                    <Highlight text={o.label} query={query} />
                  </span>
                  <small>{o.description}</small>
                </span>
              ) : (
                <span className="t">
                  <Highlight text={o.label} query={query} />
                </span>
              )}
              {o.meta != null && <span className="meta">{o.meta}</span>}
              {isSel && (
                <span className="ck" aria-hidden="true">
                  <Check />
                </span>
              )}
            </div>
          </div>
        );
      })}
      {footer}
      {children}
    </div>
  );
}

export function KeyHints(): ReactNode {
  return (
    <div className="kit-foot" aria-hidden="true">
      <Kbd>↑</Kbd>
      <Kbd>↓</Kbd>
      <span>move</span>
      <Kbd>↵</Kbd>
      <span>choose</span>
      <Kbd>Esc</Kbd>
      <span>close</span>
    </div>
  );
}
