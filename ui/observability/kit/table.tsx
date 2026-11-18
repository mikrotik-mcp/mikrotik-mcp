/**
 * Table row menu and selection bar (Kit-Data-ContextMenu).
 *
 * Wrap a row in <RowMenu>, mark each cell with `data-col="<key>"`, and describe
 * the cells in `cells`. Right-click, Shift+F10, the menu key or the row's
 * <RowMore> (⋯) button opens one menu: open the row, what the clicked cell
 * can do (filter, open, look up, copy), Copy and Select sub-menus, then the
 * page's own actions with dangerous ones last. Only pass actions the page
 * can already do.
 */
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactElement, ReactNode } from "react";
import {
  CheckSquare,
  ChevronRight,
  Copy,
  ExternalLink,
  FileJson,
  Filter,
  Globe,
  KeyRound,
  ListFilter,
  MoreHorizontal,
  PanelRight,
  Search,
  Server,
  X,
} from "lucide-react";
import {
  ContextMenu as CtxPrimitive,
  Dialog as DialogPrimitive,
  DropdownMenu as DropPrimitive,
} from "radix-ui";
import { cn } from "@/lib/utils";
import { isPhone, popIn, sheetIn } from "./motion";

export type CellKind = "text" | "router" | "ip" | "risk" | "duration" | "tool" | "id" | "time";

export interface CellMenu {
  /** What the cell shows, used in item labels: "home-ax3". */
  value: string;
  kind?: CellKind;
  /** The page's own filter for this value ("Show only home-ax3"). */
  filter?: () => void;
  /** Clears the page's filter for this column, when one is set. */
  clearFilter?: () => void;
  /** The page can sort by this column. */
  sort?: () => void;
  /** Opens the thing the value names: a router, a user, a page. */
  open?: { label: string; run: () => void };
  /** Opens IP Intelligence for an address. */
  lookup?: () => void;
  /** Runs the page search with this value. */
  search?: () => void;
  /** Set false for values that should not be copied. */
  copy?: boolean;
}

