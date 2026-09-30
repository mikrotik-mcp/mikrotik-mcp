import { postJson } from "./api";
import type { DeviceStatus } from "./types";

export type ConnectionResult = { ok: boolean; label: string };

/** Read-only probe shared by the inventory and the unsaved device editor. */
export async function testDeviceConnection(
  name: string,
  config: unknown,
  devices?: unknown,
): Promise<ConnectionResult> {
  try {
    const result = await postJson<{
      ok?: boolean;
      status?: DeviceStatus;
      errors?: { message: string }[];
      error?: string;
    }>("/api/config/test-device", { name, config, devices });
    const ok = result.ok === true && result.status?.reachable === true;
    return {
      ok,
      label: ok
        ? `${Math.round(result.status?.latencyMs ?? 0)}ms · ${result.status?.identity ?? "Connected"}`
        : (result.status?.error ?? result.errors?.[0]?.message ?? result.error ?? "Unreachable"),
    };
  } catch {
    return { ok: false, label: "Connection test request failed. Try again." };
  }
}
