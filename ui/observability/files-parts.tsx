/**
 * Small parts that every Files view shares: the kind tile of a file, the board
 * date format, the router colours, a per-router usage store, the strip and the
 * centred dialog.
 */
import {
  Archive,
  File,
  FileCode2,
  FileImage,
  Folder,
  Globe,
  KeyRound,
  LifeBuoy,
  Package,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { FileKind, RouterSystem } from "./files-lib";
import type { Tone } from "./kit";
import { count, popInDialog } from "./files-motion";

const KIND_ICON: Record<FileKind, typeof File> = {
  folder: Folder,
  backup: Archive,
  script: FileCode2,
  package: Package,
  text: File,
  key: KeyRound,
  support: LifeBuoy,
  web: Globe,
  image: FileImage,
  file: File,
};

/** The tile in front of a file name, coloured by what the file is. */
export function KindTile({ kind, size = 14 }: { kind: FileKind; size?: number }): ReactNode {
  const Icon = KIND_ICON[kind];
  return (
    <span className="fp-ki" data-kind={kind} aria-hidden="true">
      <Icon size={size} strokeWidth={1.7} />
    </span>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number): string => String(n).padStart(2, "0");

/** `Nov 18 · 09:12`; a dash when the router gave no time. */
export function stamp(mtime: number, sep = " · "): string {
  if (mtime < 86_400) return "—";
  const d = new Date(mtime * 1000);
  return `${MONTHS[d.getMonth()]} ${two(d.getDate())}${sep}${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** `Nov 18`. */
export function day(mtime: number): string {
  if (mtime < 86_400) return "—";
  const d = new Date(mtime * 1000);
  return `${MONTHS[d.getMonth()]} ${two(d.getDate())}`;
}

/** `412 KB`, `1.9 MB`, `1 GB`: 1024-based, short labels, as the boards write sizes. */
export function size(n: number): string {
  if (n < 1024 * 1024) {
    const kb = n / 1024;
    if (n === 0) return "0 KB";
    return `${kb < 10 ? kb.toFixed(1).replace(/\.0$/, "") : Math.round(kb)} KB`;
  }
  const units = ["MB", "GB", "TB"];
  let v = n / (1024 * 1024);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 100 ? v.toFixed(1).replace(/\.0$/, "") : Math.round(v)} ${units[i]}`;
}

/** Router colours, in config order: teal, indigo, amber, then the entity hues. */
const SWATCH = [
  "var(--sig)",
  "var(--page-accent)",
  "var(--warning)",
  "var(--entity-3)",
  "var(--entity-7)",
  "var(--entity-6)",
  "var(--entity-4)",
];
export const swatch = (index: number): string => SWATCH[Math.max(index, 0) % SWATCH.length]!;

/** The configured routers, set once by the page: names in order, and their LED tone. */
let fleet: { names: string[]; tone: Record<string, Tone> } = { names: [], tone: {} };
const fleetListeners = new Set<() => void>();
export const fleetStore = {
  set(value: typeof fleet): void {
    fleet = value;
    for (const listener of fleetListeners) listener();
  },
  get: (): typeof fleet => fleet,
  subscribe(listener: () => void): () => void {
    fleetListeners.add(listener);
    return () => fleetListeners.delete(listener);
  },
};

/** A tiny store for `useSyncExternalStore`. */
export function box<T>(initial: T): {
  get: () => T;
  set: (value: T) => void;
  subscribe: (listener: () => void) => () => void;
} {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T): void {
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The files beside the one in the viewer, for next / previous (J / K). */
export const viewerSiblings = box<{
  device: string;
  dir: string;
  names: string[];
  meta: Record<string, { size: number; mtime: number; preview: boolean }>;
} | null>(null);
/** The viewer tab to open on: view, edit, compare, follow or details. */
export const viewerTab = box<string>("view");

/** The pane the user worked in last: the toolbar's Storage opens on its router. */
let activePane: { id: string; device: string; path: string } | null = null;
const activeListeners = new Set<() => void>();
export const activePaneStore = {
  set(value: typeof activePane): void {
    activePane = value;
    for (const listener of activeListeners) listener();
  },
  get: (): typeof activePane => activePane,
  subscribe(listener: () => void): () => void {
    activeListeners.add(listener);
    return () => activeListeners.delete(listener);
  },
};

/** What each open router said about its storage, shared by its tab and the page head. */
const usage = new Map<string, RouterSystem>();
const usageListeners = new Set<() => void>();
let usageVersion = 0;
export const usageStore = {
  set(device: string, value: RouterSystem): void {
    usage.set(device, value);
    usageVersion += 1;
    for (const listener of usageListeners) listener();
  },
  get: (device: string): RouterSystem | undefined => usage.get(device),
  version: (): number => usageVersion,
  subscribe(listener: () => void): () => void {
    usageListeners.add(listener);
    return () => usageListeners.delete(listener);
  },
};

/** A number that counts to its new value. React leaves the text to the effect. */
export function Count({
  value,
  format,
  className,
}: {
  value: number;
  format?: (n: number) => string;
  className?: string;
}): ReactNode {
  const ref = useRef<HTMLSpanElement>(null);
  const last = useRef(0);
  useEffect(() => {
    const stop = count(ref.current, last.current, value, format);
    last.current = value;
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- format is a pure function
  }, [value]);
  return <span ref={ref} className={className} />;
}

/** A one-line notice: warn (amber), danger (pink), ok (teal) or plain. */
export function Strip({
  tone,
  icon,
  children,
  actions,
  role = "status",
  label,
  className,
}: {
  tone?: "warn" | "danger" | "ok";
  icon?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  role?: "status" | "alertdialog";
  label?: string;
  className?: string;
}): ReactNode {
  return (
    <div
      className={`fl-strip${className ? ` ${className}` : ""}`}
      data-tone={tone}
      role={role}
      aria-label={label}
    >
      {icon && (
        <span className="i" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="t">{children}</span>
      <span className="sp" />
      {actions}
    </div>
  );
}

/** A centred dialog over a scrim: header with icon, title, meta and close. */
export function Dialog({
  label,
  icon,
  title,
  meta,
  tools,
  onClose,
  wide,
  children,
}: {
  label: string;
  icon: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  tools?: ReactNode;
  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
}): ReactNode {
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    card.current?.focus({ preventScroll: true });
    return popInDialog(card.current);
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (document.querySelector("[role=menu], [role=listbox]")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="fl-dialog">
      <button type="button" className="fl-scrim" aria-label="Close" onClick={onClose} />
      <div
        ref={card}
        className="fl-mod"
        data-wide={wide || undefined}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
      >
        <header className="fl-mod-hd">
          <span className="ic" aria-hidden="true">
            {icon}
          </span>
          <h2>{title}</h2>
          {meta != null && <span className="m">{meta}</span>}
          <span className="sp" />
          {tools}
          <button type="button" className="fp-ib" aria-label="Close" onClick={onClose}>
            <X size={15} />
          </button>
        </header>
        <div className="fl-mod-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
