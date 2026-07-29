/**
 * RouterOS REST client (RouterOS 7.9+).
 *
 * Mirrors {@link MikroTikSSHClient}'s shape — `connect()`, `run(command)`,
 * `disconnect()`, `lastError` — so `src/core/transport.ts` picks a transport by
 * config alone, exactly as MAC-Telnet does.
 *
 * Where SSH runs a console command and returns scraped text, this translates the
 * same command into an HTTP request via `bridge.ts`, then renders the JSON reply
 * back into console-shaped text. Handlers are unchanged.
 *
 * HTTP is stateless, so there is no session to hold: `connect()` is a
 * reachability + auth probe against `/rest/system/resource`, and `disconnect()`
 * is a no-op. That also means no per-command handshake — the latency win over
 * SSH.
 *
 * **This transport cannot do everything.** `/export`, Safe Mode and the
 * interactive `/tool` commands have no REST representation; `bridge.toRequest`
 * returns null for them and the caller falls back to SSH. The two error classes
 * below are how that decision is communicated upward.
 */
import { logger } from "../logger";
import { toConsoleText, toRequest } from "./bridge";

/** Thrown when the command has no faithful REST mapping → caller must use SSH. */
export class RestUnmappableError extends Error {
  constructor(readonly command: string) {
    super(`No REST mapping for command: ${command}`);
    this.name = "RestUnmappableError";
  }
}

/**
 * Thrown on a REST HTTP error. `status` decides whether the caller falls back:
 * a 404 means the menu is absent on this RouterOS version (fall back to SSH),
 * while 400/401 are genuine device-side rejections that must surface.
 */
export class RestHttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly command: string,
  ) {
    super(`REST ${status}: ${detail}`);
    this.name = "RestHttpError";
  }
}

/**
 * Whether a failed REST attempt should quietly retry over SSH.
 *
 * The distinction is the whole safety story of this transport:
 *
 * - **Fall back** when REST could not express or reach the command —
 *   unmappable, 404 (menu absent on this RouterOS version), or any
 *   transport-level failure (DNS, TCP, TLS). SSH may well succeed.
 * - **Do not fall back** on 4xx/5xx that is the device *answering* — 400 bad
 *   parameter, 401 auth, 403, 5xx. Re-running a malformed command over SSH
 *   produces a second, differently worded failure, and the operator then debugs
 *   the wrong transport.
 */
export function shouldFallbackToSsh(e: unknown): boolean {
  if (e instanceof RestUnmappableError) return true;
  if (e instanceof RestHttpError) return e.status === 404;
  // Anything else reaching here is a thrown transport/runtime failure.
  return true;
}

export interface RestClientOptions {
  host: string;
  username: string;
  password?: string;
  /** HTTPS port for the `www-ssl` service. */
  port?: number;
  /**
   * Accept a self-signed certificate. RouterOS ships one by default, so most
   * deployments need this — but it disables certificate verification, so it is
   * a deliberate opt-in and never the default.
   */
  insecureTls?: boolean;
  timeoutMs?: number;
}

const DEFAULT_PORT = 443;
const DEFAULT_TIMEOUT_MS = 15_000;

export class MikroTikRestClient {
  private readonly opts: Required<Omit<RestClientOptions, "password">> & { password?: string };
  private readonly auth: string;
  private connected = false;
  lastError?: string;

  constructor(opts: RestClientOptions) {
    this.opts = {
      host: opts.host,
      username: opts.username,
      password: opts.password,
      port: opts.port ?? DEFAULT_PORT,
      insecureTls: opts.insecureTls ?? false,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
    this.auth = `Basic ${btoa(`${opts.username}:${opts.password ?? ""}`)}`;
  }

  private url(path: string, query: Record<string, string> = {}): string {
    const u = new URL(`https://${this.opts.host}:${this.opts.port}/rest/${path}`);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u.toString();
  }

  private async request(
    method: string,
    path: string,
    query: Record<string, string>,
    body?: Record<string, string>,
  ): Promise<Response> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.opts.timeoutMs);
    try {
      return await fetch(this.url(path, query), {
        method,
        headers: {
          authorization: this.auth,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ac.signal,
        // Bun-specific: allows RouterOS's default self-signed certificate.
        // Ignored by runtimes that do not implement it.
        ...(this.opts.insecureTls ? { tls: { rejectUnauthorized: false } } : {}),
      } as RequestInit);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Probe reachability and credentials. Returns false (with `lastError` set)
   * rather than throwing, matching the SSH client's contract.
   */
  async connect(): Promise<boolean> {
    try {
      const res = await this.request("GET", "system/resource", {});
      if (!res.ok) {
        this.lastError =
          res.status === 401
            ? "REST authentication failed (check username/password)"
            : `REST probe failed with HTTP ${res.status}`;
        return false;
      }
      this.connected = true;
      return true;
    } catch (e) {
      this.lastError = describeConnectFailure(e, this.opts.insecureTls);
      return false;
    }
  }

  /**
   * Translate and run one console command.
   *
   * @throws {RestUnmappableError} the command has no REST equivalent.
   * @throws {RestHttpError} the device answered with an error status.
   */
  async run(command: string, _opts: { maxMs?: number } = {}): Promise<string> {
    if (!this.connected) throw new Error("Not connected to MikroTik device (REST)");

    const req = toRequest(command);
    if (!req) throw new RestUnmappableError(command);

    const res = await this.request(req.method, req.path, req.query, req.body);
    if (!res.ok) {
      throw new RestHttpError(res.status, await readErrorDetail(res), command);
    }

    // 204 and empty bodies are valid for DELETE/PATCH.
    const text = await res.text();
    if (!text.trim()) return "";
    try {
      return toConsoleText(JSON.parse(text), req);
    } catch {
      logger.debug(`[rest] non-JSON response for ${command}; passing through`);
      return text;
    }
  }

  /** No-op: HTTP holds no session. Present for {@link DeviceClient} parity. */
  disconnect(): void {
    this.connected = false;
  }
}

/** RouterOS error bodies are `{error, message, detail}`; fall back to the text. */
async function readErrorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; detail?: string };
    return body.detail ?? body.message ?? res.statusText;
  } catch {
    return res.statusText || `HTTP ${res.status}`;
  }
}

/**
 * Turn a fetch rejection into something actionable. A TLS failure against a
 * default RouterOS install is by far the most common first-run problem, so it
 * names the exact setting that fixes it.
 */
function describeConnectFailure(e: unknown, insecureTls: boolean): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (!insecureTls && /certificate|self.signed|SSL|TLS/i.test(msg)) {
    return `REST TLS verification failed (${msg}). RouterOS ships a self-signed certificate — set apiInsecureTls=true for this device to accept it.`;
  }
  if (/abort/i.test(msg)) return "REST probe timed out";
  return `REST connection failed: ${msg}`;
}
