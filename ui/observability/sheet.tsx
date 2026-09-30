import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Sheet as UiSheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

/**
 * Longest exit animation on `SheetContent` (`duration-300` on the panel,
 * `duration-500` on the overlay). The parent unmounts us on `onClose`, so we
 * must not report closed until Radix has finished playing that out.
 */
const ANIM_MS = 500;

/**
 * Reusable right-anchored slide-over sheet, on Radix's dialog via shadcn's Sheet.
 *
 * The call sites conditionally render this component — mounted means open, and
 * `onClose` means "unmount me" — whereas Radix is controlled by an `open` prop.
 * We bridge the two: open on mount, and on any dismissal (backdrop, ✕, Escape,
 * all of which Radix handles) flip `open` false so the exit animation plays,
 * then defer the parent's `onClose` until it has finished.
 *
 * Radix also portals to <body>, focus-traps, marks the rest of the page
 * `aria-hidden`, and restores focus on close — behaviour the hand-rolled overlay
 * did not have.
 */
export function Sheet({
  title,
  subtitle,
  onClose,
  footer,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read the latest onClose from a ref so a deferred close never fires a stale
  // parent callback.
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Open on the frame after mount so the closed→open transition actually runs.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setOpen(true));
    return () => {
      cancelAnimationFrame(raf);
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);

  const onOpenChange = useCallback((next: boolean): void => {
    if (next || closeTimer.current) return; // opening, or already closing
    setOpen(false);
    closeTimer.current = setTimeout(() => onCloseRef.current(), ANIM_MS);
  }, []);

  return (
    <UiSheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-2xl">
        <SheetHeader className="border-b">
          <SheetTitle>{title}</SheetTitle>
          {subtitle != null && <SheetDescription>{subtitle}</SheetDescription>}
        </SheetHeader>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
        {footer != null && <SheetFooter className="border-t">{footer}</SheetFooter>}
      </SheetContent>
    </UiSheet>
  );
}
