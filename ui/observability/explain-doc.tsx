/**
 * The Explain page's document: the server's Markdown, set as a readable page.
 * A contents rail on the left, numbered sections, severity chips in place of
 * the emoji marks, and the Mermaid block drawn as a diagram.
 */
import type { ReactNode } from "react";
import { useMemo, useRef } from "react";
import { ExplainFlow } from "./explain-flow";
import { renderMarkdown } from "./markdown";

const FLOW = "%%FLOW%%";

interface Section {
  title: string;
  /** HTML pieces; the diagram goes between two of them. */
  parts: string[];
}

interface Doc {
  head: string;
  sections: Section[];
  flow: string;
}

/**
 * Split the rendered document at its `##` headings (`<h3>` once rendered).
 *
 * The HTML is safe to inject: `renderMarkdown` escapes every `&`, `<` and `>`
 * of its input before any other step, so text that comes from the device
 * configuration cannot carry markup. The only tags are the ones the renderer
 * and the fixed severity chip below emit. The diagram source is not HTML at
 * all: `ExplainFlow` draws it as React text nodes.
 */
export function readDoc(markdown: string): Doc {
  let flow = "";
  const text = markdown.replace(/```mermaid\n([\s\S]*?)```/, (_, source: string) => {
    flow = source.trim();
    return `\n${FLOW}\n`;
  });
  const html = renderMarkdown(text, { document: true }).replace(
    /(?:🔴|🟠|🟡|🟢) (critical|high|medium|low)/g,
    '<span class="md-sev" data-sev="$1">$1</span>',
  );
  const [head = "", ...rest] = html.split("<h3>");
  const sections = rest.map((chunk) => {
    const end = chunk.indexOf("</h3>");
    return {
      title: chunk.slice(0, end).replace(/<[^>]+>/g, ""),
      parts: chunk.slice(end + 5).split(`<p>${FLOW}</p>`),
    };
  });
  return { head, sections, flow };
}

export function ExplainDoc({ markdown }: { markdown: string }): ReactNode {
  const doc = useMemo(() => readDoc(markdown), [markdown]);
  const refs = useRef<(HTMLElement | null)[]>([]);
  // See readDoc: the value is escaped renderer output, never raw device text.
  const html = (value: string): ReactNode => (
    <div className="explain-doc-html" dangerouslySetInnerHTML={{ __html: value }} />
  );

  return (
    <div className="explain-doc">
      <nav className="explain-doc-toc" aria-label="Document sections">
        <span className="explain-doc-toc-title">Contents</span>
        {doc.sections.map((section, index) => (
          <button
            key={section.title}
            type="button"
            onClick={() => refs.current[index]?.scrollIntoView({ behavior: "smooth" })}
          >
            <i>{String(index + 1).padStart(2, "0")}</i>
            {section.title}
          </button>
        ))}
      </nav>
      <article className="explain-doc-page">
        <header className="explain-doc-head">{html(doc.head)}</header>
        {doc.sections.map((section, index) => (
          <section
            key={section.title}
            ref={(element) => {
              refs.current[index] = element;
            }}
          >
            <h3>
              <i>{String(index + 1).padStart(2, "0")}</i>
              {section.title}
            </h3>
            {section.parts.map((part, at) => (
              // The parts of a section never reorder.
              // eslint-disable-next-line react/no-array-index-key
              <div key={at} className="contents">
                {at > 0 && doc.flow && <ExplainFlow source={doc.flow} />}
                {html(part)}
              </div>
            ))}
          </section>
        ))}
      </article>
    </div>
  );
}
