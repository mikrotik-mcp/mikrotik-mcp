import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { GripHorizontal, RefreshCw } from "lucide-react";
import { PullToRefresh } from "./components/beui/registry/components/motion/pull-to-refresh";
import { Button } from "./components/ui/button";

/** Explicit read-only refresh, shared by touch/pen gestures and keyboard users. */
export function DashboardRefresh({
  enabled,
  disabled = false,
  onRefresh,
  children,
}: {
  enabled: boolean;
  disabled?: boolean;
  onRefresh: () => Promise<void>;
  children: ReactNode;
}) {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const refresh = async () => {
    if (lock.current || disabled) return;
    lock.current = true;
    setBusy(true);
    setMessage("");
    setFailed(false);
    try {
      await onRefresh();
      setMessage("Dashboard data refreshed");
    } catch {
      setFailed(true);
      setMessage("Refresh failed. Previous data kept; try again.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  if (!enabled) return children;
  return (
    <PullToRefresh
      handleOnly
      onRefresh={refresh}
      refreshing={busy}
      disabled={disabled}
      ariaLabel="Refresh dashboard data"
      className="overflow-visible bg-transparent cursor-default"
      contentClassName="min-h-0"
      pullingLabel="Pull to reload dashboard data"
      refreshingLabel="Reading dashboard data…"
    >
      <div
        data-refresh-handle
        className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-border px-3 py-2 text-xs text-muted-foreground cursor-grab active:cursor-grabbing"
      >
        <GripHorizontal className="size-4 text-primary" />
        <span className="flex-1">
          {disabled ? "Resume the feed to refresh" : "Pull down here to refresh · read-only"}
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || disabled}
          onClick={() => void refresh()}
        >
          <RefreshCw className={busy ? "animate-spin motion-reduce:animate-none" : ""} />
          {busy ? "Refreshing…" : "Refresh data"}
        </Button>
      </div>
      {message && (
        <p
          role={failed ? "alert" : "status"}
          className={`mb-3 text-xs ${failed ? "text-destructive" : "text-muted-foreground"}`}
        >
          {message}
        </p>
      )}
      {children}
    </PullToRefresh>
  );
}