export interface RowAction {
  label: ReactNode;
  icon?: ReactNode;
  shortcut?: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export interface CopyItem {
  label: string;
  /** Short preview shown on the right: "8e38…8741". */
  hint?: string;
  value: string | (() => string);
  icon?: ReactNode;
}

export interface RowMenuProps {
  /** Header: what the row is. */
  title: ReactNode;
  sub?: ReactNode;
  /** "Open details ↵": opens the row drawer. */
  onOpen?: () => void;
  /** Further open items, e.g. "Open full record". */
  opens?: RowAction[];
  cells?: Record<string, CellMenu>;
  /** Items of the Copy sub-menu. A JSON copy of `row` is added when given. */
  copies?: CopyItem[];
  row?: unknown;
  /** The Select sub-menu. */
  select?: { selected: boolean; toggle: () => void; similar?: { label: string; run: () => void } };
  /** The page's own actions for this row; put dangerous ones last. */
  actions?: RowAction[];
  /** When rows are selected and this row is one of them, the menu acts on the selection. */
  selection?: { count: number; summary?: ReactNode; actions: RowAction[]; clear: () => void };
  children: ReactElement;
}

function copyText(v: string | (() => string)): void {
  void navigator.clipboard?.writeText(typeof v === "function" ? v() : v);
}

function short(s: string): string {
  return s.length > 14 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
}

/* Item model, rendered by both the context menu and the ⋯ dropdown. */
type Node =
  | { t: "head"; title: ReactNode; sub?: ReactNode }
  | { t: "group"; label: ReactNode }
  | { t: "sep" }
  | { t: "item"; a: RowAction }
  | { t: "sub"; label: string; icon: ReactNode; items: Node[] };

function build(p: RowMenuProps, col: string | null): Node[] {
  const out: Node[] = [];
  if (p.selection && p.selection.count > 1 && p.select?.selected) {
    out.push({ t: "head", title: `${p.selection.count} rows selected`, sub: p.selection.summary });
    for (const a of p.selection.actions) out.push({ t: "item", a });
    out.push({ t: "sep" });
    out.push({
      t: "item",
      a: { label: "Clear selection", icon: <X />, shortcut: "Esc", onSelect: p.selection.clear },
    });
    return out;
  }
  out.push({ t: "head", title: p.title, sub: p.sub });
  if (p.onOpen)
    out.push({
      t: "item",
      a: { label: "Open details", icon: <PanelRight />, shortcut: "↵", onSelect: p.onOpen },
    });
  for (const a of p.opens ?? []) out.push({ t: "item", a: { icon: <ExternalLink />, ...a } });

  const cell = col ? p.cells?.[col] : undefined;
  if (cell && cell.value) {
    const items: RowAction[] = [];
    const v = cell.value;
    if (cell.lookup)
      items.push({ label: "Look up in IP Intelligence", icon: <Globe />, onSelect: cell.lookup });
    if (cell.filter)
      items.push({ label: `Show only ${v}`, icon: <Filter />, onSelect: cell.filter });
    if (cell.clearFilter)
      items.push({ label: "Clear this filter", icon: <X />, onSelect: cell.clearFilter });
    if (cell.sort)
      items.push({ label: "Sort by this column", icon: <ListFilter />, onSelect: cell.sort });
    if (cell.search)
      items.push({ label: `Search for “${v}”`, icon: <Search />, onSelect: cell.search });
    if (cell.open)
      items.push({ label: cell.open.label, icon: <Server />, onSelect: cell.open.run });
    if (cell.copy !== false)
      items.push({
        label: `Copy “${v.length > 28 ? `${v.slice(0, 27)}…` : v}”`,
        icon: <Copy />,
        shortcut: "Ctrl C",
        onSelect: () => copyText(v),
      });
    if (items.length) {
      out.push({ t: "sep" });
      out.push({ t: "group", label: `This cell · ${v.length > 24 ? `${v.slice(0, 23)}…` : v}` });
      for (const a of items) out.push({ t: "item", a });
    }
  }

  const copies: Node[] = (p.copies ?? []).map((c) => ({
    t: "item" as const,
    a: {
      label: c.label,
      icon: c.icon ?? <KeyRound />,
      shortcut: c.hint ?? (typeof c.value === "string" ? short(c.value) : undefined),
      onSelect: () => copyText(c.value),
    },
  }));
  if (p.row !== undefined)
    copies.push({
      t: "item",
      a: {
        label: "Row as JSON",
        icon: <FileJson />,
        onSelect: () => copyText(JSON.stringify(p.row, null, 2)),
      },
    });
  const selects: Node[] = [];
  if (p.select) {
    selects.push({
      t: "item",
      a: {
        label: p.select.selected ? "Unselect row" : "Select row",
        icon: <CheckSquare />,
        onSelect: p.select.toggle,
      },
    });
    if (p.select.similar)
      selects.push({
        t: "item",
        a: { label: p.select.similar.label, icon: <CheckSquare />, onSelect: p.select.similar.run },
      });
  }
  if (copies.length || selects.length) {
    out.push({ t: "sep" });
    if (copies.length) out.push({ t: "sub", label: "Copy", icon: <Copy />, items: copies });
    if (selects.length)
      out.push({ t: "sub", label: "Select", icon: <CheckSquare />, items: selects });
  }
  const actions = [...(p.actions ?? [])].sort(
    (a, b) => Number(Boolean(a.danger)) - Number(Boolean(b.danger)),
  );
  if (actions.length) {
    out.push({ t: "sep" });
    for (const a of actions) out.push({ t: "item", a });
  }
  return out;
}

type Prims = typeof CtxPrimitive | typeof DropPrimitive;

function Items({ P, nodes }: { P: Prims; nodes: Node[] }): ReactNode {
  return nodes.map((n, i) => {
    if (n.t === "head")
      return (
        <div key={i} className="kit-ctx-head">
          <b>{n.title}</b>
          {n.sub != null && <span>{n.sub}</span>}
        </div>
      );
    if (n.t === "group")
      return (
        <P.Label key={i} className="kit-group">
          {n.label}
        </P.Label>
      );
    if (n.t === "sep") return <P.Separator key={i} className="kit-sep" />;
    if (n.t === "sub")
      return (
        <P.Sub key={i}>
          <P.SubTrigger className="kit-opt kit-menu-item">
            <span className="ico" aria-hidden="true">
              {n.icon}
            </span>
            <span className="t">{n.label}</span>
            <span className="meta" aria-hidden="true">
              <ChevronRight className="size-3.5" />
            </span>
          </P.SubTrigger>
          <P.Portal>
            <P.SubContent className="kit-menu kit-ctx" sideOffset={6} collisionPadding={12}>
              <Items P={P} nodes={n.items} />
            </P.SubContent>
          </P.Portal>
        </P.Sub>
      );
    const a = n.a;
    return (
      <P.Item
        key={i}
        className="kit-opt kit-menu-item"
        data-danger={a.danger || undefined}
        disabled={a.disabled}
        onSelect={a.onSelect}
      >
        {a.icon != null && (
          <span className="ico" aria-hidden="true">
            {a.icon}
          </span>
        )}
        <span className="t">{a.label}</span>
        {a.shortcut && <span className="meta">{a.shortcut}</span>}
      </P.Item>
    );
  });
}

const RowMenuContext = createContext<{ nodes: () => Node[]; label: string } | null>(null);

function useEntrance(open: boolean): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open && ref.current)
      return popIn(ref.current, ref.current.querySelectorAll<HTMLElement>(".kit-opt"));
  }, [open]);
  return ref;
}

