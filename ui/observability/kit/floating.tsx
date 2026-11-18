/**
 * Where a picker's list opens: a popover under its trigger, or a bottom sheet
 * on a phone (Kit-Phone). Both close on Esc and on a click outside.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { X } from "lucide-react";
import { Dialog as DialogPrimitive, Popover as PopoverPrimitive } from "radix-ui";
import { isPhone, popIn, sheetIn } from "./motion";

export function useIsPhone(open: boolean): boolean {
  const [phone, setPhone] = useState(false);
  // Decide when the list opens; a resize while open keeps the current form.
  useEffect(() => {
    if (open) setPhone(isPhone());
  }, [open]);
  return phone;
}

export function Floating({
  open,
  onOpenChange,
  anchor,
  title,
  phone,
  className = "kit-menu",
  align = "start",
  onOpenFocus,
  animate = false,
  keep,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The trigger. Rendered inside Popover.Anchor so the list lines up with it. */
  anchor: ReactNode;
  /** Sheet heading on a phone, usually the field's label. */
  title: string;
  phone: boolean;
  className?: string;
  align?: "start" | "center" | "end";
  /** Where focus goes when the list opens (the search box or the list). */
  onOpenFocus?: RefObject<HTMLElement | null>;
  /** Animate the surface itself (lists animate their own rows). */
  animate?: boolean;
  /** Clicks and focus inside this element (the trigger or input) do not close the list. */
  keep?: RefObject<HTMLElement | null>;
  children: ReactNode;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || !animate || !ref.current) return;
    return phone ? sheetIn(ref.current) : popIn(ref.current);
  }, [open, animate, phone]);
  const focus = (e: Event): void => {
    e.preventDefault();
    (onOpenFocus?.current ?? ref.current)?.focus({ preventScroll: true });
  };

  if (phone)
    return (
      <>
        {anchor}
        <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
          <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay className="kit-scrim" />
            <DialogPrimitive.Content
              ref={ref}
              className="kit-sheet"
              aria-describedby={undefined}
              onOpenAutoFocus={focus}
            >
              <span className="grab" aria-hidden="true" />
              <div className="kit-sheet-hd">
                <DialogPrimitive.Title>{title}</DialogPrimitive.Title>
                <DialogPrimitive.Close className="kit-ib" aria-label="Close">
                  <X aria-hidden="true" />
                </DialogPrimitive.Close>
              </div>
              {children}
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
      </>
    );

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Anchor asChild>{anchor}</PopoverPrimitive.Anchor>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          ref={ref}
          className={className}
          sideOffset={6}
          align={align}
          collisionPadding={12}
          onOpenAutoFocus={focus}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => {
            if (keep?.current?.contains(e.target as Node)) e.preventDefault();
          }}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
