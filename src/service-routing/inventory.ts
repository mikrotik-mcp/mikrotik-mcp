import type { ToolContext } from "../core/context";
import { onConfigChanged } from "../core/runtime";
import type { Row } from "./model";
import { readRoutingRows, readRoutingAddressPage } from "./read";

export const routingSections = {
  tables: "/routing table",
  routes4: "/ip route",
  routes6: "/ipv6 route",
  mangle4: "/ip firewall mangle",
  mangle6: "/ipv6 firewall mangle",
  rules: "/routing rule",
  addresses4: "/ip firewall address-list",
  addresses6: "/ipv6 firewall address-list",
  vrfs: "/ip vrf",
  filters4: "/ip firewall filter",
  filters6: "/ipv6 firewall filter",
} as const;
export type RoutingSectionKey = keyof typeof routingSections;
export interface RoutingSection {
  path: string;
  state: "ready" | "error";
  rows: Row[];
  observedAt: number;
  error?: string;
  total?: number;
  nextOffset?: number;
}
export interface RouterRoutingSnapshot {
  device: string;
  observedAt: number;
  sections: Record<RoutingSectionKey, RoutingSection>;
}
export interface RoutingInventory extends RouterRoutingSnapshot {
  tables: string[];
  targets: { alias: string; host: string }[];
}

/** Per-router short cache and in-flight coalescing. Access is checked by the caller on EVERY hit. */
export function createRoutingInventoryReader(
  read = readRoutingRows,
  addresses = readRoutingAddressPage,
) {
  const cache = new Map<string, { at: number; value: RouterRoutingSnapshot }>();
  const pending = new Map<string, Promise<RouterRoutingSnapshot>>();
  let generation = 0;
  return {
    clear() {
      generation++;
      cache.clear();
      pending.clear();
    },
    async read(device: string, ctx: ToolContext): Promise<RouterRoutingSnapshot> {
      const hit = cache.get(device);
      const ttl =
        hit && Object.values(hit.value.sections).every((s) => s.state === "ready") ? 20_000 : 5000;
      if (hit && Date.now() - hit.at < ttl) return hit.value;
      if (pending.has(device)) return pending.get(device)!;
      const current = generation;
      const work = (async () => {
        const sections = {} as RouterRoutingSnapshot["sections"];
        const deadline = Date.now() + 25_000;
        // Two bounded channels; never launch a request for every section at once.
        const entries = Object.entries(routingSections) as [RoutingSectionKey, string][];
        const worker = async () => {
          for (let entry = entries.shift(); entry; entry = entries.shift()) {
            const [key, path] = entry;
            try {
              if (Date.now() >= deadline)
                throw new Error("Snapshot time budget reached. Refresh to retry this section.");
              const result = key.startsWith("addresses")
                ? await addresses(path, { ...ctx, device })
                : { rows: await read(path, undefined, { ...ctx, device }) };
              sections[key] = { path, ...result, state: "ready", observedAt: Date.now() };
            } catch (e) {
              sections[key] = {
                path,
                rows: [],
                state: "error",
                observedAt: Date.now(),
                error: e instanceof Error ? e.message : "Routing section could not be read.",
              };
            }
          }
        };
        await Promise.all([worker(), worker()]);
        const value = { device, sections, observedAt: Date.now() };
        if (generation === current) cache.set(device, { at: Date.now(), value });
        return value;
      })();
      pending.set(device, work);
      try {
        return await work;
      } finally {
        if (pending.get(device) === work) pending.delete(device);
      }
    },
  };
}
export const routerRoutingInventory = createRoutingInventoryReader();
onConfigChanged(() => routerRoutingInventory.clear());
