import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Search } from "lucide-react";
import { api } from "./api";
import { Button, Input } from "./geist";
import type { ToolEvent } from "./types";

/** Find one persisted call even when it has fallen out of the live-feed buffer. */
export function ToolCallLookup({ onFound }: { onFound: (event: ToolEvent) => void }): ReactNode {
  const [id, setId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const lookup = async (): Promise<void> => {
    if (pending.current) return;
    const value = id.trim();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
      setError("Paste the complete call ID from an MCP response or activity row.");
      return;
    }
    setBusy(true);
    setError("");
    const request = new AbortController();
    pending.current = request;
    try {
      const event = await api<ToolEvent>(`/api/event/${encodeURIComponent(value)}`, request.signal);
      if (!request.signal.aborted) onFound(event);
    } catch (cause) {
      if (!request.signal.aborted)
        setError(
          `${cause instanceof Error ? cause.message : "Could not load this call."} Check the connection and server; the record may be in flight, expired, deleted or not saved.`,
        );
    } finally {
      pending.current = null;
      if (!request.signal.aborted) setBusy(false);
    }
  };
  return (
    <form
      className="mb-4 rounded-xl border border-border bg-muted/25 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) void lookup();
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid min-w-0 flex-1 gap-1.5 text-xs font-medium">
          Find a recorded call
          <Input
            aria-label="Tool call ID"
            aria-describedby="call-lookup-help"
            aria-invalid={!!error}
            value={id}
            onChange={(event) => {
              setId(event.target.value);
              setError("");
            }}
            placeholder="Paste full call ID…"
            className="font-mono text-xs"
            maxLength={128}
            disabled={busy}
          />
        </label>
        <Button
          size="sm"
          loading={busy}
          disabled={!id.trim()}
          icon={<Search />}
          onClick={() => void lookup()}
        >
          Inspect call
        </Button>
      </div>
      <p id="call-lookup-help" className="mt-2 text-[11px] text-muted-foreground">
        Searches saved history, beyond the live buffer. Same ID in MCP and the dashboard.
      </p>
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
