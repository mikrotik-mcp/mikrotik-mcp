/**
 * RouterOS syntax highlighting for the dashboard terminal.
 *
 * Two sources, both kept:
 *  - Shiki with a vendored RouterOS TextMate grammar: instant, works offline.
 *  - The router itself (`/console/inspect request=highlight`): one token class
 *    per character, the same classes the RouterOS console colours with, and it
 *    marks what that RouterOS version does not accept.
 */
import type { HighlighterCore } from "shiki/core";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import grammar from "./vendor/routeros.tmLanguage.json";

export interface Span {
  text: string;
  /** CSS colour, or undefined for the default ink. */
  color?: string;
  /** The router rejected this part of the input. */
  bad?: boolean;
}

/**
 * Syntax inks, defined in terminal.css (`--term-syn-*`): paths cyan, commands
 * violet, arguments green, close to the RouterOS console.
 */
const ink = (name: string): string => `var(--term-syn-${name})`;
const INK = {
  path: ink("path"),
  command: ink("command"),
  argument: ink("argument"),
  value: ink("value"),
  string: ink("string"),
  number: ink("number"),
  variable: ink("variable"),
  keyword: ink("keyword"),
  operator: ink("operator"),
  comment: ink("comment"),
  punctuation: ink("punctuation"),
  bad: ink("bad"),
};

const theme = {
  name: "routeros-console",
  type: "dark" as const,
  colors: { "editor.foreground": INK.value, "editor.background": "transparent" },
  tokenColors: [
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: INK.comment } },
    { scope: ["entity.name.tag", "meta.prompt"], settings: { foreground: INK.path } },
    {
      scope: ["support.function", "entity.name.function", "keyword.other.where"],
      settings: { foreground: INK.command },
    },
    { scope: ["support.type.property-name"], settings: { foreground: INK.argument } },
    { scope: ["string", "punctuation.definition.string"], settings: { foreground: INK.string } },
    { scope: ["constant.numeric", "constant.language"], settings: { foreground: INK.number } },
    {
      scope: ["variable", "punctuation.definition.variable", "constant.other.placeholder"],
      settings: { foreground: INK.variable },
    },
    { scope: ["keyword.control", "storage.type"], settings: { foreground: INK.keyword } },
    { scope: ["keyword.operator"], settings: { foreground: INK.operator } },
    { scope: ["constant.character.escape"], settings: { foreground: INK.operator } },
    { scope: ["punctuation"], settings: { foreground: INK.punctuation } },
  ],
};

let highlighter: HighlighterCore | undefined;
let loading: Promise<HighlighterCore> | undefined;

/** Load the grammar once. Resolves when {@link staticSpans} can colour text. */
export function loadHighlighter(): Promise<HighlighterCore> {
  loading ??= createHighlighterCore({
    themes: [theme],
    langs: [grammar as never],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  }).then((ready) => (highlighter = ready));
  return loading;
}

/** Grammar-based colouring, one array per line. Plain text until the grammar loads. */
export function staticSpans(code: string): Span[][] {
  if (!highlighter) return code.split("\n").map((text) => [{ text }]);
  try {
    return highlighter
      .codeToTokensBase(code, { lang: "routeros", theme: "routeros-console" })
      .map((line) => line.map((token) => ({ text: token.content, color: token.color })));
  } catch {
    return code.split("\n").map((text) => [{ text }]);
  }
}

/** Colour of each RouterOS console token class. */
const CLASS_INK: Record<string, string | undefined> = {
  dir: INK.path,
  cmd: INK.command,
  arg: INK.argument,
  "arg-scope": INK.argument,
  "arg-dot": INK.argument,
  "syntax-meta": INK.punctuation,
  "syntax-val": INK.value,
  "syntax-noterm": INK.string,
  "syntax-obsolete": INK.comment,
  "syntax-old": INK.comment,
  varname: INK.variable,
  "varname-local": INK.variable,
  "varname-global": INK.variable,
  "varname-param": INK.variable,
  "variable-local": INK.variable,
  "variable-global": INK.variable,
  "variable-parameter": INK.variable,
  variable: INK.variable,
  escaped: INK.operator,
  comment: INK.comment,
  obj: INK.value,
  "obj-disabled": INK.comment,
  none: undefined,
};
const BAD = new Set(["error", "obj-inactive", "ambiguous"]);

/** True when the router marked part of the input as not acceptable. */
export const hasSyntaxError = (tokens: string[]): boolean => tokens.some((t) => BAD.has(t));

/**
 * Colouring from the router's own token classes. `tokens` has one class per
 * UTF-8 byte of `code`; returns `null` when the two do not line up.
 */
export function deviceSpans(code: string, tokens: string[]): Span[][] | null {
  // One class per byte: only trust the mapping for single-byte text.
  // eslint-disable-next-line no-control-regex -- the ASCII range starts at NUL
  if (tokens.length !== code.length || /[^\x00-\x7F]/.test(code)) return null;
  const lines: Span[][] = [[]];
  let run = "";
  let runClass = "";
  const flush = (): void => {
    if (!run) return;
    const bad = BAD.has(runClass);
    lines[lines.length - 1]!.push({ text: run, color: bad ? INK.bad : CLASS_INK[runClass], bad });
    run = "";
  };
  for (let i = 0; i < code.length; i++) {
    const char = code[i]!;
    if (char === "\n") {
      flush();
      lines.push([]);
      continue;
    }
    if (tokens[i] !== runClass) {
      flush();
      runClass = tokens[i] ?? "none";
    }
    run += char;
  }
  flush();
  return lines;
}
