import type { CheckRun } from "../../src/client-check/model";

export type Measurement = Pick<
  CheckRun,
  "label" | "path" | "idleMs" | "loadedMs" | "download" | "upload" | "errors"
>;
export type TestProgress = { phase: string; samples: number[]; transferred: number };
/** A bounded HTTP experiment, not an ICMP ping or an unconstrained speed test. */
export async function runCheck(
  id: string,
  token: string,
  label: string,
  path: CheckRun["path"],
  signal: AbortSignal,
  onProgress: (p: TestProgress) => void,
): Promise<Measurement> {
  signal = AbortSignal.any([signal, AbortSignal.timeout(90000)]);
  const result: Measurement = {
    label,
    path,
    idleMs: [],
    loadedMs: [],
    download: null,
    upload: null,
    errors: [],
  };
  let transferred = 0;
  const call = async (action: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("x-client-check-token", token);
    const res = await fetch(
      `/client-check-api/${encodeURIComponent(id)}/${action}?n=${Math.random()}`,
      {
        ...init,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
        headers,
      },
    );
    if (!res.ok) throw new Error(`Test phase failed (${res.status})`);
    return res;
  };
  const ping = async (target: number[]) => {
    const start = performance.now();
    await (await call("ping")).json();
    target.push(performance.now() - start);
  };
  const progress = (phase: string) =>
    onProgress({ phase, samples: [...result.idleMs, ...result.loadedMs], transferred });
  try {
    progress("Warming up");
    await ping([]);
    progress("Idle latency");
    try {
      for (let i = 0; i < 8; i++) {
        await ping(result.idleMs);
        progress("Idle latency");
      }
    } catch {
      result.errors.push("idle");
    }
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    for (const direction of ["download", "upload"] as const) {
      const started = performance.now();
      let bytes = 0,
        loading = true;
      // Sample HTTP latency concurrently with transfers; no fabricated packet-loss inference.
      const loaded = (async () => {
        for (let n = 0; n < 16; n++) {
          if (!loading || signal.aborted) break;
          try {
            await ping(result.loadedMs);
          } catch {
            if (!result.errors.includes("loaded")) result.errors.push("loaded");
            break;
          }
          await new Promise((r) => setTimeout(r, 120));
        }
      })();
      progress(direction === "download" ? "Download + loaded latency" : "Upload + loaded latency");
      try {
        for (let i = 0; i < 4; i++) {
          if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
          if (direction === "download") {
            const buffer = await (await call("download")).arrayBuffer();
            if (buffer.byteLength !== 4194304) throw new Error("Incomplete download");
            bytes += buffer.byteLength;
            transferred += buffer.byteLength;
          } else {
            const payload = new Uint8Array(1048576);
            for (let start = 0; start < payload.length; start += 65536)
              crypto.getRandomValues(payload.subarray(start, start + 65536));
            const response = await (
              await call("upload", {
                method: "POST",
                body: payload,
                headers: { "content-type": "application/octet-stream" },
              })
            ).json();
            if (response.bytes !== payload.byteLength) throw new Error("Incomplete upload");
            bytes += response.bytes;
            transferred += response.bytes;
          }
          progress(
            direction === "download" ? "Download + loaded latency" : "Upload + loaded latency",
          );
        }
        result[direction] = { bytes, ms: Math.max(0.01, performance.now() - started) };
      } catch {
        result.errors.push(direction);
      } finally {
        loading = false;
        await loaded;
      }
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    }
  } catch {
    if (signal.aborted) result.errors.push("cancelled");
    else if (!result.errors.includes("idle")) result.errors.push("idle");
  }
  return result;
}
