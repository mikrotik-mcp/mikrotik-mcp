/**
 * The xterm.js colours of a console, read from the page's CSS variables so the
 * shell and the recording player follow the dashboard theme. terminal.css sets
 * the variables (`--cons`, `--term-ansi-*`) for light and dark.
 */
import type { ITheme, Terminal } from "@xterm/xterm";

const ANSI = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

const kebab = (name: string): string => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

export function xtermTheme(element: Element): ITheme {
  const style = getComputedStyle(element);
  const ink = (name: string): string => style.getPropertyValue(name).trim();
  const theme: ITheme = {
    background: ink("--cons"),
    foreground: ink("--text-secondary"),
    cursor: ink("--sig"),
    cursorAccent: ink("--cons"),
    selectionBackground: ink("--term-select"),
  };
  for (const name of ANSI)
    (theme as Record<string, string>)[name] = ink(`--term-ansi-${kebab(name)}`);
  return theme;
}

export function xtermFont(element: Element): string {
  return getComputedStyle(element).getPropertyValue("--font-mt").trim() || "monospace";
}

/** Repaints the terminal when the dashboard switches between light and dark. */
export function followTheme(term: Terminal, element: Element): () => void {
  const observer = new MutationObserver(() => {
    // The class is set before the new colours resolve; read them on the next frame.
    requestAnimationFrame(() => {
      term.options.theme = xtermTheme(element);
    });
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}
