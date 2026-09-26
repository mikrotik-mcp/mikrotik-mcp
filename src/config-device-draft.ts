/** Browser-safe draft operations. The source marker is consumed server-side, never persisted. */
export const CREDENTIAL_SOURCE = "$credentialsFrom";
type Draft = Record<string, unknown>;
const devicesOf = (cfg: Draft): Record<string, Draft> =>
  (cfg.devices ?? {}) as Record<string, Draft>;

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
      Object.entries(devices).map(([key, value]) =>
        key === name ? [nextName, copyDevice(value, name)] : [key, value],
      ),
    ),
  };
}
