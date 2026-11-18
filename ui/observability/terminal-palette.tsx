/**
 * Command palette (Ctrl+Shift+P): every action of the terminal page in one
 * searchable list, for work without the mouse.
 */
import { Command } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { paneRegistry, terminalApi, workspace } from "./terminal-lib";

export interface PaletteAction {
  id: string;
  /** What the action does, e.g. "Open terminal: home-ax3". */
  label: string;
  /** Group shown on the right: Panes, Favourites, Workspaces, … */
  group: string;
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
  const list = useRef<HTMLUListElement>(null);
  // "?" starts a question: known commands and MCP tools whose words match it.
  const asking = query.startsWith("?");
  const [answers, setAnswers] = useState<PaletteAction[]>([]);
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
              run: () =>
                (paneRegistry.get(workspace.activePane) ?? paneRegistry.all()[0])?.insert(command),
            })),
            ...found.tools.map((tool) => ({
              id: `tool:${tool.name}`,
              label: `${tool.title} (${tool.name})`,
              group: "MCP tool · copy name",
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
      className="term-modal term-palette-back"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="term-palette">
        <label>
          <Command size={15} />
          <input
            // eslint-disable-next-line jsx-a11y/no-autofocus -- the palette opens on a key press
            autoFocus
            value={query}
            placeholder="Type an action, a router, a favourite…  ·  ? to ask in words"
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
        </label>
        <ul ref={list} role="listbox">
          {shown.length === 0 && (
            <li className="term-palette-empty">
              {asking
                ? "Type what you want to do. Matching is by words: earlier commands, favourites and MCP tools."
                : "No action matches."}
            </li>
          )}
          {shown.map((action, i) => (
            <li
              key={action.id}
              role="option"
              aria-selected={i === marked}
              onMouseEnter={() => setIndex(i)}
              onMouseDown={(event) => {
                event.preventDefault();
                choose(action);
              }}
            >
              <span>{action.label}</span>
              <small>{action.group}</small>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
