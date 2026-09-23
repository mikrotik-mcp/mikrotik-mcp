/** Shared unified-diff classification for DOM App Views and React dashboards. */
export function diffKind(line: string): string {
  if (/^(--- |\+\+\+ |diff --git |index )/.test(line)) return "file";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

export function isUnifiedDiff(text: string): boolean {
  return /^@@ /m.test(text) || (/^--- /m.test(text) && /^\+\+\+ /m.test(text));
}

/** Text nodes only: router-supplied diff content is never interpreted as HTML. */
export function diffElement(text: string): HTMLElement {
  const pre = document.createElement("pre");
  pre.className = "github-diff";
  pre.tabIndex = 0;
  pre.setAttribute("aria-label", "Configuration diff");
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const row = document.createElement("div");
    row.className = `github-diff-line diff-${diffKind(line)}`;
    row.textContent = line;
    pre.append(row);
  }
  return pre;
}
