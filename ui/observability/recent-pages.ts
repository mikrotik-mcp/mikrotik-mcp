import { VIEWS } from "./navigation";
import type { ViewId } from "./navigation";

/** Pages opened most recently, newest first, for the search palette. */
export const RECENT_PAGES_KEY = "mt-recent-pages";
const RECENT_LIMIT = 3;
const knownViews = new Set<string>(VIEWS.map((view) => view.id));

export function readRecentPages(): ViewId[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(RECENT_PAGES_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value
      .filter((id): id is ViewId => typeof id === "string" && knownViews.has(id))
      .slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

export function rememberRecentPage(id: ViewId): void {
  try {
    const next = [id, ...readRecentPages().filter((page) => page !== id)].slice(0, RECENT_LIMIT);
    window.localStorage.setItem(RECENT_PAGES_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: the palette just shows no recent pages */
  }
}
