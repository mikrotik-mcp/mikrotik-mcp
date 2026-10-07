import { createContext } from "../core/context";
import { listOpenVpnSessions } from "../core/openvpn-sessions";
import { getConfig } from "../core/runtime";
import { getSafeModeManager } from "../ssh/safe-mode";
import { getIpGeo, sourceIpLiteral } from "./geo";
import { OPENVPN_HISTORY_INTERVAL } from "./openvpn-history";
import type { OpenVpnHistoryStore } from "./openvpn-history";

/** One bounded read per router per pass; history requests never call a router. */
export function startOpenVpnHistorySampler(store: OpenVpnHistoryStore) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const retries = new Map<string, { at: number; delay: number }>();
  async function sample() {
    for (const [device, config] of Object.entries(getConfig().devices)) {
      if (stopped) return;
      if (config.disabled || config.mac || getSafeModeManager(device).isActive) continue;
      if ((retries.get(device)?.at ?? 0) > Date.now()) continue;
      try {
        const snapshot = await listOpenVpnSessions(createContext(undefined, device));
        if (stopped) return;
        store.ingest({
          ...snapshot,
          sessions: snapshot.sessions.map((s) => ({
            ...s,
            callerId: sourceIpLiteral(s.callerId) ?? s.callerId,
            sourceGeo: getIpGeo(s.callerId),
          })),
        });
        retries.delete(device);
      } catch {
        const delay = Math.min(300_000, (retries.get(device)?.delay ?? 15000) * 2);
        retries.set(device, { at: Date.now() + delay, delay });
        if (!stopped) {
          try {
            store.failure(device);
          } catch {
            /* Retry storage with the next bounded pass. */
          }
        } // A failed read never ends a session.
      }
    }
    if (!stopped) {
      try {
        store.enrich(getIpGeo);
      } catch {
        /* Keep collection alive after a transient store error. */
      }
    }
    if (!stopped) timer = setTimeout(() => void sample(), OPENVPN_HISTORY_INTERVAL);
  }
  void sample();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
