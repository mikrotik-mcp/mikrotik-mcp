/**
 * Find bar for the terminal page: search the commands and output of one pane
 * or of every pane, with match case, whole words, regular expressions, a
 * result counter, next/previous and a filter that hides blocks without a match.
 *
 * Matches are painted with the CSS Custom Highlight API, which marks text
 * ranges without changing the DOM, so the panes render exactly as before.
 */
import { ChevronDown, ChevronUp, Filter, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { SearchInput } from "./kit";
import { workspace } from "./terminal-lib";

export interface FindOptions {
  matchCase: boolean;
  words: boolean;
  regex: boolean;
}

/** The search pattern, `null` for an empty query, or `"invalid"` for a bad regex. */
export function buildPattern(query: string, options: FindOptions): RegExp | null | "invalid" {
  if (!query) return null;
  let source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (options.words) source = `\\b(?:${source})\\b`;
  try {
    return new RegExp(source, options.matchCase ? "g" : "gi");
  } catch {
    return "invalid";
  }
}

/** Start and end offsets of every match in `text` (empty matches skipped). */
export function findMatches(text: string, pattern: RegExp, limit = 5000): [number, number][] {
  const found: [number, number][] = [];
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    if (!match[0]) continue;
    found.push([match.index, match.index + match[0].length]);
    if (found.length >= limit) break;
  }
  return found;
}

const SEARCHED = ".term-blk-h .cmd, .term-blk-o";
const MISS = "data-find-miss";
const highlights = (): HighlightRegistry | undefined =>
  typeof CSS !== "undefined" && "highlights" in CSS ? CSS.highlights : undefined;

/** Ranges of every match inside one element, which may hold many text nodes. */
function rangesIn(element: Element, pattern: RegExp, budget: number): Range[] {
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = "";
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text);
    starts.push(text.length);
    text += node.nodeValue ?? "";
  }
  if (!text) return [];
  // Offset in the joined text -> the text node that holds it.
  const locate = (offset: number, isEnd: boolean): [Text, number] | undefined => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const start = starts[i] ?? 0;
      if (offset > start || (!isEnd && offset === start)) {
        const node = nodes[i];
        return node ? [node, offset - start] : undefined;
      }
    }
    const first = nodes[0];
    return first ? [first, 0] : undefined;
  };
  const ranges: Range[] = [];
  for (const [from, to] of findMatches(text, pattern, budget)) {
    const a = locate(from, false);
    const b = locate(to, true);
    if (!a || !b) continue;
    const range = document.createRange();
    range.setStart(a[0], a[1]);
    range.setEnd(b[0], b[1]);
    ranges.push(range);
  }
  return ranges;
}

function clearMarks(): void {
  highlights()?.delete("term-find");
  highlights()?.delete("term-find-active");
  for (const block of document.querySelectorAll(`.term-blk[${MISS}]`)) block.removeAttribute(MISS);
}

