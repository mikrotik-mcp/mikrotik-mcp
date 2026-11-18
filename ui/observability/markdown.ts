/**
 * A small markdown → HTML renderer for GitHub release bodies.
 *
 * Pure and dependency-free (no React, no DOM) so `tests/markdown.spec.ts` can
 * exercise it offline. `whats-new.tsx` injects the result as raw HTML, so
 * **every `&`, `<` and `>` is escaped up front** (step 1, before any other
 * transform) and no markup from the release body can survive into the output.
 * Only the tags this module itself emits reach the DOM.
 *
 * Every block construct tolerates up to three leading spaces, as CommonMark
 * requires. That is not a nicety: real release bodies are often authored inside
 * an indented template literal, so the body arrives uniformly indented —
 *
 *     '## v4.3.0\n\n  ### ✨ Features\n\n  - OSPF: …'
 *
 * — and an `^###`-anchored regex silently drops every heading, list, table and
 * rule onto the paragraph path, rendering a literal `###` to the user. Dedenting
 * by the common indent would not have helped: the one unindented line (`##`)
 * pins that common indent at zero.
 */

/** Up to three spaces may precede a block marker (CommonMark §4). */
const IND = " {0,3}";

export interface MarkdownOptions {
  /**
   * A written document, not a release body: wrapped lines join into one
   * paragraph, `_text_` is emphasis, and a list item indented by two spaces or
   * more is a sub-item (`<li class="md-sub">`).
   */
  document?: boolean;
}

