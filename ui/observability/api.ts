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

/** Keep the server's sanitised explanation instead of replacing it with HTTP jargon. */
async function responseError(res: Response): Promise<Error> {
  const body: unknown = await res.json().catch(() => null);
  if (body && typeof body === "object" && "error" in body) {
    if (typeof body.error === "string" && body.error.trim()) return new Error(body.error);
  }
  // A proxy/HTML error does not prove the router is disconnected. Never render
  // its raw body (which can contain a stack trace or a complete HTML document).
  const message =
    res.status === 401
      ? "Dashboard authentication required. Check the dashboard token."
      : res.status === 403
        ? "This request is not permitted. Check the dashboard access scope."
        : `The dashboard could not complete this request (HTTP ${res.status}). Please try again.`;
  return new Error(message);
}

/** Keep validation payloads, but do not let a lost device masquerade as an operation result. */
async function mutationResult<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok && body?.code === "DEVICE_CONNECTION_FAILED" && typeof body.error === "string")
    throw new Error(body.error);
  return body as T;
}

/** GET a JSON resource, forwarding the token; throws on a non-2xx response. */
export async function api<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(withToken(path), {
    signal,
    headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {},
  });
  if (!res.ok) throw await responseError(res);
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
  return mutationResult<T>(res);
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
  return mutationResult<T>(res);
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
  if (!res.ok) throw await responseError(res);
  return (await res.json()) as { removed: number; total: number };
}
