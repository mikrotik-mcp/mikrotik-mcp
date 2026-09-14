import { VIEWS } from "./navigation";
import type { ViewId } from "./navigation";

export const NAVIGATION_PINS_KEY = "mt-pinned-pages";
const knownViews = new Set<string>(VIEWS.map((view) => view.id));
type PinStorage = Pick<Storage, "getItem" | "setItem">;

/** Stale or malformed browser preferences must never create invalid routes. */
export function parseNavigationPins(raw: string | null): ViewId[] {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(value)) return [];
    return [
      ...new Set(value.filter((id): id is ViewId => typeof id === "string" && knownViews.has(id))),
    ];
  } catch {
    return [];
  }
}

export function readNavigationPins(storage?: PinStorage): ViewId[] {
  try {
    return parseNavigationPins((storage ?? window.localStorage).getItem(NAVIGATION_PINS_KEY));
  } catch {
    return [];
  }
}

export function saveNavigationPins(pins: ViewId[], storage?: PinStorage): boolean {
  try {
    (storage ?? window.localStorage).setItem(NAVIGATION_PINS_KEY, JSON.stringify(pins));
    return true;
  } catch {
    return false;
  }
}

export function toggleNavigationPin(pins: ViewId[], id: ViewId): ViewId[] {
  return pins.includes(id) ? pins.filter((pin) => pin !== id) : [...pins, id];
}
