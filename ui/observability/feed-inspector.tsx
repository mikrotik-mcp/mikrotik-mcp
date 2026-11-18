/**
 * One Live Feed call in the kit's row drawer (Kit-Data-Drawer): status, where
 * it ran, its risk and ID, tabs for overview, input, output and other calls of
 * the same tool, and its actions. "Open full record" opens the existing detail
 * drawer with logs.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Copy, ExternalLink, FileJson, TriangleAlert } from "lucide-react";
import { DetailBlock, DetailList, DurationBar, RowDrawer } from "./kit";
import { clock } from "./format";
import {
  formatBytes,
  formatMs,
  MonitorButton,
  MonitorNote,
  RiskBadge,
  StatusDot,
} from "./monitoring-ui";
import { toast } from "./toast-action";
import type { ToolEvent } from "./types";

/**
 * The input as pretty JSON with keys and string values coloured, as on the
 * board. Input that is not JSON comes back as plain text.
 */
function prettyInput(input: string): ReactNode {
  let text: string;
  try {
    text = JSON.stringify(JSON.parse(input), null, 2);
  } catch {
    return input;
  }
  const parts: ReactNode[] = [];
  const re = /("(?:\\.|[^"\\])*")(\s*:)?/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <span key={m.index} className={m[2] ? "k" : "a"}>
        {m[1]}
      </span>,
    );
    if (m[2]) parts.push(m[2]);
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return parts;
}

export function FeedInspector({
  event,
  onClose,
  onOpenFull,
  nav,
  p95,
  sameTool = [],
  onPick,
}: {
  event: ToolEvent;
  onClose: () => void;
  onOpenFull: () => void;
  /** Position in the shown rows, and moving to the next or previous call. */
  nav?: { index: number; total: number; onPrev?: () => void; onNext?: () => void };
  /** This tool's p95 in the current window, to compare the duration with. */
  p95?: number | null;
  /** Other calls of the same tool in the feed. */
  sameTool?: ToolEvent[];
  onPick?: (e: ToolEvent) => void;
}): ReactNode {
  const [copied, setCopied] = useState<"" | "id" | "json">("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const copy = (what: "id" | "json"): void => {
    if (!navigator.clipboard) {
      toast.error("Clipboard unavailable. Select the ID and copy it manually.");
      return;
    }
    const text = what === "id" ? event.id : JSON.stringify(event, null, 2);
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(what);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(""), 1400);
      },
      () => toast.error("Couldn't copy. Select the ID and copy it manually."),
    );
  };

  const where = [clock(event.ts), event.device, event.deviceTransport?.toUpperCase()].filter(
    Boolean,
  );
  const inputLines = event.input ? event.input.split("\n").length : 0;
  const note = event.isError ? (
    <MonitorNote tone="bad" icon={<TriangleAlert aria-hidden="true" />}>
      <span className="break-words">{event.error ?? "The call failed."}</span>
    </MonitorNote>
  ) : event.reason ? (
    <MonitorNote>
      <span className="break-words">{event.reason}</span>
    </MonitorNote>
  ) : null;
  const input = (
    <DetailBlock
      label="Input"
      aside={inputLines ? `${inputLines} ${inputLines === 1 ? "line" : "lines"}` : undefined}
    >
      <pre className="monitor-pre live-feed-pre break-words">
        {prettyInput(event.input) || "No input"}
      </pre>
    </DetailBlock>
  );
  const output = !event.isError && (
    <DetailBlock label="Output" aside={formatBytes(event.outputBytes)}>
      <pre className="monitor-pre break-words">{event.output || "No output"}</pre>
    </DetailBlock>
  );

  return (
    <RowDrawer
      open
      onClose={onClose}
      label={`Call details: ${event.tool}`}
      storageKey="feed"
      rowKey={event.id}
      nav={nav}
      status={{ tone: event.isError ? "bad" : "ok", label: event.isError ? "Failed" : "Succeeded" }}
      title={event.tool}
      meta={where.join(" · ")}
      chips={
        <>
          <RiskBadge risk={event.risk} />
          <span className="monitor-chip" title={event.id}>
            ID {event.id.slice(0, 8)}
          </span>
          <span className="monitor-chip">{formatMs(event.durationMs)}</span>
        </>
      }
      onOpenFull={onOpenFull}
      tabs={[
        {
          id: "overview",
          label: "Overview",
          content: (
            <>
              {note}
              <DurationBar ms={event.durationMs} ref95={p95} format={formatMs} />
              <DetailList
                items={[
                  {
                    label: "Time",
                    value: `${new Date(event.ts).toLocaleTimeString("en-GB", { hour12: false })}.${String(event.ts % 1000).padStart(3, "0")}`,
                    mono: true,
                  },
                  ...(event.device
                    ? [
                        {
                          label: "Router",
                          value: (
                            <>
                              <StatusDot tone={event.isError ? "bad" : "good"} />
                              {event.device}
                            </>
                          ),
                          mono: true,
                        },
                      ]
                    : []),
                  ...(event.deviceTransport
                    ? [{ label: "Transport", value: event.deviceTransport.toUpperCase() }]
                    : []),
                  { label: "Risk", value: event.risk },
                  { label: "Call ID", value: event.id, mono: true },
                ]}
              />
              {input}
              {output}
            </>
          ),
        },
        { id: "input", label: "Input", content: input },
        ...(event.isError
          ? []
          : [
              {
                id: "output",
                label: "Output",
                count: formatBytes(event.outputBytes),
                content: output,
              },
            ]),
        {
          id: "same",
          label: "Same tool",
          count: sameTool.length,
          content:
            sameTool.length === 0 ? (
              <p className="text-muted-foreground text-[13px]">
                No other calls of {event.tool} in the feed.
              </p>
            ) : (
              <div className="flex flex-col">
                {sameTool.slice(0, 40).map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    className="monitor-row grid grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-3 text-left"
                    onClick={() => onPick?.(e)}
                  >
                    <span className="text-muted-foreground font-mono text-[12px]">
                      {clock(e.ts)}
                    </span>
                    <span className="flex min-w-0 items-center gap-2 truncate font-mono text-[12px]">
                      <StatusDot tone={e.isError ? "bad" : "good"} />
                      {e.device ?? "—"}
                    </span>
                    <span className="text-fg-secondary text-[12px] tabular-nums">
                      {formatMs(e.durationMs)}
                    </span>
                  </button>
                ))}
              </div>
            ),
        },
      ]}
      actions={
        <>
          <MonitorButton size="sm" icon={<Copy aria-hidden="true" />} onClick={() => copy("id")}>
            {copied === "id" ? "Copied" : "Copy call ID"}
          </MonitorButton>
          <MonitorButton
            size="sm"
            icon={<FileJson aria-hidden="true" />}
            onClick={() => copy("json")}
          >
            {copied === "json" ? "Copied" : "Copy as JSON"}
          </MonitorButton>
        </>
      }
      primary={
        <MonitorButton
          size="sm"
          variant="primary"
          icon={<ExternalLink aria-hidden="true" />}
          onClick={onOpenFull}
        >
          Open full record
        </MonitorButton>
      }
    />
  );
}
