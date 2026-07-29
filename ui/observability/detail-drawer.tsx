import { useState } from "react";
import type { ReactNode } from "react";
import { CopyButton } from "./atoms";
import { bytes, ms } from "./format";
import { Button } from "./geist";
import {
  formatInputJson,
  highlightDeviceOutput,
  JsonView,
  loadPrettyInput,
  savePrettyInput,
} from "./highlight";
import { Sheet } from "./sheet";
import type { ToolEvent } from "./types";
import { cn } from "@/lib/utils";

// Risk pill tints — one semantic hue per level (matches the live-feed badges).
const RISK_TONE: Record<string, string> = {
  READ: "text-success border-success/45 bg-success/10",
  WRITE: "text-chart-1 border-chart-1/45 bg-chart-1/10",
  WRITE_IDEMPOTENT: "text-chart-2 border-chart-2/45 bg-chart-2/10",
  DESTRUCTIVE: "text-warning border-warning/45 bg-warning/10",
  DANGEROUS: "text-destructive border-destructive/45 bg-destructive/10",
};

const KV_CELL = "border-b border-border/60 px-3.5 py-[7px] text-xs [overflow-wrap:anywhere]";
const KV_K = cn(KV_CELL, "bg-muted/40 text-muted-foreground");
const KV_V = cn(KV_CELL, "text-foreground");
const BODY_PRE =
  "m-0 max-h-[40vh] overflow-auto rounded border border-border bg-background p-3 font-mono text-xs break-words whitespace-pre-wrap";
const SECTION_LABEL = "m-0 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase";

// ── detail drawer ────────────────────────────────────────────────────────────
export function DetailDrawer({
  event,
  onClose,
}: {
  event: ToolEvent;
  onClose: () => void;
}): ReactNode {
  // Pretty-print INPUT JSON by default; the toggle is remembered across drawers.
  const [prettyInput, setPrettyInput] = useState(loadPrettyInput);
  const togglePretty = (): void =>
    setPrettyInput((on) => {
      const next = !on;
      savePrettyInput(next);
      return next;
    });

  const title = (
    <span className="flex items-center gap-2.5">
      <span
        className={cn(
          "inline-block rounded-full border px-2 py-px font-mono text-[10px] tracking-wide uppercase",
          RISK_TONE[event.risk] ?? "text-muted-foreground",
        )}
      >
        {event.risk}
      </span>
      <span className="font-mono text-[15px]">{event.tool}</span>
      <CopyButton text={event.tool} icon title="Copy tool name" />
    </span>
  );

  return (
    <Sheet title={title} onClose={onClose}>
      <div className="grid gap-3">
        <div className="grid grid-cols-[minmax(120px,0.4fr)_1fr] overflow-hidden rounded-lg border border-border font-mono">
          <div className={KV_K}>title</div>
          <div className={KV_V}>{event.title}</div>
          {event.reason && (
            <>
              <div className={cn(KV_CELL, "bg-muted/40 text-warning")}>reason</div>
              <div className={cn(KV_CELL, "text-foreground italic")}>{event.reason}</div>
            </>
          )}
          <div className={KV_K}>time</div>
          <div className={KV_V}>
            {new Date(event.ts).toLocaleString(undefined, { hour12: false })}
          </div>
          <div className={KV_K}>device</div>
          <div className={KV_V}>{event.device ?? "—"}</div>
          <div className={KV_K}>mcp transport</div>
          <div className={KV_V}>{event.transport ?? "—"}</div>
          {event.deviceTransport && (
            <>
              <div className={KV_K}>device link</div>
              <div className={KV_V}>
                {event.deviceTransport}
                {event.restFallback ? (
                  // A REST-enabled device that did not use REST: the reason is
                  // the whole diagnostic, since a silent fallback is otherwise
                  // indistinguishable from REST never being turned on.
                  <span className="text-warning"> — REST fell back: {event.restFallback}</span>
                ) : null}
              </div>
            </>
          )}
          <div className={KV_K}>duration</div>
          <div className={KV_V}>{ms(event.durationMs)}</div>
          <div className={KV_K}>status</div>
          <div className={KV_V}>
            <span className={event.isError ? "text-destructive" : "text-success"}>
              {event.isError ? "error" : "ok"}
            </span>
          </div>
          <div className={KV_K}>output size</div>
          <div className={KV_V}>
            {bytes(event.outputBytes)}
            {event.truncated ? " (truncated)" : ""}
          </div>
          <div className={KV_K}>structured</div>
          <div className={KV_V}>{event.hasStructured ? "yes (renders an MCP App view)" : "no"}</div>
        </div>
        {event.error && (
          <>
            <h2 className={SECTION_LABEL}>ERROR</h2>
            <pre className={cn(BODY_PRE, "text-destructive")}>{event.error}</pre>
          </>
        )}
        <div className="flex items-center gap-2.5">
          <h2 className={SECTION_LABEL}>INPUT</h2>
          <span className="flex-1" />
          {event.input && (
            <Button
              type="secondary"
              size="sm"
              ghost
              onClick={togglePretty}
              title={
                prettyInput
                  ? "Showing pretty-printed JSON — click for raw"
                  : "Showing raw JSON — click to pretty-print"
              }
            >
              {prettyInput ? "✦ Pretty" : "{ } Raw"}
            </Button>
          )}
          <CopyButton text={event.input} title="Copy input JSON" />
        </div>
        {event.input ? (
          <JsonView value={formatInputJson(event.input, prettyInput)} />
        ) : (
          <pre className={cn(BODY_PRE, "text-muted-foreground")}>—</pre>
        )}
        <div className="flex items-center gap-2.5">
          <h2 className={SECTION_LABEL}>OUTPUT</h2>
          <span className="flex-1" />
          <CopyButton text={event.output} title="Copy output" />
        </div>
        <pre className={cn(BODY_PRE, "text-muted-foreground")}>
          {event.output ? highlightDeviceOutput(event.output) : "—"}
        </pre>
      </div>
    </Sheet>
  );
}
