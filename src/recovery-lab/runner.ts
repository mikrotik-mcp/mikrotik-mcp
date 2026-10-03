import { sha256 } from "./model";
/** Administrator-controlled destination, never a tool argument; no redirects or shell/VM spawning. */
export function runnerConfig(): { base: string; token: string; binding: string } | undefined {
  const value = process.env.MIKROTIK_RECOVERY_RUNNER_URL;
  const token = process.env.MIKROTIK_RECOVERY_RUNNER_TOKEN;
  if (!value && !token) return;
  if (!value || !token || token.length < 24 || /[\r\n]/.test(token))
    throw new Error(
      "Recovery runner URL and a token of at least 24 characters must be configured by the administrator.",
    );
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw new Error(
      "Recovery runner needs an HTTPS origin (or explicit loopback HTTP), without path, query or URL credentials.",
    );
  return { base: url.origin, token, binding: sha256(`${url.origin}\n${token}`) };
}
export async function callRunner(
  method: "GET" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const cfg = runnerConfig();
  if (!cfg)
    throw new Error(
      "No isolated recovery runner configured. Prepare and inspect locally; execution is unavailable.",
    );
  if (!/^\/v1\/(capabilities|runs\/[a-f0-9-]{36})$/.test(path))
    throw new Error("Invalid runner operation.");
  if (method === "GET" && body !== undefined)
    throw new Error("Read-only runner operations cannot contain a request body.");
  const options: RequestInit = {
    method,
    headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  };
  if (method !== "GET" && body !== undefined) options.body = JSON.stringify(body);
  const response = await fetch(`${cfg.base}${path}`, options);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Recovery runner returned HTTP ${response.status}; no automatic write retry.`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Runner returned no evidence.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 65536) throw new Error("Runner evidence exceeds the 64 KB limit.");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const part of chunks) {
    data.set(part, offset);
    offset += part.length;
  }
  return JSON.parse(new TextDecoder().decode(data));
}
