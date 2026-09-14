"use client";
// beui.dev/components/motion/select

import { Check, ChevronDown } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import type { Transition, Variants } from "motion/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { EASE_OUT } from "@/components/beui/registry/lib/ease";
import { cn } from "@/components/beui/registry/lib/utils";

const INSTANT_TRANSITION: Transition = { duration: 0 };

// Spring with bounce powers the unfold/separation; per-property timings in the
// content choreograph it (see SelectContent). Mirrors bouncy-accordion's feel.
const CHEVRON_TRANSITION: Transition = { type: "spring", duration: 0.4, bounce: 0.3 };

const LIST_VARIANTS: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.035, delayChildren: 0.05 } },
};
const ITEM_VARIANTS: Variants = {
  hidden: { opacity: 0, y: -6, filter: "blur(3px)" },
  show: { opacity: 1, y: 0, filter: "blur(0px)" },
};

type Placement = "bottom" | "top";

interface SelectContextValue {
  value: string | undefined;
  open: boolean;
  setOpen: (open: boolean) => void;
  select: (value: string) => void;
  register: (value: string, label: ReactNode) => void;
  unregister: (value: string) => void;
  labelFor: (value: string | undefined) => ReactNode;
  reduce: boolean;
  triggerId: string;
  listId: string;
  disabled: boolean;
  placement: Placement;
  setPlacement: (p: Placement) => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  setTriggerId: (id: string) => void;
}

const SelectContext = createContext<SelectContextValue | null>(null);

function useSelectContext(component: string) {
  const ctx = useContext(SelectContext);
  if (!ctx) throw new Error(`${component} must be used within <Select>`);
  return ctx;
}

export interface SelectProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /**
   * Controlled open state of the panel. A layout that stacks selects can hold
   * this to keep exactly one panel open — the panel is absolutely positioned
   * inside its field, so two open at once paint over each other's options.
   */
  open?: boolean;
  /** Uncontrolled initial open state. Default false. */
  defaultOpen?: boolean;
  /**
   * Fires whenever the panel opens or closes. The panel is absolutely
   * positioned inside the field, so a layout that stacks selects has to know
   * which one is open to paint it above its neighbours.
   */
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}

export function Select({
  value,
  defaultValue,
  onValueChange,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  disabled = false,
  className,
  children,
}: SelectProps) {
  const reduce = useReducedMotion() ?? false;
  const baseId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [triggerId, setTriggerId] = useState(`${baseId}-trigger`);
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const [internal, setInternal] = useState(defaultValue);
  const [labels, setLabels] = useState<Map<string, ReactNode>>(new Map());
  const [placement, setPlacement] = useState<Placement>("bottom");

  const controlled = value !== undefined;
  const current = controlled ? value : internal;
  const openControlled = openProp !== undefined;
  const open = !disabled && (openControlled ? openProp : internalOpen);

  const setOpen = useCallback(
    (next: boolean) => {
      if (!openControlled) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange, openControlled],
  );

  const select = useCallback(
    (next: string) => {
      if (!controlled) setInternal(next);
      onValueChange?.(next);
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
    },
    [controlled, onValueChange, setOpen],
  );

  const register = useCallback((v: string, label: ReactNode) => {
    setLabels((m) => (m.get(v) === label ? m : new Map(m).set(v, label)));
  }, []);
  const unregister = useCallback((v: string) => {
    setLabels((m) => {
      if (!m.has(v)) return m;
      const next = new Map(m);
      next.delete(v);
      return next;
    });
  }, []);

  // close on outside pointer / escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onPointer = (e: PointerEvent) => {
      if (
        rootRef.current &&
        !rootRef.current.contains(e.target as Node) &&
        !contentRef.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [open, setOpen]);

  const ctx = useMemo<SelectContextValue>(
    () => ({
      value: current,
      open,
      setOpen,
      select,
      register,
      unregister,
      labelFor: (v) => (v === undefined ? undefined : labels.get(v)),
      reduce,
      triggerId,
      setTriggerId,
      triggerRef,
      contentRef,
      listId: `${baseId}-list`,
      disabled,
      placement,
      setPlacement,
    }),
    [
      current,
      open,
      setOpen,
      select,
      register,
      unregister,
      labels,
      reduce,
      baseId,
      triggerId,
      disabled,
      placement,
    ],
  );

  return (
    <SelectContext.Provider value={ctx}>
      <div ref={rootRef} className={cn("relative", className)}>
        {children}
      </div>
    </SelectContext.Provider>
  );
}

