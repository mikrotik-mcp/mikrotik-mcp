import type { DeviceConfig } from "../config";

export type EndpointTransport = "ssh" | "rest";
export interface EndpointConnection {
  host: string;
  port: number;
  transport: EndpointTransport;
}
export interface EndpointObservation extends EndpointConnection {
  checkedAt: number;
  error?: string;
}
export interface DeviceEndpoints {
  primary: string;
  hosts: string[];
  connected: EndpointConnection[];
  observations: EndpointObservation[];
}

// Config-object identity isolates devices, drafts and configuration generations.
const states = new WeakMap<
  DeviceConfig,
  {
    live: Set<EndpointConnection>;
    observations: Map<string, EndpointObservation>;
  }
>();
function state(dc: DeviceConfig) {
  let value = states.get(dc);
  if (!value) {
    value = { live: new Set(), observations: new Map() };
    states.set(dc, value);
  }
  return value;
}

export function endpointAddress(host: string, port: number): string {
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

/** Runtime observations, never credentials or a claim that every IP was tested. */
export function deviceEndpoints(dc: DeviceConfig): DeviceEndpoints | undefined {
  if (dc.mac) return undefined;
  const current = state(dc);
  return {
    primary: dc.host,
    hosts: [dc.host, ...(dc.fallbackHosts ?? [])],
    connected: Array.from(new Map([...current.live].map((c) => [JSON.stringify(c), c])).values()),
    observations: [...current.observations.values()],
  };
}

export interface EndpointOptions {
  /** Evaluated at connect time, not at client construction. */
  hosts?: () => string[];
  onAttempt?: (host: string, error?: string) => void;
  onConnected?: (host: string) => () => void;
}

/** Share selection across normal SSH, probes, bastions, SFTP and Safe Mode. */
export function endpointOptions(
  dc: DeviceConfig,
  transport: EndpointTransport,
  port: number,
): EndpointOptions {
  const current = state(dc);
  const key = (host: string) => `${transport}:${endpointAddress(host, port)}`;
  return {
    hosts: () => {
      const all = [dc.host, ...(dc.fallbackHosts ?? [])];
      const available = all.filter((host) => {
        const last = current.observations.get(key(host));
        return !last?.error || Date.now() - last.checkedAt >= 30_000;
      });
      return available.length ? [...available, ...all.filter((h) => !available.includes(h))] : all;
    },
    onAttempt: (host, error) => {
      current.observations.set(key(host), {
        host,
        port,
        transport,
        checkedAt: Date.now(),
        ...(error ? { error } : {}),
      });
    },
    onConnected: (host) => {
      const connection = { host, port, transport };
      current.live.add(connection);
      return () => {
        current.live.delete(connection);
      };
    },
  };
}
