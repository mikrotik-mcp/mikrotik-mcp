import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { CodeBlock, Pre } from "fumadocs-ui/components/codeblock";
import { ImageZoom } from "fumadocs-ui/components/image-zoom";

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    img: ({ ref: _ref, ...props }) => {
      // MDX turns local images into static imports before this component runs.
      const src =
        typeof props.src === "string"
          ? props.src
          : props.src && "src" in props.src
            ? String(props.src.src)
            : undefined;
      return src ? (
        <span className="screenshot-frame">
          <ImageZoom src={src} alt={props.alt ?? "Dashboard screenshot"}>
            <defaultMdxComponents.img {...props} />
          </ImageZoom>
          <span className="screenshot-caption">
            <span>{props.alt}</span>
            <span>Full page · Click to enlarge ↗</span>
          </span>
        </span>
      ) : (
        <defaultMdxComponents.img {...props} />
      );
    },
    pre: ({ ref: _ref, ...props }) => (
      <CodeBlock keepBackground {...props}>
        <Pre>{props.children}</Pre>
      </CodeBlock>
    ),
    ...components,
  };
}