export interface SelectTriggerProps extends Omit<
  import("motion/react").HTMLMotionProps<"button">,
  "children"
> {
  className?: string;
  children: ReactNode;
}

export function SelectTrigger({
  className,
  children,
  id,
  onClick,
  onKeyDown,
  ref,
  ...props
}: SelectTriggerProps) {
  const ctx = useSelectContext("SelectTrigger");
  useLayoutEffect(() => {
    if (id) ctx.setTriggerId(id);
  }, [id, ctx.setTriggerId]);
  const isTop = ctx.placement === "top";
  // edge facing the panel flattens then rounds; the far edge stays rounded.
  // All four corners are specified so none gets stranded when placement flips.
  const kf = ctx.open ? [0, 0, 12] : [12, 0, 12];
  const kfT: Transition = ctx.reduce
    ? { duration: 0 }
    : ctx.open
      ? { duration: 0.6, times: [0, 0.4, 1], ease: EASE_OUT }
      : { duration: 0.42, times: [0, 0.5, 1], ease: EASE_OUT };
  return (
    <motion.button
      {...props}
      ref={(node) => {
        ctx.triggerRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      }}
      role="combobox"
      type="button"
      id={ctx.triggerId}
      disabled={ctx.disabled}
      aria-haspopup="listbox"
      aria-expanded={ctx.open}
      aria-controls={ctx.listId}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) ctx.setOpen(!ctx.open);
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (
          !event.defaultPrevented &&
          ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
        ) {
          event.preventDefault();
          ctx.setOpen(true);
        }
      }}
      // Gooey: the edge facing the panel snaps flat (panel attached) then rounds
      // back once the panel pulls away — the two pinch apart.
      initial={false}
      animate={{
        borderTopLeftRadius: isTop ? kf : 12,
        borderTopRightRadius: isTop ? kf : 12,
        borderBottomLeftRadius: isTop ? 12 : kf,
        borderBottomRightRadius: isTop ? 12 : kf,
      }}
      transition={{
        borderTopLeftRadius: isTop ? kfT : INSTANT_TRANSITION,
        borderTopRightRadius: isTop ? kfT : INSTANT_TRANSITION,
        borderBottomLeftRadius: isTop ? INSTANT_TRANSITION : kfT,
        borderBottomRightRadius: isTop ? INSTANT_TRANSITION : kfT,
      }}
      className={cn(
        "relative z-10 flex w-full items-center justify-between gap-2 rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors",
        "hover:border-(--color-border-strong) focus-visible:ring-2 focus-visible:ring-foreground/20",
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
    >
      {children}
      <motion.span
        aria-hidden
        animate={{ rotate: ctx.open ? 180 : 0 }}
        transition={ctx.reduce ? { duration: 0 } : CHEVRON_TRANSITION}
        className="text-muted-foreground"
      >
        <ChevronDown className="h-4 w-4" />
      </motion.span>
    </motion.button>
  );
}

