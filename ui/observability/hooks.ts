import { useEffect, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { withToken } from "./api";
import type { LiveMode, RolloutUpdate, ToolEvent, TxnUpdate } from "./types";

// ── transaction updates ride the SAME socket ────────────────────────────────
// The dashboard opens exactly one live stream; a second view that needs push
// data subscribes here instead of opening its own socket.
const txnListeners = new Set<(u: TxnUpdate) => void>();

/** Subscribe to live transaction updates. Returns an unsubscribe function. */
export function onTxnUpdate(fn: (u: TxnUpdate) => void): () => void {
  txnListeners.add(fn);
  return () => txnListeners.delete(fn);
}

function emitTxn(update: TxnUpdate): void {
  for (const fn of txnListeners) fn(update);
}

const rolloutListeners = new Set<(u: RolloutUpdate) => void>();

/** Subscribe to live fleet-rollout updates. Returns an unsubscribe function. */
export function onRolloutUpdate(fn: (u: RolloutUpdate) => void): () => void {
  rolloutListeners.add(fn);
  return () => rolloutListeners.delete(fn);
}

function emitRollout(update: RolloutUpdate): void {
  for (const fn of rolloutListeners) fn(update);
}

// ── live stream hook (Bun WebSocket, SSE fallback) ───────────────────────────
export function useLiveStream(
  onEvent: (e: ToolEvent) => void,
  onMode: (m: LiveMode) => void,
): void {
  const onEventRef = useRef(onEvent);
  const onModeRef = useRef(onMode);
  onEventRef.current = onEvent;
  onModeRef.current = onMode;

  useEffect(() => {
    let closed = false;
    let ws: WebSocket | null = null;
    let es: EventSource | null = null;

    // Drop the current transport without triggering its auto-reconnect — used
    // before an intentional reconnect so we never end up with two live sockets.
    const teardown = (): void => {
      if (ws) {
        ws.onopen = ws.onerror = ws.onmessage = ws.onclose = null;
        ws.close();
        ws = null;
      }
      if (es) {
        es.close();
        es = null;
      }
    };

    const connectSse = (): void => {
      if (closed) return;
      es = new EventSource(withToken("/api/sse"));
      es.addEventListener("hello", () => onModeRef.current("sse"));
      es.addEventListener("tool", (ev) => {
        try {
          onEventRef.current(JSON.parse((ev as MessageEvent).data) as ToolEvent);
        } catch {
          /* ignore */
        }
      });
      es.onerror = () => {
        if (es && es.readyState === EventSource.CONNECTING) onModeRef.current("off");
      };
    };

    const connectWs = (): void => {
      if (closed) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(withToken(`${proto}://${location.host}/api/stream`));
      let opened = false;
      ws.onopen = () => {
        opened = true;
        onModeRef.current("ws");
      };
      ws.onerror = () => ws?.close();
      ws.onmessage = (m) => {
        try {
          const msg = JSON.parse(m.data) as {
            type: string;
            event?: ToolEvent;
            update?: TxnUpdate | RolloutUpdate;
          };
          if (msg.type === "event" && msg.event) onEventRef.current(msg.event);
          if (msg.type === "txn" && msg.update) emitTxn(msg.update as TxnUpdate);
          if (msg.type === "rollout" && msg.update) emitRollout(msg.update as RolloutUpdate);
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        if (closed) return;
        onModeRef.current("off");
        if (opened) setTimeout(connectWs, 2000);
        else connectSse();
      };
    };

    // A backgrounded tab (or a sleeping machine) often leaves the stream dead:
    // the browser closes the WebSocket, or the SSE fallback errors out with no
    // reconnect path — so the feed silently stops updating until a full reload.
    // When the tab becomes visible again or the network returns, re-establish the
    // stream if it isn't currently open. Reconnecting is cheap and guarantees a
    // live socket whenever the user is actually looking at the page.
    const isLive = (): boolean =>
      ws?.readyState === WebSocket.OPEN || es?.readyState === EventSource.OPEN;
    const revive = (): void => {
      if (closed || isLive()) return;
      teardown();
      connectWs();
    };
    const onVisible = (): void => {
      if (document.visibilityState === "visible") revive();
    };

    connectWs();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", revive);
    return () => {
      closed = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", revive);
      teardown();
    };
  }, []);
}

// ── GSAP scroll reveals ──────────────────────────────────────────────────────
/**
 * Fades + lifts every `.reveal` element into view on scroll. Panels render
 * asynchronously as data lands (devices, topology, capture…), so a
 * MutationObserver arms newcomers too — not just the elements present on mount.
 * Honours `prefers-reduced-motion`: when set, we never hide content (the CSS
 * `.js-motion` gate is also keyed off the class we add here).
 */
export function useReveals(rootRef: RefObject<HTMLElement | null>): void {
  // Layout effect (pre-paint) so reveals are hidden before the first frame — no
  // flash-of-visible-then-animate. If the bundle never runs, nothing is hidden.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    document.documentElement.classList.add("js-motion");

    const seen = new WeakSet<Element>();
    const arm = (el: Element): void => {
      if (seen.has(el)) return;
      seen.add(el);
      gsap.set(el, { opacity: 0, y: 26 });
      ScrollTrigger.create({
        trigger: el,
        start: "top 90%",
        once: true,
        onEnter: () => gsap.to(el, { opacity: 1, y: 0, duration: 0.7, ease: "power3.out" }),
      });
    };
    const scan = (node: ParentNode): void => {
      for (const el of node.querySelectorAll(".reveal")) arm(el);
    };
    scan(root);

    const mo = new MutationObserver((muts) => {
      for (const m of muts)
        for (const n of m.addedNodes) {
          if (!(n instanceof Element)) continue;
          if (n.matches(".reveal")) arm(n);
          scan(n);
        }
    });
    mo.observe(root, { childList: true, subtree: true });

    // The page keeps growing as polled data arrives; recompute trigger offsets
    // for a few seconds so late panels land at the right scroll positions.
    const refresh = setInterval(() => ScrollTrigger.refresh(), 1200);
    const stop = setTimeout(() => clearInterval(refresh), 7000);

    return () => {
      mo.disconnect();
      clearInterval(refresh);
      clearTimeout(stop);
      for (const t of ScrollTrigger.getAll()) t.kill();
      document.documentElement.classList.remove("js-motion");
    };
  }, [rootRef]);
}
