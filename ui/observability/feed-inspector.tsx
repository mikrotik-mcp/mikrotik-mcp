/**
 * The Live Feed's side panel for one call, as on the Live Feed board: status,
 * where it ran, its risk and ID, the error, its input, and two actions.
 * "Open full record" opens the existing detail drawer with logs and output.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Copy, ExternalLink, TriangleAlert, X } from "lucide-react";
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
}: {
  event: ToolEvent;
  onClose: () => void;
  onOpenFull: () => void;
}): ReactNode {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const copyId = (): void => {
    if (!navigator.clipboard) {
      toast.error("Clipboard unavailable. Select the ID and copy it manually.");
      return;
    }
    void navigator.clipboard.writeText(event.id).then(
      () => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1400);
      },
      () => toast.error("Couldn't copy. Select the ID and copy it manually."),
    );
  };

  const where = [
    clock(event.ts),
    event.device,
    formatMs(event.durationMs),
    event.deviceTransport?.toUpperCase(),
  ].filter(Boolean);

  return (
    <aside className="live-feed-inspector" aria-label={`Call details: ${event.tool}`}>
      <div className="flex flex-col gap-2 border-b px-[18px] py-4">
        <div className="flex items-center gap-2">
          <StatusDot tone={event.isError ? "bad" : "good"} />
          <span
            className={
              event.isError
                ? "text-destructive text-[13px] font-medium"
                : "text-success text-[13px] font-medium"
            }
          >
            {event.isError ? "Failed" : "Succeeded"}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            className="monitor-icon-btn"
            aria-label="Close call details"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        </div>
        <h2 className="text-emphasis font-mono text-[15px] font-medium break-all">{event.tool}</h2>
        <p className="text-muted-foreground text-[12px]">{where.join(" · ")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <RiskBadge risk={event.risk} />
          <span className="monitor-chip" title={event.id}>
            ID {event.id.slice(0, 8)}
          </span>
        </div>
      </div>
      <div className="flex flex-col gap-[14px] px-[18px] py-4">
        {event.isError && (
          <MonitorNote tone="bad" icon={<TriangleAlert aria-hidden="true" />}>
            <span className="break-words">{event.error ?? "The call failed."}</span>
          </MonitorNote>
        )}
        {!event.isError && event.reason && (
          <MonitorNote>
            <span className="break-words">{event.reason}</span>
          </MonitorNote>
        )}
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-muted-foreground text-[12px] font-medium">Input</span>
          <pre className="monitor-pre live-feed-pre break-words">
            {prettyInput(event.input) || "No input"}
          </pre>
        </div>
        {!event.isError && (
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-muted-foreground text-[12px] font-medium">
              Output · {formatBytes(event.outputBytes)}
            </span>
            <pre className="monitor-pre break-words">{event.output || "No output"}</pre>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <MonitorButton size="sm" icon={<Copy aria-hidden="true" />} onClick={copyId}>
            {copied ? "Copied" : "Copy call ID"}
          </MonitorButton>
          <MonitorButton
            size="sm"
            variant="ghost"
            icon={<ExternalLink aria-hidden="true" />}
            onClick={onOpenFull}
          >
            Open full record
          </MonitorButton>
        </div>
      </div>
    </aside>
  );
}