/** On a phone a long-press opens the row's menu as a bottom sheet (Kit-Data-Phone). */
function PhoneSheet({ nodes, onClose }: { nodes: Node[]; onClose: () => void }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) return sheetIn(ref.current);
  }, []);
  const flat = nodes.flatMap((n) => (n.t === "sub" ? n.items : [n]));
  const head = flat.find((n) => n.t === "head");
  return (
    <DialogPrimitive.Root open onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="kit-scrim" />
        <DialogPrimitive.Content ref={ref} className="kit-sheet" aria-describedby={undefined}>
          <span className="grab" aria-hidden="true" />
          <div className="kit-sheet-hd kit-sheet-hd-stack">
            <DialogPrimitive.Title>{head?.t === "head" ? head.title : "Row"}</DialogPrimitive.Title>
            {head?.t === "head" && head.sub != null && <small>{head.sub}</small>}
          </div>
          <div className="kit-list" role="menu">
            {flat.map((n, i) =>
              n.t === "item" ? (
                <button
                  key={i}
                  type="button"
                  role="menuitem"
                  className="kit-opt"
                  data-danger={n.a.danger || undefined}
                  disabled={n.a.disabled}
                  onClick={() => {
                    n.a.onSelect();
                    onClose();
                  }}
                >
                  {n.a.icon != null && (
                    <span className="ico" aria-hidden="true">
                      {n.a.icon}
                    </span>
                  )}
                  <span className="t">{n.a.label}</span>
                </button>
              ) : n.t === "group" ? (
                <div key={i} className="kit-group">
                  {n.label}
                </div>
              ) : n.t === "sep" ? (
                <div key={i} className="kit-sep" />
              ) : null,
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function RowMenu(props: RowMenuProps): ReactNode {
  const [col, setCol] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const ref = useEntrance(open);
  const label = typeof props.title === "string" ? `Actions for ${props.title}` : "Row actions";
  const child = props.children;
  const onKey = (e: KeyboardEvent<HTMLElement>): void => {
    // Shift+F10 and the menu key open the menu at the row, from the keyboard.
    if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
      e.preventDefault();
      const el = e.currentTarget;
      const r = el.getBoundingClientRect();
      setCol(null);
      el.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          clientX: r.left + 32,
          clientY: r.bottom - 4,
        }),
      );
    }
    const prev = (child.props as { onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void }).onKeyDown;
    prev?.(e);
  };
  return (
    <RowMenuContext.Provider value={{ nodes: () => build(props, null), label }}>
      <CtxPrimitive.Root onOpenChange={setOpen}>
        <CtxPrimitive.Trigger
          asChild
          onContextMenu={(e) => {
            const cell = (e.target as Element).closest?.("[data-col]");
            const c =
              e.clientX !== 0 || e.clientY !== 0 ? (cell?.getAttribute("data-col") ?? null) : null;
            setCol(c);
            if (isPhone()) {
              e.preventDefault();
              setSheet(true);
            }
          }}
          onKeyDown={onKey}
        >
          {child}
        </CtxPrimitive.Trigger>
        <CtxPrimitive.Portal>
          <CtxPrimitive.Content
            ref={ref}
            className="kit-menu kit-ctx"
            aria-label={label}
            collisionPadding={12}
          >
            <Items P={CtxPrimitive} nodes={build(props, col)} />
          </CtxPrimitive.Content>
        </CtxPrimitive.Portal>
      </CtxPrimitive.Root>
      {sheet && <PhoneSheet nodes={build(props, col)} onClose={() => setSheet(false)} />}
    </RowMenuContext.Provider>
  );
}

