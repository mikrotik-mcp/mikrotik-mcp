import type { ReactNode } from "react";
import { diffKind } from "../shared/diff";
import "../shared/diff.css";

export function UnifiedDiff({
  unified,
  maxHeight = 500,
  renderLine,
}: {
  unified: string;
  maxHeight?: number;
  renderLine?: (line: string) => ReactNode;
}): ReactNode {
  return (
    <pre className="github-diff" tabIndex={0} aria-label="Configuration diff" style={{ maxHeight }}>
      {(unified || "No differences.")
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map((line, i) => (
          <div key={i} className={`github-diff-line diff-${diffKind(line)}`}>
            {renderLine ? renderLine(line) : line}
          </div>
        ))}
    </pre>
  );
}
