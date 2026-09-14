/**
 * Dashboard API client — thin fetch helpers shared by every view.
 *
 * The dashboard may be token-gated; the bearer token is read once from the
 * page URL (`?token=`) and forwarded on every request (as a header, and as a
 * query param for links/EventSource that can't set headers via `withToken`).
 */
const TOKEN = new URLSearchParams(location.search).get("token") ?? "";

/** Append the token as a query param (for links, downloads, WebSocket/SSE URLs). */
export const withToken = (path: string): string =>
  TOKEN ? `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(TOKEN)}` : path;

/** GET a JSON resource, forwarding the token; throws on a non-2xx response. */
export async function api<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(withToken(path), {
    signal,
    headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {},
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/** POST JSON to an API path, forwarding the token; returns the parsed JSON body. */
export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(withToken(path), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: JSON.stringify(body),
  });
  // Config routes return structured errors with non-2xx; surface the JSON body.
  return (await res.json().catch(() => ({}))) as T;
}

/** DELETE with a JSON body, forwarding the token; returns the parsed JSON body. */
export async function deleteJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(withToken(path), {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return (await res.json().catch(() => ({}))) as T;
}

/** Delete events: a list of ids, or everything (`{ all: true }`). */
export async function deleteEvents(body: {
  ids?: string[];
  all?: boolean;
}): Promise<{ removed: number; total: number }> {
  const res = await fetch(withToken("/api/events"), {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as { removed: number; total: number };
}
