import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { api } from "./api";
import { highlightJson } from "./highlight";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

// ── Config types + helpers (shared across the config editor) ─────────────────
export interface ConfigIssue {
  path: string;
  message: string;
}
export interface SchemaHints {
  keys: string[];
  enums: string[];
}
export interface DiffSummary {
  added: number;
  removed: number;
  unchanged: number;
  changed: boolean;
}
export interface SaveResp {
  ok: boolean;
  errors?: ConfigIssue[];
  pendingId?: string;
  rollbackMs?: number;
  path?: string;
  fromFile?: boolean;
  devicesChanged?: boolean;
  summary?: DiffSummary;
  unified?: string;
}

/** Walk a JSON Schema collecting property names and string enum values for hints. */
export function collectHints(schema: unknown): SchemaHints {
  const keys = new Set<string>();
  const enums = new Set<string>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (n.properties && typeof n.properties === "object") {
      for (const k of Object.keys(n.properties)) {
        keys.add(k);
        walk((n.properties as Record<string, unknown>)[k]);
      }
    }
    if (Array.isArray(n.enum)) for (const e of n.enum) if (typeof e === "string") enums.add(e);
    for (const f of ["items", "additionalProperties", "anyOf", "oneOf", "allOf"]) {
      const v = n[f];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") walk(v);
    }
    for (const f of ["$defs", "definitions", "patternProperties"]) {
      const v = n[f];
      if (v && typeof v === "object") for (const sub of Object.values(v)) walk(sub);
    }
  };
  walk(schema);
  return { keys: [...keys].sort(), enums: [...enums.add("true").add("false")].sort() };
}

/** The word being typed at the caret + whether we're after a `:` (a value position). */
export function wordAtCaret(
  text: string,
  caret: number,
): { word: string; start: number; isValue: boolean } {
  let start = caret;
  while (start > 0 && /[A-Za-z0-9_.-]/.test(text[start - 1])) start--;
  const word = text.slice(start, caret);
  let i = start - 1;
  while (i >= 0 && /\s/.test(text[i])) i--;
  return { word, start, isValue: text[i] === ":" };
}

export const ROLLBACK_OPTS: [string, number][] = [
  ["revert in 30s", 30_000],
  ["revert in 60s", 60_000],
  ["revert in 2m", 120_000],
  ["no auto-revert", 0],
];

/**
 * JSON mode of the config editor: a schema-autocompleting, syntax-highlighted
 * textarea, **controlled** by the parent's `cfg` object. Initializes its text
 * from `value` on mount (the parent remounts it when entering JSON mode), emits
 * the parsed object via `onChange` on every valid edit, and reports JSON syntax
 * errors via `onJsonError` so the parent can gate Save. Schema validation, device
 * tests, preview and safe-apply all live in `config-editor.tsx`.
 */
