import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Router, RefreshCw, AlertTriangle, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, postJson } from "./api";
import "./operations.css";

/** Device-scoped loading with stale-response suppression; a missing sample is never zero. */
export function useOperations<T>(endpoint: string) {
  const [device, setDevice] = useState("");
  const [devices, setDevices] = useState<string[]>([]);
  const [data, setData] = useState<T>();
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [observedAt, setObservedAt] = useState(Date.now);
  const generation = useRef(0);
  const invalidate = useCallback(() => {
    generation.current++;
  }, []);
  const chooseDevice = (next: string) => {
    invalidate();
    setData(undefined);
    setError("");
    setDevice(next);
  };
  useEffect(() => {
    let stopped = false;
    void api<{ devices: { name: string }[]; defaultDevice: string }>("/api/devices")
      .then((r) => {
        if (stopped) return;
        setDevices(r.devices.map((d) => d.name));
        setDevice(
          r.devices.some((d) => d.name === r.defaultDevice)
            ? r.defaultDevice
            : (r.devices[0]?.name ?? ""),
        );
        setLoading(false);
      })
      .catch(() => {
        if (!stopped) {
          setError("Routers could not be loaded. Check the dashboard connection and retry.");
          setLoading(false);
        }
      });
    return () => {
      stopped = true;
      invalidate();
    };
  }, [invalidate]);
  const refresh = useCallback(async () => {
    if (!device) return;
    const g = ++generation.current;
    setLoading(true);
    try {
      const value = await api<T>(`${endpoint}?device=${encodeURIComponent(device)}`);
      if (g === generation.current) {
        setData(value);
        setObservedAt(Date.now());
        setError("");
      }
    } catch (e) {
      if (g === generation.current)
        setError(e instanceof Error ? e.message : "Could not load this workspace.");
    } finally {
      if (g === generation.current) setLoading(false);
    }
  }, [device, endpoint]);
  useEffect(() => {
    const timer = setTimeout(() => void refresh(), 0);
    return () => {
      clearTimeout(timer);
      invalidate();
    };
  }, [refresh, invalidate]);
  async function action<R>(suffix: string, body: unknown): Promise<R | undefined> {
    if (!device || busy) return;
    setBusy(true);
    setError("");
    const g = generation.current;
    try {
      const result = await postJson<R & { error?: string }>(
        `${endpoint}${suffix}?device=${encodeURIComponent(device)}`,
        body,
      );
      if (result.error) throw new Error(result.error);
      if (g === generation.current) {
        await refresh();
        return result;
      }
    } catch (e) {
      if (g === generation.current)
        setError(
          e instanceof Error
            ? e.message
            : "Operation failed. Review the router state before retrying a write.",
        );
    } finally {
      setBusy(false);
    }
  }
  return {
    device,
    setDevice: chooseDevice,
    devices,
    data,
    busy,
    loading,
    error,
    refresh,
    action,
    observedAt,
  };
}
export function WorkspaceHeader({
  eyebrow,
  title,
  description,
  device,
  devices,
  onDevice,
  busy,
  onRefresh,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  device: string;
  devices: string[];
  onDevice: (v: string) => void;
  busy: boolean;
  onRefresh: () => void;
  children?: ReactNode;
}) {
  return (
    <header className="ops-header">
      <div>
        <p className="ops-eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
        <p className="ops-description">{description}</p>
      </div>
      <div className="ops-toolbar">
        <Select value={device} onValueChange={onDevice} disabled={busy || !devices.length}>
          <SelectTrigger aria-label="Workspace router">
            <Router size={16} />
            <SelectValue placeholder="Select router" />
          </SelectTrigger>
          <SelectContent>
            {devices.map((d) => (
              <SelectItem value={d} key={d}>
                {d}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          onClick={onRefresh}
          disabled={busy}
          aria-label="Refresh workspace"
        >
          <RefreshCw size={16} />
        </Button>
        {children}
      </div>
    </header>
  );
}
export function WorkspaceError({ message }: { message: string }) {
  return message ? (
    <div role="alert" className="ops-notice ops-notice--error">
      <AlertTriangle size={18} />
      <span>{message}</span>
    </div>
  ) : null;
}
export function WorkspaceSafety({ children }: { children: ReactNode }) {
  return (
    <div className="ops-notice">
      <ShieldCheck size={18} />
      <span>{children}</span>
    </div>
  );
}
export function EvidenceState({ state }: { state: string }) {
  return (
    <span className="ops-state" data-state={state}>
      <i aria-hidden="true" />
      {state.replaceAll("-", " ")}
    </span>
  );
}