export function renderMarkdown(md: string, options: MarkdownOptions = {}): string {
  const doc = options.document === true;
  // 0. Normalize line endings (the GitHub API returns \r\n).
  let html = md.replace(/\r\n?/g, "\n");

  // 1. Escape HTML entities — this is the whole injection story for the modal.
  html = html.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // 2. Fenced code blocks — extract before any inline processing.
  const codeBlocks: string[] = [];
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, _lang: string, code: string) => {
    codeBlocks.push(`<pre><code>${code.trim()}</code></pre>`);
    return `%%CB${codeBlocks.length - 1}%%`;
  });

  // 3. Inline code — protect from further transforms.
  const inlines: string[] = [];
  html = html.replace(/`([^`]+)`/g, (_, code: string) => {
    inlines.push(`<code>${code}</code>`);
    return `%%IC${inlines.length - 1}%%`;
  });

  // 4. Images: ![alt](url)
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1"/>');

  // 5. Links: [text](url)
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>',
  );

  // 5b. Auto-link bare URLs not already inside an href or src attribute.
  html = html.replace(
    /(?<!=["'])(https?:\/\/[^\s<>")\]]+)/g,
    '<a href="$1" target="_blank" rel="noopener">$1</a>',
  );

  // 6. Bold + italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");

  if (doc) html = html.replace(/(?<![\w*])_([^_\n]+)_(?!\w)/g, "<em>$1</em>");

  // 7. Strikethrough
  html = html.replace(/~~(.+?)~~/g, "<del>$1</del>");

  // 8. Headings — deepest first, so `###` isn't consumed by the `#` rule.
  html = html.replace(new RegExp(`^${IND}#### (.+)$`, "gm"), "<h5>$1</h5>");
  html = html.replace(new RegExp(`^${IND}### (.+)$`, "gm"), "<h4>$1</h4>");
  html = html.replace(new RegExp(`^${IND}## (.+)$`, "gm"), "<h3>$1</h3>");
  html = html.replace(new RegExp(`^${IND}# (.+)$`, "gm"), "<h2>$1</h2>");

  // 9. Blockquotes (`>` became `&gt;` in step 1)
  html = html.replace(new RegExp(`^${IND}&gt; (.+)$`, "gm"), "<blockquote>$1</blockquote>");
  html = html.replace(/<\/blockquote>\n<blockquote>/g, "\n");

  // 10. Horizontal rules: ---, ***, ___
  html = html.replace(new RegExp(`^${IND}(?:-{3,}|\\*{3,}|_{3,})\\s*$`, "gm"), "<hr/>");

  // 11. Tables: | col | col | with an optional alignment row
  html = html.replace(new RegExp(`((?:^${IND}\\|.+\\|\\n?)+)`, "gm"), (block: string) => {
    const rows = block.trim().split("\n").filter(Boolean);
    if (rows.length < 2) return block;
    const parseRow = (r: string): string[] =>
      r
        .trim()
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
    const headerCells = parseRow(rows[0]!);
    const isAlign = /^(\|[\s:*-]+)+\|$/.test(rows[1]!.trim().replace(/[^|:*-\s]/g, ""));
    const alignRow = isAlign ? parseRow(rows[1]!) : null;
    const aligns = alignRow
      ? alignRow.map((c) => {
          if (c.startsWith(":") && c.endsWith(":")) return "center";
          if (c.endsWith(":")) return "right";
          return "left";
        })
      : headerCells.map(() => "left" as const);
    const bodyRows = rows.slice(isAlign ? 2 : 1);
    let t = '<div class="wn-table-wrap"><table><thead><tr>';
    for (let i = 0; i < headerCells.length; i++)
      t += `<th style="text-align:${aligns[i]}">${headerCells[i]}</th>`;
    t += "</tr></thead><tbody>";
    for (const row of bodyRows) {
      const cells = parseRow(row);
      t += "<tr>";
      for (let i = 0; i < headerCells.length; i++)
        t += `<td style="text-align:${aligns[i]}">${cells[i] ?? ""}</td>`;
      t += "</tr>";
    }
    return `${t}</tbody></table></div>`;
  });

  // 12. Ordered lists
  html = html.replace(new RegExp(`^${IND}(\\d+)\\. (.+)$`, "gm"), "<oli>$2</oli>");
  html = html.replace(/<\/oli>\n\n+<oli>/g, "</oli>\n<oli>");
  html = html.replace(
    /((?:<oli>.*<\/oli>\n?)+)/g,
    (m) => `<ol>${m.trimEnd().replace(/<\/?oli>/g, (tag) => tag.replace("oli", "li"))}</ol>`,
  );

  // 13. Unordered lists (-, * or +)
  if (doc) html = html.replace(/^ {2,}[-*+] (.+)$/gm, '<li class="md-sub">$1</li>');
  html = html.replace(new RegExp(`^${IND}[-*+] (.+)$`, "gm"), "<li>$1</li>");
  html = html.replace(/<\/li>\n\n+<li>/g, "</li>\n<li>");
  html = html.replace(/((?:<li[^>]*>.*<\/li>\n?)+)/g, (m) => `<ul>${m.trimEnd()}</ul>`);

  // 14. Task lists
  html = html.replace(
    /<li>\[x\] (.+?)<\/li>/gi,
    '<li class="wn-task done"><span class="wn-check">&#10003;</span> $1</li>',
  );
  html = html.replace(
    /<li>\[ \] (.+?)<\/li>/g,
    '<li class="wn-task"><span class="wn-check">&#9744;</span> $1</li>',
  );

  // 15. Paragraphs for whatever is left.
  const block = /^<\/?(h[2-5]|ul|ol|li|pre|blockquote|hr|div|table|img)/;
  const out: string[] = [];
  let open = false; // the last entry of `out` is a paragraph that can take more text
  for (const line of html.split("\n")) {
    const t = line.trim();
    if (!t || block.test(t) || (doc && t.startsWith("%%CB"))) {
      out.push(t);
      open = false;
    } else if (doc && open) {
      out[out.length - 1] = `${out.at(-1)!.slice(0, -4)} ${t}</p>`;
    } else {
      out.push(`<p>${t}</p>`);
      open = true;
    }
  }
  html = out.join("\n");

  // 16. Restore code blocks and inline code.
  html = html.replace(/%%CB(\d+)%%/g, (_, i: string) => codeBlocks[Number(i)]!);
  html = html.replace(/%%IC(\d+)%%/g, (_, i: string) => inlines[Number(i)]!);

  return html;
}