/** The ⋯ button at the end of a row. It opens the same menu as a right-click. */
export function RowMore({ className }: { className?: string }): ReactNode {
  const ctx = useContext(RowMenuContext);
  const [open, setOpen] = useState(false);
  const ref = useEntrance(open);
  if (!ctx) return null;
  return (
    <DropPrimitive.Root open={open} onOpenChange={setOpen}>
      <DropPrimitive.Trigger asChild>
        <button
          type="button"
          className={cn("kit-row-more", className)}
          aria-label={ctx.label}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <MoreHorizontal aria-hidden="true" />
        </button>
      </DropPrimitive.Trigger>
      <DropPrimitive.Portal>
        <DropPrimitive.Content
          ref={ref}
          className="kit-menu kit-ctx"
          align="end"
          sideOffset={6}
          collisionPadding={12}
        >
          <Items P={DropPrimitive} nodes={ctx.nodes()} />
        </DropPrimitive.Content>
      </DropPrimitive.Portal>
    </DropPrimitive.Root>
  );
}

/** Floating bar while rows are selected: the count and the selection's actions. */
export function SelectionBar({
  count,
  noun = "rows",
  actions,
  onClear,
}: {
  count: number;
  noun?: string;
  actions: RowAction[];
  onClear: () => void;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const shown = count > 0;
  useEffect(() => {
    if (shown && ref.current) return popIn(ref.current);
  }, [shown]);
  useEffect(() => {
    if (!shown) return;
    const esc = (e: globalThis.KeyboardEvent): void => {
      if (e.key === "Escape" && !document.querySelector("[role=dialog], [role=menu]")) onClear();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [shown, onClear]);
  if (!shown) return null;
  return (
    <div ref={ref} className="kit-selbar" role="toolbar" aria-label={`${count} ${noun} selected`}>
      <b>{count}</b>
      <span>{noun} selected</span>
      <span className="sp" />
      {actions.map((a, i) => (
        <button
          key={i}
          type="button"
          className="kit-btn"
          disabled={a.disabled}
          onClick={a.onSelect}
        >
          {a.icon}
          {a.label}
        </button>
      ))}
      <button type="button" className="kit-btn" onClick={onClear}>
        <X aria-hidden="true" />
        Clear
      </button>
    </div>
  );
}
