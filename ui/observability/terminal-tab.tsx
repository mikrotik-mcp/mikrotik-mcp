/**
 * Pane tab with a context menu: right-click the title to rename the pane or to
 * give it a colour. Both are kept in the dockview layout (the title and a
 * `color` parameter), so they survive a reload and travel with a workspace.
 */
import type { IDockviewPanelHeaderProps } from "dockview-react";
import { Check, Pencil, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Colour names; terminal.css maps each to a colour (`[data-pane-color]`). */
export const PANE_COLORS = ["cyan", "green", "amber", "rose", "violet", "blue", "slate"] as const;
export type PaneColor = (typeof PANE_COLORS)[number];

export function PaneTab(
  props: IDockviewPanelHeaderProps<{ device: string; color?: string }>,
): ReactNode {
  const { api } = props;
  const [title, setTitle] = useState(api.title ?? "");
  const [color, setColor] = useState(props.params?.color ?? "");
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const tab = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onTitle = api.onDidTitleChange((event) => setTitle(event.title));
    const onParams = api.onDidParametersChange((params) =>
      setColor((params as { color?: string }).color ?? ""),
    );
    return () => {
      onTitle.dispose();
      onParams.dispose();
    };
  }, [api]);

  // Close the menu on a click outside it, or on Escape.
  useEffect(() => {
    if (!menu) return;
    const onDown = (event: MouseEvent): void => {
      if (!box.current?.contains(event.target as Node)) setMenu(null);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMenu(null);
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const paint = (next: string): void => {
    api.updateParameters({ ...api.getParameters(), color: next || undefined });
    setColor(next);
  };
  const rename = (): void => {
    const next = draft.trim();
    if (next) api.setTitle(next);
    setMenu(null);
  };
  const page = document.querySelector(".term-page");

  return (
    <div
      ref={tab}
      className="term-tab"
      data-pane-color={color || undefined}
      onContextMenu={(event) => {
        event.preventDefault();
        setDraft(title);
        setMenu({
          x: Math.min(event.clientX, window.innerWidth - 250),
          y: Math.min(event.clientY, window.innerHeight - 190),
        });
      }}
      onDoubleClick={() => {
        const rect = tab.current?.getBoundingClientRect();
        setDraft(title);
        setMenu({ x: rect?.left ?? 0, y: rect?.bottom ?? 0 });
      }}
      title="Right-click to rename or colour this pane"
    >
      <span className="term-tab-dot" />
      <span className="term-tab-title">{title}</span>
      <button
        type="button"
        className="term-tab-close"
        aria-label={`Close ${title}`}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          api.close();
        }}
      >
        <X size={12} />
      </button>
      {menu &&
        page &&
        createPortal(
          <div
            ref={box}
            className="term-tab-menu"
            role="menu"
            aria-label="Pane title and colour"
            style={{ left: menu.x, top: menu.y }}
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                rename();
              }}
            >
              <Pencil size={12} />
              <input
                // eslint-disable-next-line jsx-a11y/no-autofocus -- the menu opens on a click
                autoFocus
                value={draft}
                maxLength={60}
                aria-label="Pane title"
                onFocus={(event) => event.target.select()}
                onChange={(event) => setDraft(event.target.value)}
              />
              <button type="submit" disabled={!draft.trim()} title="Rename">
                <Check size={13} />
              </button>
            </form>
            <div className="term-tab-colors" role="group" aria-label="Pane colour">
              {PANE_COLORS.map((name) => (
                <button
                  key={name}
                  type="button"
                  data-pane-color={name}
                  aria-label={name}
                  aria-pressed={color === name}
                  title={name}
                  onClick={() => paint(name)}
                />
              ))}
              <button
                type="button"
                className="term-tab-nocolor"
                aria-pressed={!color}
                onClick={() => paint("")}
                title="No colour"
              >
                none
              </button>
            </div>
            <button
              type="button"
              className="term-tab-reset"
              onClick={() => {
                api.setTitle(props.params?.device ?? title);
                setMenu(null);
              }}
            >
              Reset the title to the router name
            </button>
          </div>,
          page,
        )}
    </div>
  );
}
