/**
 * Command palette (Ctrl+Shift+P): every action of the terminal page in one
 * searchable list, for work without the mouse.
 */
import { CircleHelp, Search, SquareTerminal, Wrench } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Kbd } from "./kit";
import { popIn } from "./kit/motion";
import { paneRegistry, terminalApi, workspace } from "./terminal-lib";

export interface PaletteAction {
  id: string;
  /** What the action does, e.g. "Open a shell on home-ax3". */
  label: string;
  /** The heading it is listed under: Open, Panes, Favourites, … */
  group: string;
  icon?: ReactNode;
  run: () => void;
}

/** Actions whose label or group holds every word of the query, in any order. */
export function filterActions(actions: PaletteAction[], query: string): PaletteAction[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return actions;
  return actions.filter((action) => {
    const text = `${action.label} ${action.group}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

export function CommandPalette({
  actions,
  onClose,
}: {
  actions: PaletteAction[];
  onClose: () => void;
}): ReactNode {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  // "?" starts a question: known commands and MCP tools whose words match it.
  const asking = query.startsWith("?");
  const [answers, setAnswers] = useState<PaletteAction[]>([]);
  useEffect(() => {
    if (card.current) return popIn(card.current, card.current.querySelectorAll(".term-pal-i"));
  }, []);
  useEffect(() => {
    const question = query.slice(1).trim();
    if (!asking || question.length < 3) {
      setAnswers([]);
      return;
    }
    const abort = new AbortController();
    const timer = setTimeout(() => {
      terminalApi
        .suggest(question, abort.signal)
        .then((found) =>
          setAnswers([
            ...found.commands.map((command) => ({
              id: `cmd:${command}`,
              label: command,
              group: "Put in the input",
              icon: <SquareTerminal size={14} />,
              run: () =>
                (paneRegistry.get(workspace.activePane) ?? paneRegistry.all()[0])?.insert(command),
            })),
            ...found.tools.map((tool) => ({
              id: `tool:${tool.name}`,
              label: `${tool.title} (${tool.name})`,
              group: "MCP tool · copy name",
              icon: <Wrench size={14} />,
              run: () => void navigator.clipboard.writeText(tool.name),
            })),
          ]),
        )
        .catch(() => {});
    }, 250);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [query, asking]);
  const shown = useMemo(
    () => (asking ? answers : filterActions(actions, query).slice(0, 60)),
    [actions, query, asking, answers],
  );
  const marked = Math.min(index, Math.max(0, shown.length - 1));
  // Listed under their group headings, in the order the groups first appear.
  const grouped = useMemo(() => {
    const byGroup = new Map<string, { action: PaletteAction; at: number }[]>();
    shown.forEach((action, at) =>
      byGroup.set(action.group, [...(byGroup.get(action.group) ?? []), { action, at }]),
    );
    return [...byGroup];
  }, [shown]);

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [marked]);

  const choose = (action: PaletteAction | undefined): void => {
    if (!action) return;
    onClose();
    action.run();
  };

  return (
    <div
      className="term-modal term-pal-back"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="term-pal" ref={card}>
        <label className="term-pal-in">
          <Search size={15} />
          {/* kit-exempt: command palette search, drives the result list keys */}
          <input
            ref={field}
            // eslint-disable-next-line jsx-a11y/no-autofocus -- the palette opens on a key press
            autoFocus
            value={query}
            placeholder="Type an action, a router or a favourite"
            spellCheck={false}
            aria-label="Search actions"
            onChange={(event) => {
              setQuery(event.target.value);
              setIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
              else if (event.key === "Enter") choose(shown[marked]);
              else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const size = shown.length || 1;
                setIndex((marked + (event.key === "ArrowDown" ? 1 : -1) + size) % size);
              }
            }}
          />
          <Kbd>Esc</Kbd>
        </label>
        <div ref={list} role="listbox" aria-label="Actions" className="term-pal-list">
          {shown.length === 0 && (
            <p className="term-pal-empty">
              {asking
                ? "Type what you want to do. Matching is by words: earlier commands, favourites and MCP tools."
                : "No action matches."}
            </p>
          )}
          {grouped.map(([group, items]) => (
            <div key={group} role="group" aria-label={group}>
              <div className="term-pal-g">{group}</div>
              {items.map(({ action, at }) => (
                <div
                  key={action.id}
                  role="option"
                  tabIndex={-1}
                  aria-selected={at === marked}
                  className="term-pal-i"
                  onMouseEnter={() => setIndex(at)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    choose(action);
                  }}
                >
                  {action.icon}
                  <span className="t">{action.label}</span>
                  {at === marked && <span className="m">↵</span>}
                </div>
              ))}
            </div>
          ))}
          {!asking && (
            <>
              <div className="term-pal-g">Ask</div>
              <div
                role="option"
                tabIndex={-1}
                aria-selected={false}
                className="term-pal-i"
                onMouseDown={(event) => {
                  event.preventDefault();
                  setQuery("? ");
                  field.current?.focus();
                }}
              >
                <CircleHelp size={14} />
                <span className="t">Type ? and a question: “? show wifi clients”</span>
                <span className="m">router commands and MCP tools</span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
