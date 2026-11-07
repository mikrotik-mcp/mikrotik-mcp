import { executeMikrotikJson } from "../core/connector";
import { createContext } from "../core/context";
import { Cmd } from "../core/routeros";
import { onConfigChanged, resolveDeviceName } from "../core/runtime";
import { assertDeviceAccess } from "../core/scoped-access";
import { bandwidthAddresses } from "./service";
import type { BandwidthInventory } from "./types";

const cache = new Map<string, { expires: number; promise: Promise<BandwidthInventory> }>();
onConfigChanged(() => cache.clear());

/** Coalesce selector reads for 30 seconds; never use cached inventory to authorize a test. */
export async function bandwidthInventory(device: string): Promise<BandwidthInventory> {
  const name = resolveDeviceName(device);
  assertDeviceAccess([name], "bandwidth_test", "READ");
  let entry = cache.get(name);
  if (!entry || entry.expires <= Date.now()) {
    const promise = Promise.all([
      executeMikrotikJson(
        new Cmd("/interface print").raw("detail").build(),
        createContext(undefined, name),
        { maxMs: 20_000 },
      ),
      bandwidthAddresses(name),
    ]).then(([output, addresses]) => ({
      interfaces: output.rows
        .filter((row) => row.name)
        .map((row) => ({
          name: row.name,
          disabled: ["true", "yes"].includes(row.disabled) || /X/.test(row.flags ?? ""),
          running: ["true", "yes"].includes(row.running) || /R/.test(row.flags ?? ""),
        })),
      addresses,
    }));
    entry = { expires: Infinity, promise };
    cache.set(name, entry);
    void promise.then(
      () => {
        const current = cache.get(name);
        if (current?.promise === promise) current.expires = Date.now() + 30_000;
      },
      () => {
        if (cache.get(name)?.promise === promise) cache.delete(name);
      },
    );
  }
  const result = await entry.promise;
  assertDeviceAccess([name], "bandwidth_test", "READ");
  return result;
}