export interface SelectValueProps {
  placeholder?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function SelectValue({ placeholder, className, children }: SelectValueProps) {
  const ctx = useSelectContext("SelectValue");
  const label = ctx.labelFor(ctx.value);
  return (
    <span className={cn(label ? "text-foreground" : "text-muted-foreground", className)}>
      {children ?? label ?? placeholder ?? "Select"}
    </span>
  );
}

export interface SelectContentProps {
  className?: string;
  children: ReactNode;
}

export function SelectContent({ className, children }: SelectContentProps) {
  const ctx = useSelectContext("SelectContent");
  const innerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const open = ctx.open;
  const { setPlacement } = ctx;
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0, maxHeight: 300 });
  const typeahead = useRef({ text: "", at: 0 });
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);

  // Keep options inside a modal's focus scope when the trigger belongs to one.
  useLayoutEffect(() => {
    setPortalTarget(
      ctx.triggerRef.current?.closest<HTMLElement>('[role="dialog"], [role="alertdialog"]') ??
        document.body,
    );
  }, [ctx.triggerRef]);

  useLayoutEffect(() => {
    const node = innerRef.current;
    if (!node) return;
    const measure = () => setHeight(node.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [portalTarget]);

  // On open, flip upward when there isn't room below and there's more above.
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = ctx.triggerRef.current;
    const node = innerRef.current;
    if (!trigger || !node) return;
    const measure = () => {
      const rect = trigger.getBoundingClientRect();
      const modal = portalTarget !== document.body ? portalTarget : null;
      const bounds = modal?.getBoundingClientRect();
      const below =
        Math.min(window.innerHeight, bounds?.bottom ?? window.innerHeight) - rect.bottom;
      const above = rect.top - Math.max(0, bounds?.top ?? 0);
      // The trigger may be a compact toolbar filter. Size the menu to its
      // option labels, bounded by the viewport/modal rather than the trigger.
      const leftEdge = Math.max(8, (bounds?.left ?? 0) + 8);
      const rightEdge = Math.min(window.innerWidth - 8, (bounds?.right ?? window.innerWidth) - 8);
      const availableWidth = Math.max(0, rightEdge - leftEdge);
      node.style.maxWidth = `${availableWidth}px`;
      node.style.minWidth = `${Math.min(rect.width, availableWidth)}px`;
      const width = Math.min(availableWidth, Math.max(rect.width, node.offsetWidth + 2));
      const top = below < Math.min(node.offsetHeight, 300) + 16 && above > below;
      setPlacement(top ? "top" : "bottom");
      setPosition({
        left:
          Math.max(leftEdge, Math.min(rect.left, rightEdge - width)) -
          (bounds?.left ?? 0) +
          (modal?.scrollLeft ?? 0),
        top: modal
          ? (top ? rect.top : rect.bottom) - (bounds?.top ?? 0) + modal.scrollTop
          : top
            ? window.innerHeight - rect.top
            : rect.bottom,
        width,
        maxHeight: Math.max(60, Math.min(300, (top ? above : below) - 24)),
      });
    };
    measure();
    const selected =
      node.querySelector<HTMLButtonElement>(
        '[role="option"][aria-selected="true"]:not(:disabled)',
      ) ?? node.querySelector<HTMLButtonElement>('[role="option"]:not(:disabled)');
    selected?.focus({ preventScroll: true });
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, ctx.triggerRef, setPlacement, portalTarget]);

  // Specify EVERY corner + both margins each render. The near edge (facing the
  // trigger) animates flat->round and the gap opens on that side; the far edge
  // stays rounded and its margin pinned to 0. Setting all of them avoids a
  // stranded square corner when the placement flips between opens.
  const isTop = ctx.placement === "top";
  const nearGap = open ? 8 : 0;
  const nearRadius = open ? 12 : 0;

  const gapT: Transition = open
    ? { type: "spring", duration: 0.6, bounce: 0.5, delay: 0.12 }
    : { type: "spring", duration: 0.3, bounce: 0.1 };
  const radiusT: Transition = open
    ? { duration: 0.3, ease: EASE_OUT, delay: 0.14 }
    : { duration: 0.16, ease: EASE_OUT };

  // Items stay mounted (open just animates the panel) so each item's label
  // registration persists — otherwise the trigger would fall back to the
  // placeholder the moment the panel closes.
  if (!portalTarget) return null;
  const inModal = portalTarget !== document.body;
  return createPortal(
    <motion.div
      ref={ctx.contentRef}
      id={ctx.listId}
      role="listbox"
      aria-labelledby={ctx.triggerId}
      aria-hidden={!open}
      inert={!open}
      onKeyDown={(event) => {
        const options = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)'),
        );
        const index = options.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === "Tab") {
          ctx.setOpen(false);
          ctx.triggerRef.current?.focus();
          return;
        }
        let next: HTMLButtonElement | undefined;
        if (event.key === "ArrowDown") next = options[(index + 1) % options.length];
        else if (event.key === "ArrowUp")
          next = options[(index - 1 + options.length) % options.length];
        else if (event.key === "Home") next = options[0];
        else if (event.key === "End") next = options.at(-1);
        else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && event.key !== " ") {
          const now = Date.now();
          typeahead.current = {
            text:
              (now - typeahead.current.at < 700 ? typeahead.current.text : "") +
              event.key.toLowerCase(),
            at: now,
          };
          next = options.find((option) =>
            option.textContent?.trim().toLowerCase().startsWith(typeahead.current.text),
          );
        }
        if (next) {
          event.preventDefault();
          next.focus();
        }
      }}
      initial={false}
      animate={
        ctx.reduce
          ? { opacity: open ? 1 : 0, height: open ? height : 0 }
          : {
              opacity: open ? 1 : 0,
              height: open ? height : 0,
              // gap opens on the side facing the trigger
              marginTop: isTop ? 0 : nearGap,
              marginBottom: isTop ? nearGap : 0,
              // near corners go flat->round; far corners stay rounded
              borderTopLeftRadius: isTop ? 12 : nearRadius,
              borderTopRightRadius: isTop ? 12 : nearRadius,
              borderBottomLeftRadius: isTop ? nearRadius : 12,
              borderBottomRightRadius: isTop ? nearRadius : 12,
            }
      }
      transition={
        ctx.reduce
          ? { duration: 0.12 }
          : {
              opacity: open ? { duration: 0.18 } : { duration: 0.16, delay: 0.12 },
              height: open
                ? { type: "spring", duration: 0.42, bounce: 0.14 }
                : { duration: 0.26, ease: EASE_OUT, delay: 0.14 },
              marginTop: isTop ? INSTANT_TRANSITION : gapT,
              marginBottom: isTop ? gapT : INSTANT_TRANSITION,
              borderTopLeftRadius: isTop ? INSTANT_TRANSITION : radiusT,
              borderTopRightRadius: isTop ? INSTANT_TRANSITION : radiusT,
              borderBottomLeftRadius: isTop ? radiusT : INSTANT_TRANSITION,
              borderBottomRightRadius: isTop ? radiusT : INSTANT_TRANSITION,
            }
      }
      style={{
        position: inModal ? "absolute" : "fixed",
        left: position.left,
        width: position.width,
        zIndex: 80,
        top: inModal || !isTop ? position.top : "auto",
        bottom: !inModal && isTop ? position.top : "auto",
        translate: inModal && isTop ? "0 -100%" : undefined,
        transformOrigin: isTop ? "bottom" : "top",
        overflow: "hidden",
        pointerEvents: open ? "auto" : "none",
      }}
      // flush against the trigger, then separates into its own rounded pill;
      // sits above or below depending on available space
      className={cn(
        "rounded-xl border border-border bg-popover text-popover-foreground shadow-xl",
        className,
      )}
    >
      <motion.div
        ref={innerRef}
        variants={ctx.reduce ? undefined : LIST_VARIANTS}
        initial={false}
        animate={open ? "show" : "hidden"}
        className="grid w-max gap-1.5 overflow-y-auto overscroll-contain p-1.5"
        style={{ maxHeight: position.maxHeight }}
      >
        {children}
      </motion.div>
    </motion.div>,
    portalTarget,
  );
}

