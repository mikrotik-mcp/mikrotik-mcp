/**
 * Process-wide runtime state: the active configuration, set once at startup.
 *
 * Tool handlers reach connection details through `getDevice()` instead of
 * receiving them as parameters. With named multi-device support, the device a
 * call targets is carried on the ToolContext and resolved here.
 */
import type { MikrotikConfig, DeviceConfig } from "../config";
import { MikrotikConfigSchema } from "../config";

let active: MikrotikConfig = MikrotikConfigSchema.parse({});

/**
 * Listeners fired whenever the active config is replaced.
 *
 * A subscription rather than a direct call because the things that care about a
 * config change — the capability cache, for one — already import this module for
 * device resolution, so importing them back would be a cycle. Registering from
 * the dependent side keeps the dependency pointing one way.
 */
const configListeners = new Set<() => void>();

/** Run `fn` whenever `setConfig` installs a new configuration. */
export function onConfigChanged(fn: () => void): void {
  configListeners.add(fn);
}

export function setConfig(cfg: MikrotikConfig): void {
  active = cfg;
  for (const fn of configListeners) {
    try {
      fn();
    } catch {
      // A listener must never be able to break config installation.
    }
  }
}

export function getConfig(): MikrotikConfig {
  return active;
}

/** Helper: true when a device is enabled (not disabled). */
function isEnabled(dc: DeviceConfig): boolean {
  return !dc.disabled;
}

/** Names of every ENABLED configured device, plus which one is the default. */
export function listDevices(): { names: string[]; default: string } {
  const names = Object.entries(active.devices)
    .filter(([, dc]) => isEnabled(dc))
    .map(([k]) => k);
  return { names, default: active.defaultDevice };
}

/** Names of ALL configured devices (including disabled), for dashboard use. */
export function listAllDevices(): { names: string[]; default: string } {
  return { names: Object.keys(active.devices), default: active.defaultDevice };
}

/**
 * Map a device's free-text `description` (the label shown to the AI, e.g.
 * "Ali Home") to its config key, case-insensitively. Lets a tool be targeted by
 * the friendly label as well as the key. Returns undefined when no label matches.
 * Only matches enabled devices.
 */
function deviceKeyForLabel(name: string): string | undefined {
  const target = name.trim().toLowerCase();
  for (const [key, dc] of Object.entries(active.devices)) {
    if (isEnabled(dc) && dc.description && dc.description.trim().toLowerCase() === target)
      return key;
  }
  return undefined;
}

/**
 * Distinct device labels (`description`s) that can ALSO be used to target a
 * device — a non-empty description that isn't already a device key. These are
 * added to the `device` selector enum so the AI may pass either the key or the
 * friendly label. Only returns labels for enabled devices.
 */
export function deviceLabels(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const [key, dc] of Object.entries(active.devices)) {
    if (!isEnabled(dc)) continue;
    const label = dc.description?.trim();
    if (label && label !== key && !(label in active.devices) && !seen.has(label)) {
      seen.add(label);
      out.push(label);
    }
  }
  return out;
}

/** The default target: the configured default when enabled, else the first enabled device. */
function defaultDeviceKey(): string {
  if (active.defaultDevice in active.devices && isEnabled(active.devices[active.defaultDevice])) {
    return active.defaultDevice;
  }
  const firstEnabled = Object.entries(active.devices).find(([, dc]) => isEnabled(dc));
  return firstEnabled ? firstEnabled[0] : active.defaultDevice;
}

/**
 * Resolve a device name to a config key WITHOUT falling back — `undefined` when
 * the name matches no enabled device. Callers that must tolerate an unknown name
 * (HTTP query strings, plan validation that reports unknown targets itself) use
 * this; everything that is about to touch a router uses {@link resolveDeviceName}.
 *
 * Matching is EXACT (key first, then label) — never fuzzy/substring — so a name
 * like "Ali Home" can never collapse onto a different device such as "home".
 */
export function tryResolveDeviceName(name?: string): string | undefined {
  if (!name) return undefined;
  if (name in active.devices && isEnabled(active.devices[name])) return name;
  return deviceKeyForLabel(name);
}

