/**
 * Shared lazy-singleton accessor for the LLM tool-feedback store.
 *
 * All consumers — MCP tools (`submit_feedback`, `find_feedback`) and dashboard
 * routes (`/api/feedback/*`) — go through these functions so there is at most
 * **one** SQLite connection to `feedback.db` per process.
 */
import { getConfig } from "../core/runtime";
import { openFeedbackStore } from "./store";
import type { FeedbackStore } from "./store";

let storePromise: Promise<FeedbackStore> | null = null;

/** Fast synchronous check — no DB opened. */
export function isFeedbackEnabled(): boolean {
  try {
    return getConfig().feedback.enabled;
  } catch {
    return false;
  }
}

/** Lazy-open the feedback store. Rejects when feedback is disabled. */
export function getFeedbackStore(): Promise<FeedbackStore> {
  const cfg = getConfig();
  if (!cfg.feedback.enabled)
    return Promise.reject(new Error("LLM tool feedback is disabled in config"));
  if (!storePromise) {
    const pending = openFeedbackStore(cfg.feedback.dbPath);
    storePromise = pending;
    void pending.catch(() => {
      if (storePromise === pending) storePromise = null;
    });
  }
  return storePromise;
}

/** Force the lazy store to re-open on next access. */
export function resetFeedbackStore(): void {
  if (storePromise) {
    storePromise.then((s) => s.close()).catch(() => {});
    storePromise = null;
  }
}

/** Close the store cleanly (for shutdown). */
export function closeFeedbackStore(): void {
  if (storePromise) {
    storePromise.then((s) => s.close()).catch(() => {});
    storePromise = null;
  }
}

/** Publish a validated store only after its configuration has been persisted. */
export function installFeedbackStore(store: FeedbackStore): void {
  closeFeedbackStore();
  storePromise = Promise.resolve(store);
}
