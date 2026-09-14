"use client";
// beui.dev/components/motion/tabs

import { motion, MotionConfig, useReducedMotion } from "motion/react";
import type { Transition } from "motion/react";
import { createContext, useCallback, useContext, useId, useMemo, useState } from "react";
import type { ReactNode, ComponentProps } from "react";
import { EASE_OUT } from "@/components/beui/registry/lib/ease";
import { cn } from "@/components/beui/registry/lib/utils";

type Variant = "pill" | "underline" | "segment";

type Ctx = {
  value: string;
  setValue: (v: string) => void;
  layoutId: string;
  variant: Variant;
};

const TabsCtx = createContext<Ctx | null>(null);

function useTabs() {
  const ctx = useContext(TabsCtx);
  if (!ctx) throw new Error("Tabs.* must be used inside <Tabs>");
  return ctx;
}

// Settle without overshoot: a scrollable tab list would turn even a small
// overshoot into a transient scrollbar and layout shift.
const transition: Transition = {
  type: "spring",
  stiffness: 170,
  damping: 30,
  mass: 1.2,
};

export function Tabs({
  defaultValue,
  value,
  onValueChange,
  variant = "pill",
  children,
  className,
}: {
  defaultValue?: string;
  value?: string;
  onValueChange?: (v: string) => void;
  variant?: Variant;
  children: ReactNode;
  className?: string;
}) {
  const [internal, setInternal] = useState(defaultValue ?? "");
  const layoutId = useId();
  const reduce = useReducedMotion();
  const controlled = value !== undefined;
  const current = controlled ? value : internal;
  const setValue = useCallback(
    (v: string) => {
      if (!controlled) setInternal(v);
      onValueChange?.(v);
    },
    [controlled, onValueChange],
  );
  const contextValue = useMemo(
    () => ({ value: current, setValue, layoutId, variant }),
    [current, layoutId, setValue, variant],
  );
  return (
    <MotionConfig transition={reduce ? { duration: 0 } : transition}>
      <TabsCtx.Provider value={contextValue}>
        {/* layoutRoot: the indicator's layoutId measures in page coordinates, so
            inside fixed/scrolled containers it would replay scroll offsets as
            movement. The pill only ever travels within the list, so scoping
            projection to the Tabs wrapper is always correct. */}
        <motion.div layoutRoot className={className}>
          {children}
        </motion.div>
      </TabsCtx.Provider>
    </MotionConfig>
  );
}

const listClasses: Record<Variant, string> = {
  pill: "inline-flex items-center gap-1 rounded-full bg-card p-1",
  underline: "inline-flex items-center gap-1 border-b border-border",
  segment: "inline-flex items-center gap-0 rounded-lg bg-card p-0.5",
};

export function TabsList({ children, className, onKeyDown, ...props }: ComponentProps<"div">) {
  const { variant } = useTabs();
  return (
    <div
      {...props}
      role="tablist"
      className={cn(listClasses[variant], className)}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        const tabs = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'),
        );
        const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          event.key === "Home"
            ? tabs[0]
            : event.key === "End"
              ? tabs.at(-1)
              : event.key === "ArrowRight"
                ? tabs[(index + 1) % tabs.length]
                : event.key === "ArrowLeft"
                  ? tabs[(index - 1 + tabs.length) % tabs.length]
                  : null;
        if (next) {
          event.preventDefault();
          next.focus();
          next.click();
        }
      }}
    >
      {children}
    </div>
  );
}

export function TabsTrigger({
  value,
  children,
  className,
  indicatorClassName,
  disabled,
  onClick,
  ...props
}: Omit<ComponentProps<"button">, "value"> & {
  value: string;
  children: ReactNode;
  className?: string;
  indicatorClassName?: string;
}) {
  const { value: current, setValue, layoutId, variant } = useTabs();
  const active = current === value;
  const triggerProps = {
    ...props,
    id: `${layoutId}-tab-${value}`,
    "aria-controls": `${layoutId}-panel-${value}`,
    "data-state": active ? "active" : "inactive",
    tabIndex: active ? 0 : -1,
    disabled,
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(event);
      if (!event.defaultPrevented && !disabled) setValue(value);
    },
  };

  if (variant === "underline") {
    return (
      <button
        {...triggerProps}
        type="button"
        role="tab"
        aria-selected={active}
        className={cn(
          "relative isolate px-3 pb-2.5 pt-1 -mb-px text-sm font-medium transition-colors min-h-[44px] inline-flex items-center",
          active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
          className,
        )}
      >
        {children}
        {active ? (
          <motion.span
            layoutId={layoutId}
            layout="position"
            className={cn("absolute -bottom-px left-0 right-0 h-px bg-primary", indicatorClassName)}
          />
        ) : null}
      </button>
    );
  }

  const radius = variant === "pill" ? "rounded-full" : "rounded-md";

  return (
    <div className="relative">
      {active ? (
        <motion.span
          layoutId={layoutId}
          layout="position"
          style={{ borderRadius: variant === "pill" ? 9999 : 8 }}
          className={cn("absolute inset-0 bg-primary", radius, indicatorClassName)}
        />
      ) : null}
      <button
        {...triggerProps}
        type="button"
        role="tab"
        aria-selected={active}
        className={cn(
          "relative z-10 inline-flex items-center justify-center whitespace-nowrap bg-transparent px-3.5 py-1.5 text-sm font-medium outline-none",
          "transition-colors",
          active ? "text-primary-foreground" : "text-muted-foreground hover:text-foreground",
          radius,
          className,
        )}
      >
        {children}
      </button>
    </div>
  );
}

export function TabsContent({
  value,
  children,
  className,
  forceMount,
}: {
  value: string;
  children: ReactNode;
  className?: string;
  forceMount?: boolean;
}) {
  const { value: current, layoutId } = useTabs();
  const reduce = useReducedMotion();
  const active = current === value;
  // Dashboard panels may fetch router data on mount; inactive panels must not.
  if (!active && !forceMount) return null;
  return (
    <motion.div
      role="tabpanel"
      hidden={!active}
      id={`${layoutId}-panel-${value}`}
      aria-labelledby={`${layoutId}-tab-${value}`}
      tabIndex={0}
      key={value}
      initial={{ opacity: 0, y: reduce ? 0 : 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: EASE_OUT }}
      className={cn("mt-4", className)}
    >
      {children}
    </motion.div>
  );
}