export function FindBar({
  onClose,
  focus,
}: {
  onClose: () => void;
  /** Changes when the bar must take the focus again (Ctrl+F while open). */
  focus: number;
}): ReactNode {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<FindOptions>({
    matchCase: false,
    words: false,
    regex: false,
  });
  const [everyPane, setEveryPane] = useState(false);
  const [filter, setFilter] = useState(false);
  const [total, setTotal] = useState(0);
  const [index, setIndex] = useState(0);
  const [invalid, setInvalid] = useState(false);
  const ranges = useRef<Range[]>([]);
  const position = useRef(0);
  const field = useRef<HTMLDivElement>(null);

  const paint = useCallback((at: number, reveal: boolean): void => {
    const all = ranges.current;
    const registry = highlights();
    if (!all.length) {
      registry?.delete("term-find-active");
      return;
    }
    const current = all[Math.min(at, all.length - 1)];
    if (!current) return;
    registry?.set("term-find-active", new Highlight(current));
    if (reveal)
      current.startContainer.parentElement?.scrollIntoView({ block: "center", inline: "nearest" });
  }, []);

  /** Search again. `keep` holds the current result position (output is still arriving). */
  const search = useCallback(
    (keep: boolean): void => {
      clearMarks();
      const pattern = buildPattern(query, options);
      setInvalid(pattern === "invalid");
      const found: Range[] = [];
      if (pattern && pattern !== "invalid") {
        const panes = Array.from(document.querySelectorAll<HTMLElement>(".term-pane"));
        const scope = everyPane
          ? panes
          : panes.filter((pane) => pane.dataset.paneId === workspace.activePane).slice(0, 1);
        for (const pane of scope.length ? scope : panes.slice(0, 1)) {
          for (const block of pane.querySelectorAll(".term-blk")) {
            const before = found.length;
            for (const target of block.querySelectorAll(SEARCHED))
              found.push(...rangesIn(target, pattern, 5000 - found.length));
            if (filter && found.length === before) block.setAttribute(MISS, "");
          }
        }
      }
      ranges.current = found;
      if (found.length) highlights()?.set("term-find", new Highlight(...found));
      position.current = keep ? Math.min(position.current, Math.max(0, found.length - 1)) : 0;
      setTotal(found.length);
      setIndex(position.current);
      paint(position.current, !keep);
    },
    [query, options, everyPane, filter, paint],
  );

  // Search when the query or an option changes, and again when panes change.
  useEffect(() => {
    search(false);
    const dock = document.querySelector(".term-dock");
    if (!dock) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => search(true), 150);
    });
    observer.observe(dock, { subtree: true, childList: true, characterData: true });
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [search]);
  useEffect(() => {
    const input = field.current?.querySelector("input");
    input?.focus();
    input?.select();
  }, [focus]);
  useEffect(() => clearMarks, []);

  const step = (delta: number): void => {
    const count = ranges.current.length;
    if (!count) return;
    position.current = (position.current + delta + count) % count;
    setIndex(position.current);
    paint(position.current, true);
  };
  const toggle = (name: keyof FindOptions): void =>
    setOptions((current) => ({ ...current, [name]: !current[name] }));

  return (
    <div className="term-findb" role="search" data-invalid={invalid || undefined}>
      <div ref={field} className="term-findb-f">
        <SearchInput
          size="sm"
          mono
          invalid={invalid}
          value={query}
          placeholder="Find in the output"
          spellCheck={false}
          label="Find in terminals"
          onChange={setQuery}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              step(event.shiftKey ? -1 : 1);
            } else if (event.key === "Escape") onClose();
          }}
        />
      </div>
      <span className="c" data-empty={(Boolean(query) && total === 0) || undefined}>
        {invalid
          ? "bad pattern"
          : total === 0
            ? "0 / 0"
            : `${index + 1} / ${total}${total >= 5000 ? "+" : ""}`}
      </span>
      <button
        type="button"
        className="o"
        aria-pressed={options.matchCase}
        onClick={() => toggle("matchCase")}
        title="Match case"
      >
        Aa
      </button>
      <button
        type="button"
        className="o"
        aria-pressed={options.words}
        onClick={() => toggle("words")}
        title="Whole words"
      >
        W
      </button>
      <button
        type="button"
        className="o"
        aria-pressed={options.regex}
        onClick={() => toggle("regex")}
        title="Regular expression"
      >
        .*
      </button>
      <button
        type="button"
        className="o"
        aria-pressed={everyPane}
        onClick={() => setEveryPane((on) => !on)}
        title={everyPane ? "Searching every console" : "Searching the active console"}
      >
        All terminals
      </button>
      <button
        type="button"
        className="term-ib"
        aria-pressed={filter}
        data-on={filter || undefined}
        onClick={() => setFilter((on) => !on)}
        title="Show only the blocks that match"
        aria-label="Show only the blocks that match"
      >
        <Filter size={14} />
      </button>
      <button
        type="button"
        className="term-ib"
        onClick={() => step(-1)}
        disabled={!total}
        title="Previous (Shift+Enter)"
        aria-label="Previous"
      >
        <ChevronUp size={15} />
      </button>
      <button
        type="button"
        className="term-ib"
        onClick={() => step(1)}
        disabled={!total}
        title="Next (Enter)"
        aria-label="Next"
      >
        <ChevronDown size={15} />
      </button>
      <button
        type="button"
        className="term-ib"
        onClick={onClose}
        title="Close (Esc)"
        aria-label="Close"
      >
        <X size={15} />
      </button>
    </div>
  );
}
