import { useEffect, useRef, useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { ConfigEditor } from "./config-editor";
import { api } from "./api";
import { MonitorButton } from "./monitoring-ui";

/**
 * Narrow safe-apply workspace. The header's Close calls ConfigEditor's guarded
 * close (it asks before dropping a draft and waits out a pending save), so the
 * dialog ignores Escape and outside clicks.
 */
export function ServiceProbesSettings({
  onClose,
  onReload,
}: {
  onClose: () => void;
  onReload: () => void;
}) {
  const [config, setConfig] = useState<Record<string, unknown>>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const closeRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void api<Record<string, unknown>>("/api/config", controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setConfig(value);
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "Could not load configuration.");
      });
    return () => controller.abort();
  }, [attempt]);
  return (
    <DialogPrimitive.Root open>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="monitor-scrim fixed inset-0 z-50" />
        <DialogPrimitive.Content
          className="monitor-dialog probe-settings fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-32px)] w-[calc(100%-32px)] max-w-[720px] -translate-x-1/2 -translate-y-1/2 flex-col outline-none"
          onEscapeKeyDown={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
        >
          <div className="monitor-dialog-head">
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title asChild>
                <h2>Service probes</h2>
              </DialogPrimitive.Title>
              <DialogPrimitive.Description asChild>
                <p>
                  Services MCP may test from a router. Service Routing uses the HTTPS ones to check
                  exits.
                </p>
              </DialogPrimitive.Description>
            </div>
            <MonitorButton
              size="sm"
              variant="ghost"
              onClick={() => (config && closeRef.current ? closeRef.current() : onClose())}
            >
              Close
            </MonitorButton>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {config ? (
              <ConfigEditor
                scope="serviceProbes"
                initial={config}
                onClose={onClose}
                onReload={onReload}
                closeRef={closeRef}
              />
            ) : (
              <div className="monitor-dialog-body grid gap-3">
                <p
                  role={error ? "alert" : "status"}
                  className={
                    error ? "monitor-err text-[13px]" : "text-[13px] text-muted-foreground"
                  }
                >
                  {error || "Loading the approved services…"}
                </p>
                <div className="flex gap-2">
                  {error && (
                    <MonitorButton
                      size="sm"
                      onClick={() => {
                        setError("");
                        setAttempt((n) => n + 1);
                      }}
                    >
                      Retry
                    </MonitorButton>
                  )}
                </div>
              </div>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