export interface SelectItemProps {
  value: string;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
  textValue?: string;
}

export function SelectItem({
  value,
  disabled = false,
  className,
  children,
  textValue,
}: SelectItemProps) {
  const ctx = useSelectContext("SelectItem");
  const selected = ctx.value === value;
  const label = textValue ?? children;

  useLayoutEffect(() => {
    ctx.register(value, label);
    return () => ctx.unregister(value);
  }, [ctx.register, ctx.unregister, value, label]);

  return (
    <motion.div role="presentation" variants={ctx.reduce ? undefined : ITEM_VARIANTS}>
      <button
        type="button"
        role="option"
        aria-selected={selected}
        disabled={disabled}
        onClick={() => ctx.select(value)}
        className={cn(
          "flex min-h-9 w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-[13px] leading-5 outline-none transition-colors duration-150",
          selected
            ? "border-primary/25 bg-primary/12 text-foreground"
            : "border-transparent text-foreground/80",
          "hover:border-primary/45 hover:bg-primary/25 hover:text-foreground focus-visible:border-primary/60 focus-visible:bg-primary/25 focus-visible:text-foreground",
          "disabled:pointer-events-none disabled:opacity-50",
          className,
        )}
      >
        <span className="min-w-0 whitespace-normal [overflow-wrap:anywhere]">{children}</span>
        <Check
          aria-hidden="true"
          className={cn("h-3.5 w-3.5 shrink-0", !selected && "invisible")}
        />
      </button>
    </motion.div>
  );
}
