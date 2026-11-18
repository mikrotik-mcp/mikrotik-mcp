/**
 * Small floating parts the terminal page shares, all on the kit's menu surface:
 * a menu that opens at a point (right-click on a block, a click on an address),
 * a popover for panels with fields, a ticking count and the shimmer of a
 * progress bar.
 */
import { animate, createScope } from "animejs";
import { DropdownMenu as MenuPrimitive, Popover as PopoverPrimitive } from "radix-ui";
import type { CSSProperties, KeyboardEvent, ReactElement, ReactNode } from "react";
import { useEffect, useRef } from "react";
import { reducedMotion, tick } from "./kit";
import { popIn } from "./kit/motion";

export interface PointItem {
  label: ReactNode;
  icon?: ReactNode;
  shortcut?: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

function matchesKey(shortcut: string, event: KeyboardEvent): boolean {
  const parts = shortcut.split(" ");
  const key = parts.at(-1)?.toLowerCase();
  const ctrl = parts.includes("Ctrl");
  return event.key.toLowerCase() === key && ctrl === (event.ctrlKey || event.metaKey);
}

/**
 * A menu at a screen point. The anchor is an empty fixed box at the point, so
 * the kit menu lines up with the pointer and flips at the window edges.
 */
export function PointMenu({
  at,
  onClose,
  label,
  head,
  groups,
  width = 260,
}: {
  at: { x: number; y: number } | null;
  onClose: () => void;
  label: string;
  head?: ReactNode;
  groups: readonly (readonly PointItem[])[];
  width?: number;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const open = at !== null;
  useEffect(() => {
    if (open && ref.current)
      return popIn(ref.current, ref.current.querySelectorAll<HTMLElement>(".kit-opt"));
  }, [open, at]);
  const shown = groups.filter((group) => group.length > 0);
  return (
    <MenuPrimitive.Root open={open} onOpenChange={(next) => !next && onClose()} modal={false}>
      <MenuPrimitive.Trigger asChild>
        <span
          aria-hidden="true"
          tabIndex={-1}
          className="term-anchor"
          style={{ left: at?.x ?? 0, top: at?.y ?? 0 }}
        />
      </MenuPrimitive.Trigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Content
          ref={ref}
          className="kit-menu term-menu"
          aria-label={label}
          align="start"
          sideOffset={2}
          collisionPadding={12}
          style={{ width }}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onKeyDown={(event) => {
            // "R", "Ctrl C": the shortcut shown on an item runs it.
            const hit = shown
              .flat()
              .find((item) => !item.disabled && item.shortcut && matchesKey(item.shortcut, event));
            if (!hit) return;
            event.preventDefault();
            hit.onSelect();
            onClose();
          }}
        >
          {head != null && <div className="term-menu-head">{head}</div>}
          {shown.map((group, gi) => (
            // eslint-disable-next-line react/no-array-index-key -- groups have no identity
            <MenuPrimitive.Group key={gi}>
              {gi > 0 && <MenuPrimitive.Separator className="kit-sep" />}
              {group.map((item, i) => (
                <MenuPrimitive.Item
                  // eslint-disable-next-line react/no-array-index-key -- labels may be nodes
                  key={i}
                  className="kit-opt kit-menu-item"
                  data-danger={item.danger || undefined}
                  disabled={item.disabled}
                  onSelect={item.onSelect}
                >
                  {item.icon != null && (
                    <span className="ico" aria-hidden="true">
                      {item.icon}
                    </span>
                  )}
                  <span className="t">{item.label}</span>
                  {item.shortcut && <span className="meta">{item.shortcut}</span>}
                </MenuPrimitive.Item>
              ))}
            </MenuPrimitive.Group>
          ))}
        </MenuPrimitive.Content>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}

/** A panel under a button, for settings and short forms. Closes on Esc or a click outside. */
export function Pop({
  trigger,
  open,
  onOpenChange,
  label,
  children,
  align = "end",
  width = 300,
  className,
}: {
  trigger: ReactElement;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  children: ReactNode;
  align?: "start" | "center" | "end";
  width?: number;
  className?: string;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open && ref.current)
      return popIn(ref.current, ref.current.querySelectorAll<HTMLElement>(".term-pop-row"));
  }, [open]);
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          ref={ref}
          className={`kit-menu term-pop ${className ?? ""}`}
          aria-label={label}
          align={align}
          sideOffset={6}
          collisionPadding={12}
          style={{ width } as CSSProperties}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/** A count that ticks to its new value. */
export function Count({ value, className }: { value: number; className?: string }): ReactNode {
  const ref = useRef<HTMLSpanElement>(null);
  const last = useRef(value);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const from = last.current;
    last.current = value;
    return tick(el, from, value);
  }, [value]);
  return (
    <span ref={ref} className={className}>
      {value}
    </span>
  );
}

/** The bright band that runs along a progress bar while a command runs. */
export function Shimmer(): ReactNode {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion()) return;
    const scope = createScope({ root: el }).add(() => {
      animate(el, { translateX: ["-100%", "250%"], duration: 1400, ease: "inOutSine", loop: true });
    });
    return () => scope.revert();
  }, []);
  return <i ref={ref} />;
}
