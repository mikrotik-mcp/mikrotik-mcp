import { createSocket } from "node:dgram";
import { createHash } from "node:crypto";
import { createContext } from "../core/context";
import { executeMikrotikCommand } from "../core/connector";
import { parseRecords } from "../core/routeros-parse";
import { getConfig } from "../core/runtime";
import { decodeTzsp } from "../core/tzsp";
import { getFlowCollector } from "../flows/collector";
import { logger } from "../logger";
import { fetchDevices } from "../tools/connected-devices";
import { dnsAnswers, proxyVisit } from "./site-activity";
import type { SiteActivityStore } from "./site-activity";
import type { OpenVpnHistoryStore } from "./openvpn-history";

export const SITE_DNS_PORT = 37009;
const PROXY_INTERVAL = 30_000;
const MAX_LOG_BYTES = 250_000;

export function parseProxyLogRows(
  output: string,
  device: string,
): { id: string; client: string; host: string }[] {
  if (output.length > MAX_LOG_BYTES) throw new Error("Proxy log response exceeds limit");
  const rows: unknown = JSON.parse(output);
  if (!Array.isArray(rows)) throw new Error("Invalid proxy log response");
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const r = row as Record<string, unknown>;
    if (typeof r.message !== "string" || typeof r[".id"] !== "string") return [];
    const visit = proxyVisit(r.message);
    return visit
      ? [
          {
            id: createHash("sha256")
              .update(
                `${device}:${r[".id"]}:${typeof r.time === "string" ? r.time : ""}:${r.message}`,
              )
              .digest("hex"),
            ...visit,
          },
        ]
      : [];
  });
}

export function parseProxyConnections(
  output: string,
): { client: string; destination: string; bytes: number }[] {
  if (output.length > MAX_LOG_BYTES) throw new Error("Proxy connection response exceeds limit");
  const rows: unknown = JSON.parse(output);
  if (!Array.isArray(rows)) throw new Error("Invalid proxy connections response");
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const r = row as Record<string, unknown>;
    if (typeof r["src-address"] !== "string" || typeof r["dst-address"] !== "string") return [];
    const bytes = Number(r["rx-bytes"] ?? 0);
    return [
      {
        client: r["src-address"],
        destination: r["dst-address"],
        bytes: Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : 0,
      },
    ];
  });
}

