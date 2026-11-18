/**
 * Router picker (Kit-Combobox 03): the kit Select with each router's LED,
 * model, RouterOS version and latency. Details come from /api/devices, shared
 * by every picker on the page and refreshed every 30 s.
 */
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../api";
import type { DeviceInfo, DevicesPayload } from "../types";
import { Select } from "./select";
import type { KitOption } from "./listbox";

let cache: { at: number; promise: Promise<DeviceInfo[]> } | null = null;

function loadDevices(): Promise<DeviceInfo[]> {
  if (cache && Date.now() - cache.at < 30_000) return cache.promise;
  const promise = api<DevicesPayload>("/api/devices")
    .then((p) => (Array.isArray(p?.devices) ? p.devices : []))
    .catch(() => []);
  cache = { at: Date.now(), promise };
  return promise;
}

function useDevices(): DeviceInfo[] {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  useEffect(() => {
    let alive = true;
    void loadDevices().then((d) => {
      if (alive) setDevices(d);
    });
    return () => {
      alive = false;
    };
  }, []);
  return devices;
}

export function routerOption(
  name: string,
  d: DeviceInfo | undefined,
  isDefault: boolean,
): KitOption {
  const s = d?.status;
  const offline = s?.reachable === false;
  const strain = !offline && (s?.cpuLoad ?? 0) >= 80;
  const parts = [
    s?.boardName,
    s?.version && `RouterOS ${s.version}`,
    strain && `CPU ${s?.cpuLoad}%`,
  ].filter(Boolean);
  return {
    value: name,
    label: name,
    description: offline
      ? s?.error
        ? `Offline: ${s.error}`
        : "Offline"
      : parts.length
        ? parts.join(" · ")
        : undefined,
    meta: isDefault
      ? "default"
      : offline
        ? "offline"
        : s?.latencyMs != null
          ? `${Math.round(s.latencyMs)} ms`
          : undefined,
    led: d?.disabled ? "off" : offline ? "bad" : strain ? "warn" : s?.reachable ? "ok" : "off",
    keywords: `${d?.host ?? ""} ${s?.identity ?? ""} ${d?.description ?? ""}`,
  };
}

export function RouterPicker({
  value,
  onChange,
  routers,
  defaultRouter,
  disabled,
  label = "Router",
  size,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  routers: string[];
  defaultRouter?: string | null;
  disabled?: boolean;
  label?: string;
  size?: "md" | "sm";
  className?: string;
}): ReactNode {
  const devices = useDevices();
  const options = useMemo(() => {
    const byName = new Map(devices.map((d) => [d.name, d]));
    const opts = routers.map((r) => routerOption(r, byName.get(r), r === defaultRouter));
    const online = opts.filter((o) => o.led === "ok" || o.led === "warn").length;
    const head = devices.length > 0 ? `${routers.length} routers · ${online} online` : undefined;
    return opts.map((o) => ({ ...o, group: head }));
  }, [routers, devices, defaultRouter]);
  return (
    <Select
      value={value}
      onChange={onChange}
      options={options}
      label={label}
      placeholder="Choose a router"
      disabled={disabled}
      size={size}
      className={className}
      showMeta
      searchable={routers.length > 8}
    />
  );
}
