/**
 * Table view of a `print` output: the same text, parsed into rows that sort by
 * a column and filter by a word. The parser is the one the MCP App views use.
 */
import { ArrowDown, ArrowUp } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { parseRecords } from "../../src/core/routeros-parse";

/** Numbers sort as numbers ("10" after "9"), everything else as text. */
function compare(a: string, b: string): number {
  const x = Number.parseFloat(a);
  const y = Number.parseFloat(b);
  if (!Number.isNaN(x) && !Number.isNaN(y) && x !== y) return x - y;
  return a.localeCompare(b, undefined, { numeric: true });
}

/** True when the output parses into at least one record. */
export function hasRecords(output: string): boolean {
  return parseRecords(output).rows.length > 0;
}

export function RecordTable({ output }: { output: string }): ReactNode {
  const parsed = useMemo(() => parseRecords(output), [output]);
  const [sort, setSort] = useState<{ column: string; down: boolean } | null>(null);
  const [filter, setFilter] = useState("");
  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const kept = needle
      ? parsed.rows.filter((row) =>
          Object.values(row).some((value) => value.toLowerCase().includes(needle)),
        )
      : parsed.rows;
    if (!sort) return kept;
    const ordered = kept.toSorted((a, b) => compare(a[sort.column] ?? "", b[sort.column] ?? ""));
    return sort.down ? ordered.reverse() : ordered;
  }, [parsed.rows, sort, filter]);

  if (!parsed.rows.length) return <div className="term-empty">This output has no table form.</div>;
  return (
    <div className="term-table">
      <div className="term-table-tools">
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter rows…"
          spellCheck={false}
          aria-label="Filter rows"
        />
        <span>
          {rows.length} of {parsed.rows.length} rows
        </span>
      </div>
      <div className="term-table-scroll">
        <table>
          <thead>
            <tr>
              {parsed.columns.map((column) => (
                <th key={column}>
                  <button
                    type="button"
                    onClick={() =>
                      setSort((current) =>
                        current?.column !== column
                          ? { column, down: false }
                          : current.down
                            ? null
                            : { column, down: true },
                      )
                    }
                  >
                    {column}
                    {sort?.column === column &&
                      (sort.down ? <ArrowDown size={11} /> : <ArrowUp size={11} />)}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              // eslint-disable-next-line react/no-array-index-key -- rows have no identity
              <tr key={i}>
                {parsed.columns.map((column) => (
                  <td key={column}>{row[column] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
