import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ArrowRight, ShieldCheck, Router } from "lucide-react";
import { api, postJson } from "./api";
import { Select } from "./geist";
import type { DevicesPayload } from "./types";
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "./components/ui/alert-dialog";

export function useWorkspaceClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function ConfirmWorkspaceAction({
  children,
  title,
  description,
  action,
  onConfirm,
}: {
  children: ReactNode;
  title: string;
  description: string;
  action: string;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{children}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{action}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export const workspaceCard = "min-w-0 rounded-2xl border border-border bg-card p-5 sm:p-6";
export const workspaceNote = "text-xs leading-relaxed text-muted-foreground";
export function WorkspaceFrame({
  title,
  description,
  eyebrow,
  children,
}: {
  title: string;
  description: string;
  eyebrow: string;
  children: (device: string, devices: string[]) => ReactNode;
}) {
  const [devices, setDevices] = useState<string[]>([]),
    [device, setDevice] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    api<DevicesPayload>("/api/devices", abort.signal)
      .then((v) => {
        const enabled = v.devices.filter((d) => !d.disabled).map((d) => d.name);
        setDevices(enabled);
        setDevice(enabled.includes(v.defaultDevice) ? v.defaultDevice : (enabled[0] ?? ""));
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, []);
  return (
    <div className="grid min-w-0 gap-6">
      <header className="flex flex-wrap items-end justify-between gap-5 border-b border-border pb-6">
        <div className="max-w-2xl">
          <p className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.18em] text-brand">
            <ShieldCheck size={14} />
            {eyebrow}
          </p>
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h2>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        </div>
        <div className="grid w-full gap-2 text-xs sm:w-60">
          <span className="flex items-center gap-2">
            <Router size={14} />
            Workspace router
          </span>
          <Select
            aria-label="Workspace router"
            value={device}
            onValueChange={setDevice}
            options={devices.map((d) => ({ value: d, label: d }))}
          />
        </div>
      </header>
      {error && <Notice error>{error}</Notice>}
      {device ? (
        <div key={device} className="min-w-0">
          {children(device, devices)}
        </div>
      ) : (
        <Notice>Select a configured router to start.</Notice>
      )}
    </div>
  );
}
export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return (
    <div
      role={error ? "alert" : "note"}
      className={`rounded-xl border p-4 text-xs leading-relaxed ${error ? "border-destructive/40 bg-destructive/5 text-destructive" : "border-border bg-background text-muted-foreground"}`}
    >
      {children}
    </div>
  );
}
export function Steps({ labels, active }: { labels: string[]; active: number }) {
  return (
    <ol aria-label="Workflow steps" className="mb-5 flex flex-wrap gap-3 text-xs">
      {labels.map((label, i) => (
        <li
          key={label}
          aria-current={active === i ? "step" : undefined}
          className={`flex items-center gap-2 ${i <= active ? "text-brand" : "text-muted-foreground"}`}
        >
          <span className="flex size-6 items-center justify-center rounded-full border border-current font-mono text-[10px]">
            {i + 1}
          </span>
          {label}
          {i < labels.length - 1 && <ArrowRight size={12} />}
        </li>
      ))}
    </ol>
  );
}
export async function workspacePost<T>(path: string, device: string, body: unknown): Promise<T> {
  const data = await postJson<T & { error?: string }>(
    `${path}?device=${encodeURIComponent(device)}`,
    body,
  );
  if (data.error) throw new Error(data.error);
  return data;
}
export function saveDownload(name: string, content: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime })),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function Metric({
  label,
  value,
  unit,
}: {
  label: string;
  value: number | null;
  unit: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-background p-4">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <p className="mt-2 flex items-baseline gap-2 font-mono text-2xl tabular-nums">
        {value === null ? "—" : value.toFixed(1)}
        <span className="text-[10px] text-muted-foreground">{unit}</span>
      </p>
    </div>
  );
}
