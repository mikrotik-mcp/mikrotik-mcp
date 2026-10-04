import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ConfigEditor } from "./config-editor";
import { api } from "./api";

/** Narrow safe-apply workspace. Closing goes through ConfigEditor's discard/rollback guard. */
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
    <Dialog open>
      <DialogContent
        className="probe-settings"
        showCloseButton={false}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Manage service probes</DialogTitle>
          <DialogDescription>
            Approve destinations shared by all routers. Only Service Probes settings are changed; no
            router commands are run. Use Close to leave this editor safely.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="probe-settings__scroll">
          {config ? (
            <ConfigEditor
              scope="serviceProbes"
              initial={config}
              onClose={onClose}
              onReload={onReload}
            />
          ) : (
            <div className="grid gap-3 py-4">
              <p role={error ? "alert" : "status"}>{error || "Loading current approvals…"}</p>
              <div className="flex gap-2">
                {error && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setError("");
                      setAttempt((n) => n + 1);
                    }}
                  >
                    Retry
                  </Button>
                )}
                <Button variant="outline" onClick={onClose}>
                  Close
                </Button>
              </div>
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
