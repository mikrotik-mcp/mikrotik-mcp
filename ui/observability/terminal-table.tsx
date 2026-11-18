/**
 * Table view of a `print` output: the same text, parsed into rows that sort by
 * a column and filter by a word. The parser is the one the MCP App views use.
 */
import { ArrowDown, ArrowUp } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { parseRecords } from "../../src/core/routeros-parse";
import { DetailList, RowDrawer, RowMenu, RowMore, SearchInput } from "./kit";

/** Numbers sort as numbers ("10" after "9"), everything else as text. */
function compare(a: string, b: string): number {
  const x = Number.parseFloat(a);
  const y = Number.parseFloat(b);
  if (!Number.isNaN(x) && !Number.isNaN(y) && x !== y) return x - y;
  return a.localeCompare(b, undefined, { numeric: true });
}

/** What a record is called in its menu and drawer: its name, else its id. */
function rowName(row: Record<string, string>, i: number): string {
  return row.name || row["host-name"] || row.address || row[".id"] || `Row ${i + 1}`;
}

/** True when the output parses into at least one record. */
export function hasRecords(output: string): boolean {
  return parseRecords(output).rows.length > 0;
}

export function RecordTable({ output }: { output: string }): ReactNode {
  const parsed = useMemo(() => parseRecords(output), [output]);
  const [sort, setSort] = useState<{ column: string; down: boolean } | null>(null);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<number | null>(null);
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

  const opened = open != null ? rows[open] : undefined;
  const step = (d: 1 | -1): (() => void) | undefined =>
    open != null && rows[open + d] ? () => setOpen(open + d) : undefined;

  if (!parsed.rows.length) return <div className="term-empty">This output has no table form.</div>;
  return (
    <div className="term-table">
      <div className="term-table-tools">
        <SearchInput
          size="sm"
          wrapClassName="w-[180px]"
          value={filter}
          onChange={(v) => {
            setFilter(v);
            setOpen(null);
          }}
          placeholder="Filter rows…"
          spellCheck={false}
          label="Filter rows"
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
              <th aria-hidden="true" className="term-more" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <RowMenu
                // eslint-disable-next-line react/no-array-index-key -- rows have no identity
                key={i}
                title={rowName(row, i)}
                sub={`row ${i + 1} of ${rows.length}`}
                onOpen={() => setOpen(i)}
                cells={Object.fromEntries(
                  parsed.columns.map((column) => [
                    column,
                    {
                      value: row[column] ?? "",
                      search: () => {
                        setFilter(row[column] ?? "");
                        setOpen(null);
                      },
                      sort: () => setSort({ column, down: false }),
                    },
                  ]),
                )}
                row={row}
              >
                <tr
                  tabIndex={0}
                  data-selected={open === i || undefined}
                  onClick={() => setOpen(i)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      setOpen(i);
                    }
                  }}
                >
                  {parsed.columns.map((column) => (
                    <td key={column} data-col={column}>
                      {row[column] ?? ""}
                    </td>
                  ))}
                  <td className="term-more">
                    <RowMore />
                  </td>
                </tr>
              </RowMenu>
            ))}
          </tbody>
        </table>
      </div>
      <RowDrawer
        open={Boolean(opened)}
        onClose={() => setOpen(null)}
        label={`Record details: ${opened && open != null ? rowName(opened, open) : ""}`}
        title={opened && open != null ? rowName(opened, open) : ""}
        meta={`${parsed.columns.length} fields`}
        nav={
          open != null
            ? { index: open, total: rows.length, onPrev: step(-1), onNext: step(1) }
            : undefined
        }
        rowKey={open ?? undefined}
        storageKey="terminal-record"
      >
        {opened && (
          <DetailList
            items={parsed.columns.map((column) => ({
              label: column,
              value: opened[column] || "—",
              mono: true,
            }))}
          />
        )}
      </RowDrawer>
    </div>
  );
}
