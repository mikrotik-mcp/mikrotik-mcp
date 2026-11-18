/**
 * Menus and tooltips (Kit-Overlays 02). `Tooltip` wraps one element;
 * `TitleTooltips` shows every `title` attribute in the panel as a kit tooltip.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { createPortal } from "react-dom";
import { DropdownMenu as MenuPrimitive, Tooltip as TooltipPrimitive } from "radix-ui";
import { popIn } from "./motion";
import { Kbd } from "./listbox";

/* --------------------------------------------------------------------- Menu */

export interface MenuItem {
  label: ReactNode;
  icon?: ReactNode;
  /** Shortcut hint on the right: "Ctrl C". */
  shortcut?: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

/** A row's ⋯ menu. Groups are separated by a line; put the danger item last. */
export function Menu({
  trigger,
  groups,
  label,
  align = "end",
}: {
  trigger: ReactElement;
  groups: readonly (readonly MenuItem[])[];
  label: string;
  align?: "start" | "end";
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (open && ref.current)
      return popIn(ref.current, ref.current.querySelectorAll<HTMLElement>(".kit-opt"));
  }, [open]);
  return (
    <MenuPrimitive.Root open={open} onOpenChange={setOpen}>
      <MenuPrimitive.Trigger asChild>{trigger}</MenuPrimitive.Trigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Content
          ref={ref}
          className="kit-menu"
          aria-label={label}
          align={align}
          sideOffset={6}
          collisionPadding={12}
          style={{ minWidth: 220 }}
        >
          {groups.map((g, gi) => (
            <MenuPrimitive.Group key={gi}>
              {gi > 0 && <MenuPrimitive.Separator className="kit-sep" />}
              {g.map((item, i) => (
                <MenuPrimitive.Item
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

/* ------------------------------------------------------------------ Tooltip */

export function Tooltip({
  content,
  shortcut,
  children,
  side = "top",
}: {
  content: ReactNode;
  shortcut?: string;
  children: ReactElement;
  side?: "top" | "bottom" | "left" | "right";
}): ReactNode {
  return (
    <TooltipPrimitive.Provider delayDuration={400} skipDelayDuration={300}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            className="kit-tip"
            side={side}
            sideOffset={8}
            collisionPadding={8}
          >
            {content}
            {shortcut && <Kbd>{shortcut}</Kbd>}
            <TooltipPrimitive.Arrow className="kit-tip-arrow" width={10} height={5} />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

/**
 * Shows each element's `title` as a kit tooltip instead of the browser's: after
 * 400 ms on hover, at once on keyboard focus, and at once when moving from one
 * titled element to the next. The title moves to `data-kit-title` while shown,
 * so the browser's own tooltip stays hidden; it comes back on leave.
 */
export function TitleTooltips(): ReactNode {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; below: boolean } | null>(
    null,
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = useRef<HTMLElement | null>(null);
  const lastHide = useRef(0);

  useEffect(() => {
    const restore = (): void => {
      const el = current.current;
      if (el?.dataset.kitTitle != null) {
        el.setAttribute("title", el.dataset.kitTitle);
        delete el.dataset.kitTitle;
      }
      current.current = null;
    };
    const hide = (): void => {
      if (timer.current) clearTimeout(timer.current);
      if (current.current) lastHide.current = Date.now();
      restore();
      setTip(null);
    };
    const show = (el: HTMLElement, now: boolean): void => {
      const text = el.getAttribute("title") ?? "";
      if (!text.trim() || el.closest("svg, iframe, [data-kit-native-title]")) return;
      if (current.current !== el) hide();
      current.current = el;
      el.dataset.kitTitle = text;
      el.removeAttribute("title");
      const place = (): void => {
        if (current.current !== el || !el.isConnected) return;
        const r = el.getBoundingClientRect();
        const below = r.top < 48;
        setTip({ text, x: r.left + r.width / 2, y: below ? r.bottom + 8 : r.top - 8, below });
      };
      if (timer.current) clearTimeout(timer.current);
      if (now || Date.now() - lastHide.current < 300) place();
      else timer.current = setTimeout(place, 400);
    };
    const over = (e: PointerEvent): void => {
      if (e.pointerType === "touch") return;
      const el = (e.target as Element | null)?.closest?.<HTMLElement>("[title]");
      if (el) show(el, false);
      else if (current.current && !current.current.contains(e.target as Node)) hide();
    };
    const focus = (e: FocusEvent): void => {
      const el = e.target as HTMLElement | null;
      if (el?.matches?.(":focus-visible") && el.hasAttribute("title")) show(el, true);
    };
    const leave = (e: Event): void => {
      if (current.current && (e.target === current.current || e.type !== "pointerout")) hide();
    };
    document.addEventListener("pointerover", over);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", leave);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("keydown", hide, true);
    window.addEventListener("scroll", hide, true);
    return () => {
      hide();
      document.removeEventListener("pointerover", over);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", leave);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("keydown", hide, true);
      window.removeEventListener("scroll", hide, true);
    };
  }, []);

  if (!tip) return null;
  return createPortal(
    <div
      role="tooltip"
      className="kit-tip kit-title-tip"
      data-below={tip.below || undefined}
      style={{ position: "fixed", left: tip.x, top: tip.y }}
    >
      {tip.text}
    </div>,
    document.body,
  );
}