export function JsonEditor({
  value,
  onChange,
  onJsonError,
}: {
  value: unknown;
  onChange: (obj: unknown) => void;
  onJsonError?: (err: string | null) => void;
}): ReactNode {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [hints, setHints] = useState<SchemaHints>({ keys: [], enums: [] });
  const [ac, setAc] = useState<{
    items: string[];
    index: number;
    start: number;
    x: number;
    y: number;
  } | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const caretRef = useRef<number | null>(null);
  const hlRef = useRef<HTMLPreElement | null>(null);
  const gutterRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    void api<unknown>("/api/config-schema")
      .then((s) => setHints(collectHints(s)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (caretRef.current != null && taRef.current) {
      taRef.current.selectionStart = taRef.current.selectionEnd = caretRef.current;
      caretRef.current = null;
    }
  });

  // Parse-on-valid → emit the object; report syntax errors.
  const onChangeRef = useRef(onChange);
  const onErrRef = useRef(onJsonError);
  useLayoutEffect(() => {
    onChangeRef.current = onChange;
    onErrRef.current = onJsonError;
  }, [onChange, onJsonError]);
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        const obj = JSON.parse(text);
        onErrRef.current?.(null);
        onChangeRef.current(obj);
      } catch (e) {
        onErrRef.current?.(e instanceof Error ? e.message : String(e));
      }
    }, 300);
    return () => clearTimeout(t);
  }, [text]);

  const refreshAc = (el: HTMLTextAreaElement): void => {
    const { word, start, isValue } = wordAtCaret(el.value, el.selectionStart);
    if (word.length < 1) {
      setAc(null);
      return;
    }
    const pool = isValue ? hints.enums : hints.keys;
    const items = pool.filter((k) => k.startsWith(word) && k !== word).slice(0, 8);
    if (!items.length) {
      setAc(null);
      return;
    }
    const before = el.value.slice(0, el.selectionStart).split("\n");
    const col = before[before.length - 1].length;
    const x = Math.min(12 + col * 7.22 - el.scrollLeft, el.clientWidth - 160);
    const y = 10 + before.length * 18 - el.scrollTop + 4;
    setAc({ items, index: 0, start, x: Math.max(4, x), y });
  };

  const accept = (completion: string): void => {
    const el = taRef.current;
    if (!el || !ac) return;
    const next = text.slice(0, ac.start) + completion + text.slice(el.selectionStart);
    caretRef.current = ac.start + completion.length;
    setText(next);
    setAc(null);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (!ac) {
      if (e.key === " " && e.ctrlKey) {
        e.preventDefault();
        refreshAc(e.currentTarget);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setAc({ ...ac, index: (ac.index + 1) % ac.items.length });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setAc({ ...ac, index: (ac.index - 1 + ac.items.length) % ac.items.length });
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      accept(ac.items[ac.index]);
    } else if (e.key === "Escape") {
      setAc(null);
    }
  };

  const lines = text.split("\n").length;

  return (
    <div className="border-border bg-background flex max-h-[420px] overflow-hidden rounded-md border">
      <pre
        className="bg-muted text-muted-foreground m-0 min-w-[38px] overflow-hidden px-2 py-2.5 text-right font-mono text-xs leading-[1.5] select-none"
        aria-hidden="true"
        ref={gutterRef}
      >
        {Array.from({ length: lines }, (_, i) => i + 1).join("\n")}
      </pre>
      <div className="relative flex-1">
        <pre
          className="text-muted-foreground pointer-events-none absolute inset-0 z-0 m-0 box-border overflow-hidden px-3 py-2.5 font-mono text-xs leading-[1.5] whitespace-pre [tab-size:2] [&_.j-bool]:text-chart-4 [&_.j-key]:text-chart-1 [&_.j-null]:text-muted-foreground [&_.j-num]:text-chart-3 [&_.j-str]:text-chart-2"
          aria-hidden="true"
          ref={hlRef}
        >
          {highlightJson(text)}
          {"\n"}
        </pre>
        <Textarea
          ref={taRef}
          className="caret-brand selection:bg-brand/35 relative z-[1] m-0 box-border h-[400px] min-h-0 w-full resize-y rounded-none border-0 bg-transparent px-3 py-2.5 font-mono text-xs leading-[1.5] whitespace-pre text-transparent shadow-none [field-sizing:fixed] [tab-size:2] outline-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
          spellCheck={false}
          wrap="off"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            refreshAc(e.currentTarget);
          }}
          onKeyDown={onKeyDown}
          onClick={() => setAc(null)}
          onScroll={(e) => {
            const ta = e.currentTarget;
            if (hlRef.current) {
              hlRef.current.scrollTop = ta.scrollTop;
              hlRef.current.scrollLeft = ta.scrollLeft;
            }
            if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop;
          }}
        />
        {ac && (
          <div
            className="border-brand bg-card absolute z-[5] max-h-[184px] min-w-[150px] overflow-y-auto rounded-md border shadow-lg"
            style={{ left: ac.x, top: ac.y }}
          >
            {ac.items.map((it, i) => (
              <div
                key={it}
                className={cn(
                  "cursor-pointer px-[11px] py-[5px] font-mono text-xs",
                  i === ac.index ? "bg-brand/20 text-foreground" : "text-muted-foreground",
                )}
                onMouseDown={(e) => {
                  e.preventDefault();
                  accept(it);
                }}
              >
                {it}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