/**
 * Resolve a (possibly undefined) device name to a concrete, existing config key.
 * Accepts a config key OR a device's free-text label. An omitted name uses the
 * configured default.
 *
 * FAIL-CLOSED: a name that matches no enabled device THROWS. It must never
 * degrade to the default router — a typo'd or stale device name silently
 * retargeting a write at whichever device happens to be first is the one bug
 * class here that can misconfigure the wrong physical device. `getDevice()`
 * already threw for this, but every caller resolved the name first and then
 * handed the laundered key to `getDevice`, so that guard could never fire.
 *
 * Matching is EXACT (key first, then label) — never fuzzy/substring — so a name
 * like "Ali Home" can never collapse onto a different device such as "home".
 */
export function resolveDeviceName(name?: string): string {
  if (!name) return defaultDeviceKey();
  const resolved = tryResolveDeviceName(name);
  if (resolved) return resolved;
  throw new Error(unknownDeviceMessage(name));
}

/** The error text for a name that resolves to no enabled device. */
export function unknownDeviceMessage(name: string): string {
  const enabled = listDevices().names;
  // A name that IS configured but disabled gets its own message: "unknown" would
  // send the caller hunting for a typo that isn't there.
  const disabled = name in active.devices && !isEnabled(active.devices[name]);
  if (disabled) {
    return `Device '${name}' is disabled. Enable it from the dashboard or config file. Enabled devices: ${enabled.join(", ")}`;
  }
  return (
    `Unknown device '${name}'. Enabled devices: ${enabled.join(", ") || "(none)"}. ` +
    "Call list_mikrotik_devices for the authoritative current set — this was NOT run against " +
    "the default device."
  );
}

/** One row of the human-facing device directory shown in the `device` selector. */
export interface DeviceDirectoryEntry {
  key: string;
  label?: string;
  /** Where it connects: `host:port`, or `MAC <addr>` for a MAC-Telnet device. */
  target: string;
  isDefault: boolean;
}

/** Where a device connects: `host:port`, or `MAC <addr>` for a MAC-Telnet device. */
function deviceTarget(dc: DeviceConfig | undefined): string {
  if (!dc) return "?";
  return dc.mac ? `MAC ${dc.mac}` : `${dc.host}:${dc.port ?? 22}`;
}

/**
 * A clear key → label → target listing of every ENABLED configured device, used
 * to build the `device` selector's description so the model can tell
 * similarly-named routers apart (e.g. "Ali Home" at 45.87.6.144 vs "home" at
 * 192.168.7.1) and never substitute one for another.
 */
export function deviceDirectory(): DeviceDirectoryEntry[] {
  return Object.entries(active.devices)
    .filter(([, dc]) => isEnabled(dc))
    .map(([key, dc]) => ({
      key,
      label: dc.description?.trim() || undefined,
      target: deviceTarget(dc),
      isDefault: key === active.defaultDevice,
    }));
}

/**
 * Resolve a (possibly undefined) device name to the concrete router a call will
 * actually hit — its key, friendly label and connection target — so a tool can
 * stamp every result with exactly which physical device it ran on (proof of
 * targeting, never a guess).
 */
export function resolvedTarget(name?: string): {
  key: string;
  label?: string;
  target: string;
} {
  const key = resolveDeviceName(name);
  const dc = active.devices[key];
  return { key, label: dc?.description?.trim() || undefined, target: deviceTarget(dc) };
}

/**
 * Return the connection config for a device by key or label (or the default when
 * `name` is undefined). Throws if an explicit name matches neither a key nor a
 * label, or if the device is disabled.
 */
export function getDevice(name?: string): DeviceConfig {
  // `resolveDeviceName` is the single gate for unknown/disabled names — it
  // throws rather than falling back, so there is no second check to keep in
  // sync here (an earlier duplicate check was dead: callers resolved first).
  const key = resolveDeviceName(name);
  const dc = active.devices[key];
  if (!dc) throw new Error(`No device configuration available for '${key}'.`);
  if (dc.disabled) {
    throw new Error(`Device '${key}' is disabled. Enable it from the dashboard or config file.`);
  }
  return dc;
}
