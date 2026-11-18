/**
 * Splits a GitHub release body into the sections the release notes dialog
 * shows: one per `##` heading, with the `###` headings inside it as features.
 *
 * The HTML comes from `renderMarkdown`, which escapes the body first. The
 * changes made here add only our own markup to that escaped HTML.
 */
import { renderMarkdown } from "./markdown";

export type SectionKind = "features" | "fixes" | "settings" | "upgrade" | "limits" | "plain";

export interface ReleaseFeature {
  id: string;
  /** Plain text, for the rail. */
  title: string;
  /** The heading with its inline code, escaped. */
  titleHtml: string;
  html: string;
}

export interface ReleaseSection {
  id: string;
  /** "01", "02", … */
  index: string;
  title: string;
  /** A shorter label for the phone chips: "Upgrade notes" → "Upgrade". */
  short: string;
  kind: SectionKind;
  /** Features, list items or table rows; null when the section has none. */
  count: number | null;
  introHtml: string;
  features: ReleaseFeature[];
}

export interface ParsedRelease {
  introHtml: string;
  sections: ReleaseSection[];
  /** From the "Full changelog" compare link, when the body has one. */
  previousVersion: string | null;
  /** Reading time at about 220 words a minute. */
  minutes: number;
}

const KEY = /<code>(↑|↓|←|→|Esc|Enter|Tab|(?:Ctrl|Cmd|Alt|Shift)\+[^<]{1,12})<\/code>/g;
const COMPARE =
  /<p><strong>Full changelog:<\/strong>\s*<a href="(https:\/\/[^"]+\/compare\/v?([^"]+?)\.\.\.v?([^"]+?))"[^>]*>[^<]*<\/a><\/p>/i;

const COPY_ICON =
  '<svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

function kindOf(title: string, hasFeatures: boolean): SectionKind {
  if (/upgrade/i.test(title)) return "upgrade";
  if (/fix/i.test(title)) return "fixes";
  if (/limit/i.test(title)) return "limits";
  if (/setting/i.test(title)) return "settings";
  return hasFeatures ? "features" : "plain";
}

function shortTitle(title: string): string {
  const words = title.split(/\s+/).filter((w) => !/^(new|known|notes)$/i.test(w));
  return words.length > 0 ? words.join(" ").replace(/^./, (c) => c.toUpperCase()) : title;
}

/** Adds the dialog's markup to rendered HTML. */
function enhance(html: string, kind: SectionKind): string {
  let out = html
    // A paragraph that is only bold text is a small heading ("While you type").
    .replace(/<p><strong>([^<]+)<\/strong><\/p>/g, '<p class="rn-h4">$1</p>')
    // "**Blocks** — each command…" reads as "Blocks: each command…".
    .replace(/<\/strong> — /g, "</strong>: ")
    .replace(KEY, "<kbd>$1</kbd>")
    .replace(/<div class="wn-table-wrap">/g, '<div class="rn-set">')
    .replace(/(?:<p>)?<pre><code>([\s\S]*?)<\/code><\/pre>(?:<\/p>)?/g, (_, code: string) =>
      code.includes("\n")
        ? `<div class="rn-cmd rn-cmd-multi"><pre><code>${code}</code></pre><button type="button" class="monitor-btn" data-variant="ghost" data-size="sm" data-copy>${COPY_ICON}Copy</button></div>`
        : `<div class="rn-cmd"><span class="rn-cmd-pr" aria-hidden="true">$</span><code>${code}</code><button type="button" class="monitor-btn" data-variant="ghost" data-size="sm" data-copy>${COPY_ICON}Copy</button></div>`,
    )
    .replace(
      COMPARE,
      (_, href: string, from: string, to: string) =>
        `<p><a class="rn-lnk" href="${href}" target="_blank" rel="noopener noreferrer">Full changelog: ${from} → ${to}</a></p>`,
    );
  if (kind === "fixes") {
    // "**HTTP:** a server…" becomes a scope tag and a sentence.
    out = out.replace(
      /<li><strong>([^<]{1,16}):<\/strong>\s*(\S)/g,
      (_, scope: string, first: string) =>
        `<li><span class="rn-scope">${scope}</span>${first.toUpperCase()}`,
    );
  }
  if (kind === "upgrade") {
    out = out.replace(
      /<ul>/,
      '<div class="rn-callout"><p class="rn-callout-hd">Read before you update</p><ul>',
    );
    const end = out.lastIndexOf("</ul>");
    if (out.includes("rn-callout") && end >= 0)
      out = `${out.slice(0, end)}</ul></div>${out.slice(end + 5)}`;
  }
  return out;
}

function topLevelItems(html: string): number {
  return (html.match(/<li[ >]/g) ?? []).length;
}

export function parseRelease(body: string): ParsedRelease {
  const md = body.replace(/\r\n?/g, "\n").replace(/^\s*# [^\n]*\n/, "");
  const words = md.split(/\s+/).filter(Boolean).length;
  const parts = md.split(/^## (.+)$/m);
  const intro = parts[0]?.trim() ?? "";
  let previousVersion: string | null = null;
  const sections: ReleaseSection[] = [];

  for (let i = 1; i < parts.length; i += 2) {
    const title = parts[i]!.trim();
    const content = parts[i + 1] ?? "";
    const chunks = content.split(/^### (.+)$/m);
    const n = sections.length;
    const featureTitles: string[] = [];
    for (let j = 1; j < chunks.length; j += 2) featureTitles.push(chunks[j]!.trim());
    const kind = kindOf(title, featureTitles.length > 0);
    const render = (s: string): string => {
      const html = enhance(renderMarkdown(s), kind);
      const m = COMPARE.exec(renderMarkdown(s));
      if (m) previousVersion = m[2]!;
      return html;
    };
    const introHtml = render(chunks[0] ?? "");
    const features = featureTitles.map((t, j) => ({
      id: `rn-f-${n}-${j}`,
      title: t.replace(/`/g, ""),
      titleHtml: renderMarkdown(t).replace(/^<p>|<\/p>$/g, ""),
      html: render(chunks[j * 2 + 2] ?? ""),
    }));
    const rows = (introHtml.match(/<tr>/g) ?? []).length;
    const count =
      features.length > 0
        ? features.length
        : rows > 1
          ? rows - 1
          : topLevelItems(introHtml) || null;
    sections.push({
      id: `rn-s-${n}`,
      index: String(n + 1).padStart(2, "0"),
      title,
      short: shortTitle(title),
      kind,
      count,
      introHtml,
      features,
    });
  }

  return {
    introHtml: intro ? enhance(renderMarkdown(intro), "plain") : "",
    sections,
    previousVersion,
    minutes: Math.max(1, Math.round(words / 220)),
  };
}

/** "today", "yesterday", "3 days ago", or "" after a month. */
export function releasedAgo(iso: string, now = Date.now()): string {
  // Calendar days in local time, so last evening is "yesterday".
  const day = (t: number): number => {
    const d = new Date(t);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000;
  };
  const days = day(now) - day(new Date(iso).getTime());
  if (Number.isNaN(days) || days < 0 || days > 30) return "";
  return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(-days, "day");
}
