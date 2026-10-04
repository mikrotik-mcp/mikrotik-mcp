/** Browser-safe draft operations. The source marker is consumed server-side, never persisted. */
export const CREDENTIAL_SOURCE = "$credentialsFrom";
type Draft = Record<string, unknown>;
const devicesOf = (cfg: Draft): Record<string, Draft> =>
  (cfg.devices ?? {}) as Record<string, Draft>;

/** Write a schema field; clearing the last nested field removes its empty parent too. */
export function setDraftField(value: Draft, key: string, fieldValue: unknown): Draft {
  const [head, ...rest] = key.split(".");
  const next = { ...value };
  if (!rest.length) {
    if (fieldValue === undefined || fieldValue === "") delete next[head];
    else next[head] = fieldValue;
  } else {
    const current = next[head];
    const child = setDraftField(
      current && typeof current === "object" && !Array.isArray(current) ? (current as Draft) : {},
      rest.join("."),
      fieldValue,
    );
    if (!Object.keys(child).length) delete next[head];
    else next[head] = child;
  }
  return next;
}

export type ConfigScope = "devices" | "server" | "serviceProbes";

function ownsConfigKey(key: string, scope: ConfigScope): boolean {
  if (scope === "serviceProbes") return key === "serviceProbes";
  const deviceKey = key === "devices" || key === "defaultDevice";
  return scope === "devices" ? deviceKey : !deviceKey;
}

/** Select only settings owned by this editor, including the narrow probe editor. */
export function selectConfigScope(cfg: Draft, scope: ConfigScope): Draft {
  return Object.fromEntries(Object.entries(cfg).filter(([key]) => ownsConfigKey(key, scope)));
}

/** Merge against live state on the server, not a stale browser snapshot. */
export function scopeConfigDraft(raw: unknown, current: Draft, scope: ConfigScope): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  return {
    ...Object.fromEntries(Object.entries(current).filter(([key]) => !ownsConfigKey(key, scope))),
    ...selectConfigScope(raw as Draft, scope),
  };
}

export function addDevice(cfg: Draft): { config: Draft; name: string } {
  const devices = devicesOf(cfg);
  let name = "device";
  for (let i = 2; Object.hasOwn(devices, name); i++) name = `device-${i}`;
  return {
    name,
    config: {
      ...cfg,
      defaultDevice: cfg.defaultDevice || name,
      devices: {
        ...devices,
        [name]: {
          host: "192.168.88.1",
          port: 22,
          username: "admin",
          password: "",
          timeoutMs: 10000,
        },
      },
    },
  };
}

function copyDevice(device: Draft, name: string): Draft {
  const copy = structuredClone(device);
  if (JSON.stringify(copy).includes('"«redacted»"'))
    copy[CREDENTIAL_SOURCE] = device[CREDENTIAL_SOURCE] ?? name;
  return copy;
}

export function duplicateDevice(cfg: Draft, source: string): { config: Draft; name: string } {
  const devices = devicesOf(cfg);
  if (!Object.hasOwn(devices, source)) throw new Error("Source device no longer exists");
  let name = `${source}-copy`;
  for (let i = 2; Object.hasOwn(devices, name); i++) name = `${source}-copy-${i}`;
  const entries = Object.entries(devices).flatMap(([key, value]) =>
    key === source
      ? [
          [key, value],
          [name, copyDevice(value, source)],
        ]
      : [[key, value]],
  );
  return { name, config: { ...cfg, devices: Object.fromEntries(entries) } };
}

export function renameDevice(cfg: Draft, name: string, nextName: string): Draft {
  const devices = devicesOf(cfg);
  if (!nextName.trim()) throw new Error("Name cannot be empty.");
  if (nextName === name) return cfg;
  if (Object.hasOwn(devices, nextName))
    throw new Error(`A device named "${nextName}" already exists.`);
  if (!Object.hasOwn(devices, name)) throw new Error("Device no longer exists.");
  return {
    ...cfg,
    defaultDevice: cfg.defaultDevice === name ? nextName : cfg.defaultDevice,
    devices: Object.fromEntries(
      Object.entries(devices).map(([key, value]) => [
        key === name ? nextName : key,
        {
          ...(key === name ? copyDevice(value, name) : value),
          ...(value.jumpVia === name ? { jumpVia: nextName } : {}),
        },
      ]),
    ),
  };
}

export function reorderDevices(cfg: Draft, order: string[]): Draft {
  const devices = devicesOf(cfg);
  if (
    order.length !== Object.keys(devices).length ||
    new Set(order).size !== order.length ||
    order.some((name) => !Object.hasOwn(devices, name))
  )
    return cfg;
  return { ...cfg, devices: Object.fromEntries(order.map((name) => [name, devices[name]])) };
}
