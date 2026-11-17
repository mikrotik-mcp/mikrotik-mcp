/**
 * The Live Feed's side panel for one call, as on the Live Feed board: status,
 * where it ran, its risk and ID, the error, its input, and two actions.
 * "Open full record" opens the existing detail drawer with logs and output.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { CircleAlert, X } from "lucide-react";
import { clock } from "./format";
import { formatBytes, formatMs, MonitorButton, RiskBadge, StatusDot } from "./monitoring-ui";
import { toast } from "./toast-action";
import type { ToolEvent } from "./types";

function prettyInput(input: string): string {
  try {
    return JSON.stringify(JSON.parse(input), null, 2);
  } catch {
    return input;
  }
}

const PRE =
  "bg-overlay-03 text-fg-secondary m-0 max-h-56 overflow-auto rounded-[6px] p-3 font-mono text-[12px] leading-[21px] break-words whitespace-pre-wrap shadow-[inset_0_0_0_1px_var(--border)]";

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
    <aside className="feed-inspector" aria-label={`Call details: ${event.tool}`}>
      <div className="flex flex-col gap-2 border-b px-5 py-4">
        <div className="flex items-center gap-2">
          <StatusDot tone={event.isError ? "bad" : "good"} />
          <span
            className={
              event.isError
                ? "text-destructive text-[13px] font-[510]"
                : "text-success text-[13px] font-[510]"
            }
          >
            {event.isError ? "Failed" : "Succeeded"}
          </span>
          <span className="flex-1" />
          <MonitorButton
            size="sm"
            variant="ghost"
            aria-label="Close call details"
            icon={<X />}
            onClick={onClose}
          />
        </div>
        <h2 className="text-emphasis font-mono text-[14px] font-medium break-all">{event.tool}</h2>
        <p className="text-muted-foreground text-[12px]">{where.join(" · ")}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <RiskBadge risk={event.risk} />
          <span className="monitor-badge text-fg-secondary font-mono text-[11px]" title={event.id}>
            ID {event.id.slice(0, 8)}
          </span>
        </div>
      </div>
      <div className="flex flex-col gap-4 px-5 py-4">
        {event.isError && (
          <div className="monitor-note text-fg-secondary text-[12px]" data-tone="bad">
            <CircleAlert className="text-destructive" aria-hidden="true" />
            <span className="min-w-0 break-words">{event.error ?? "The call failed."}</span>
          </div>
        )}
        {!event.isError && event.reason && (
          <div className="monitor-note text-fg-secondary text-[12px]">
            <span className="min-w-0 break-words">{event.reason}</span>
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <span className="text-muted-foreground text-[12px] font-[510]">Input</span>
          <pre className={PRE}>{prettyInput(event.input) || "No input"}</pre>
        </div>
        {!event.isError && (
          <div className="flex flex-col gap-1.5">
            <span className="text-muted-foreground text-[12px] font-[510]">
              Output · {formatBytes(event.outputBytes)}
            </span>
            <pre className={PRE}>{event.output || "No output"}</pre>
          </div>
        )}
        <div className="flex gap-2">
          <MonitorButton size="sm" onClick={copyId}>
            {copied ? "Copied" : "Copy call ID"}
          </MonitorButton>
          <MonitorButton size="sm" variant="ghost" onClick={onOpenFull}>
            Open full record
          </MonitorButton>
        </div>
      </div>
    </aside>
  );
}