/** Starts host-side collection only. Router export/logging must be configured separately. */
export async function startSiteActivityCollector(
  store: SiteActivityStore,
  history?: OpenVpnHistoryStore,
): Promise<() => void> {
  const unsubscribe = getFlowCollector().subscribe((records) => store.flows(records));
  const socket = createSocket("udp4");
  let dnsPackets = 0;
  let stopped = false;
  let polling = false;
  const proxyEnabled = new Map<string, { enabled: boolean; expires: number }>();
  let lastLanRead = 0;
  async function identifyClients() {
    const at = Date.now();
    if (history) {
      const owners = history.activeTunnelOwners(at);
      const unique = owners.filter(
        (owner) => owners.filter((other) => other.ip === owner.ip).length === 1,
      );
      store.identify(
        unique.map((owner) => ({
          client: owner.ip,
          kind: "openvpn",
          owner: owner.user,
          device: owner.device,
          mac: "",
          observed: at,
        })),
      );
    }
    if (at - lastLanRead < 300_000) return;
    lastLanRead = at;
    const device = getConfig().defaultDevice;
    const ctx = createContext(undefined, device);
    try {
      const clients = await fetchDevices(ctx);
      let wifi = "";
      try {
        wifi = await executeMikrotikCommand(
          "/interface wifi registration-table print detail",
          ctx,
          { maxMs: 10_000 },
        );
      } catch {
        /* A wired-only router can have no Wi-Fi package. */
      }
      const associated = new Set(
        parseRecords(wifi)
          .rows.map((row) => row["mac-address"]?.toUpperCase())
          .filter(Boolean),
      );
      store.identify(
        clients
          .filter((c) => c.ip && c.mac)
          .map((c) => ({
            client: c.ip,
            kind: associated.has(c.mac.toUpperCase())
              ? "wifi"
              : /^ether/i.test(c.iface)
                ? "lan"
                : "lan-wifi",
            owner: c.host || c.comment || c.mac,
            device,
            mac: c.mac,
            observed: at,
          })),
      );
    } catch (error) {
      logger.warn(`Site client identity read failed: ${String(error)}`);
    }
  }
  socket.on("message", (packet) => {
    const decoded = decodeTzsp(new Uint8Array(packet));
    if (decoded?.encap !== 1 || !decoded.frame) return;
    dnsPackets++;
    const at = Date.now();
    try {
      for (const answer of dnsAnswers(decoded.frame, at))
        store.answer(answer.client, answer.destination, answer.domain, answer.expires, answer.seen);
    } catch (e) {
      logger.warn(`Site DNS evidence could not be saved: ${String(e)}`);
    }
  });
  socket.on("error", (e) => logger.warn(`Site DNS collector: ${e.message}`));
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(SITE_DNS_PORT, () => {
        socket.off("error", reject);
        resolve();
      });
    });
  } catch (e) {
    unsubscribe();
    socket.close();
    throw e;
  }
  async function poll() {
    if (polling || stopped) return;
    polling = true;
    try {
      const policy = store.policy();
      if (!policy.enabled || (policy.until !== null && Date.now() >= policy.until)) return;
      try {
        await identifyClients();
      } catch (e) {
        logger.warn(`Site identity sample failed: ${String(e)}`);
      }
      for (const [device, config] of Object.entries(getConfig().devices)) {
        if (stopped) break;
        if (config.disabled || config.mac) continue;
        let enabled = proxyEnabled.get(device);
        if (!enabled || enabled.expires < Date.now()) {
          try {
            const settings = await executeMikrotikCommand(
              "/ip proxy print",
              createContext(undefined, device),
              { maxMs: 10_000 },
            );
            enabled = {
              enabled: /^\s*enabled:\s*yes\b/im.test(settings),
              expires: Date.now() + 600_000,
            };
            proxyEnabled.set(device, enabled);
          } catch {
            continue;
          }
        }
        if (!enabled.enabled) continue;
        try {
          const connections = await executeMikrotikCommand(
            ":put [:serialize to=json value=[/ip proxy connections print as-value] options=json.no-string-conversion]",
            createContext(undefined, device),
            { maxMs: 10_000 },
          );
          for (const connection of parseProxyConnections(connections))
            store.proxyDestination(
              connection.client,
              connection.destination,
              Date.now(),
              connection.bytes,
            );
        } catch {
          // Proxy disabled or router unreachable; the next pass will retry.
        }
        try {
          const output = await executeMikrotikCommand(
            ':put [:serialize to=json value=[/log print as-value where topics~"web-proxy"] options=json.no-string-conversion]',
            createContext(undefined, device),
            { maxMs: 10_000 },
          );
          for (const visit of parseProxyLogRows(output, device))
            store.proxy(visit.id, visit.client, visit.host, Date.now());
        } catch {
          // Router offline, logging disabled, or Safe Mode busy: retry next pass.
        }
      }
      if (!stopped) {
        try {
          store.prune(Date.now());
        } catch (e) {
          logger.warn(`Site activity pruning failed: ${String(e)}`);
        }
      }
    } finally {
      polling = false;
    }
  }
  void poll();
  const timer = setInterval(() => void poll(), PROXY_INTERVAL);
  logger.info(`Site activity DNS receiver listening on UDP ${SITE_DNS_PORT}`);
  return () => {
    stopped = true;
    clearInterval(timer);
    unsubscribe();
    socket.close();
    logger.info(`Site activity stopped after ${dnsPackets} DNS mirror packet(s)`);
  };
}
