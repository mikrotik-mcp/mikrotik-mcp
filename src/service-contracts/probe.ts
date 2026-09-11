/** Asynchronous service probes from the MCP host, not RouterOS management I/O. */
import { Resolver } from "node:dns/promises";
import { connect, isIP } from "node:net";
import { connect as connectTls } from "node:tls";
import { request } from "node:https";
import { addressAllowed } from "./model";
import type { ProbeTarget } from "./model";

export interface ProbeObservation {
  ok: boolean;
  detail: string;
  httpStatus?: number;
}
export interface ProbeIO {
  resolve(host: string, timeoutMs: number): Promise<string[]>;
  connect(target: ProbeTarget, address: string, timeoutMs: number): Promise<ProbeObservation>;
}

/** Each resolution has its own cancelable resolver; no synchronous DNS or shared cancellation. */
async function resolve(host: string, timeoutMs: number): Promise<string[]> {
  if (isIP(host)) return [host];
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  const timer = setTimeout(() => resolver.cancel(), timeoutMs);
  try {
    const results = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
    const addresses = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    if (!addresses.length) throw new Error("DNS resolution failed");
    return addresses;
  } finally {
    clearTimeout(timer);
  }
}

/** Pin sockets to the validated IP, preserve TLS server identity, never follow HTTP redirects. */
function connectTarget(
  target: ProbeTarget,
  address: string,
  timeoutMs: number,
): Promise<ProbeObservation> {
  return new Promise((resolveResult) => {
    let done = false;
    let close = (): void => {};
    let timer: ReturnType<typeof setTimeout>;
    const finish = (result: ProbeObservation): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      close();
      resolveResult(result);
    };
    timer = setTimeout(() => finish({ ok: false, detail: "Probe deadline exceeded" }), timeoutMs);
    try {
      if (target.kind === "https") {
        const req = request(
          {
            hostname: address,
            port: target.port,
            path: target.path,
            method: "GET",
            servername: isIP(target.host) ? undefined : target.host,
            rejectUnauthorized: true,
            headers: {
              host: `${target.host}:${target.port}`,
              "user-agent": "mikrotik-mcp-service-check",
            },
            agent: false,
          },
          (response) => {
            const code = response.statusCode;
            response.destroy();
            finish({
              ok: code !== undefined,
              httpStatus: code,
              detail: `HTTPS response headers received (${code ?? "unknown"}); body not inspected`,
            });
          },
        );
        close = () => req.destroy();
        req.on("error", () =>
          finish({ ok: false, detail: "HTTPS connection, certificate or protocol check failed" }),
        );
        req.end();
      } else {
        const socket =
          target.kind === "tls"
            ? connectTls({
                host: address,
                port: target.port,
                servername: isIP(target.host) ? undefined : target.host,
                rejectUnauthorized: true,
              })
            : connect({ host: address, port: target.port });
        close = () => socket.destroy();
        socket.once(target.kind === "tls" ? "secureConnect" : "connect", () =>
          finish({
            ok: true,
            detail:
              target.kind === "tls"
                ? "TLS handshake and certificate validation succeeded"
                : "TCP connection established; application protocol not tested",
          }),
        );
        socket.once("error", () =>
          finish({ ok: false, detail: "Connection or certificate check failed" }),
        );
      }
    } catch {
      finish({ ok: false, detail: "Probe could not start" });
    }
  });
}
export const nativeProbeIO: ProbeIO = { resolve, connect: connectTarget };

/** Rebinding-safe: reject the entire answer set if any address leaves the approved ranges. */
export async function probeTarget(
  target: ProbeTarget,
  timeoutMs: number,
  io: ProbeIO = nativeProbeIO,
): Promise<ProbeObservation> {
  const started = Date.now();
  const addresses = await io.resolve(target.host, timeoutMs);
  if (!addresses.length || addresses.some((address) => !addressAllowed(address, target.addresses)))
    throw new Error("DNS answer is outside approved address ranges");
  if (target.kind === "dns")
    return {
      ok: true,
      detail: `${addresses.length} DNS address(es) resolved within approved ranges`,
    };
  const remaining = timeoutMs - (Date.now() - started);
  if (remaining <= 0) throw new Error("Resolution exhausted the probe deadline");
  return io.connect(target, addresses[0], remaining);
}
