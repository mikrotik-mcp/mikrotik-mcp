/**
 * Alert delivery adapters.
 *
 * Every channel is fire-and-forget: `deliver()` never throws and never rejects,
 * because the caller is the recorder path and a hung webhook must not be able to
 * stall — or fail — a tool call. Failures are returned as data.
 *
 * **A webhook URL is a credential.** For Slack, Discord and ntfy the secret *is*
 * the path — anyone holding the URL can post as you. So the URL is masked
 * (scheme + host kept, path replaced) everywhere it could be logged, stored or
 * returned by the API. The generic `redact()` in `observability/event.ts` does
 * not cover this: its key pattern has no `url`/`webhook` term, and widening it
 * would redact the many legitimate non-secret URLs elsewhere in the config.
 *
 * No SSRF guard is claimed or attempted. These URLs are configured deliberately
 * by the operator; pretending to validate them would imply a protection that
 * isn't there.
 */
import { logger } from "../logger";
import type { ChannelName, Severity } from "./model";

/** How long any single delivery attempt may take. */
export const DELIVERY_TIMEOUT_MS = 5000;
/** Attempts after the first. Two means at most three requests total. */
export const MAX_RETRIES = 2;
/** Hard cap on a rendered payload; a truncated alert beats a rejected one. */
export const MAX_PAYLOAD_BYTES = 16 * 1024;

/** What a channel is asked to deliver. */
export interface AlertNotification {
  ruleId: string;
  severity: Severity;
  /** `fire` or `resolve` — a resolve must be visually distinct, not a second alarm. */
  kind: "fire" | "resolve";
  title: string;
  body: string;
  device?: string;
  at: number;
}

export interface ChannelConfig {
  slack?: { url: string };
  discord?: { url: string };
  ntfy?: { url: string; token?: string };
  webhook?: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
  };
  /** The MCP channel needs no config; it uses the connected client. */
  mcp?: Record<string, never>;
}

export interface DeliveryResult {
  channel: ChannelName;
  ok: boolean;
  status?: number;
  error?: string;
  attempts: number;
  durationMs: number;
}

/**
 * Mask a webhook URL for display: keep the scheme and host so it is
 * identifiable, drop the path, which is the part that authenticates.
 *
 * `https://hooks.slack.com/services/T000/B000/XXXX` → `https://hooks.slack.com/…`
 */
export function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    // Not a parseable URL — reveal nothing rather than guessing.
    return "«redacted»";
  }
}

/** A channel config safe to log, store or return from the API. */
export function redactChannels(cfg: ChannelConfig | undefined): Record<string, unknown> {
  if (!cfg) return {};
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(cfg)) {
    if (!value) continue;
    const v = value as { url?: string; token?: string; method?: string };
    out[name] = {
      ...(v.url ? { url: maskUrl(v.url) } : {}),
      ...(v.token ? { token: "«redacted»" } : {}),
      ...(v.method ? { method: v.method } : {}),
      configured: true,
    };
  }
  return out;
}

/** Trim a payload to the cap. A truncated alert is better than a rejected one. */
function cap(text: string): string {
  return text.length <= MAX_PAYLOAD_BYTES ? text : `${text.slice(0, MAX_PAYLOAD_BYTES)}…`;
}

const SEVERITY_EMOJI: Record<Severity, string> = {
  low: "🔵",
  medium: "🟡",
  high: "🟠",
  critical: "🔴",
};

/** One line summarising the notification, shared by the simpler channels. */
export function summarize(n: AlertNotification): string {
  const mark =
    n.kind === "resolve"
      ? "✅ RESOLVED"
      : `${SEVERITY_EMOJI[n.severity]} ${n.severity.toUpperCase()}`;
  const dev = n.device ? ` · ${n.device}` : "";
  return `${mark} · ${n.title}${dev}`;
}

/** Body for a Slack incoming webhook (Block Kit). */
export function slackPayload(n: AlertNotification): unknown {
  return {
    text: summarize(n),
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${summarize(n)}*` } },
      ...(n.body ? [{ type: "section", text: { type: "mrkdwn", text: cap(n.body) } }] : []),
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `rule \`${n.ruleId}\` · <!date^${Math.floor(n.at / 1000)}^{date_short_pretty} {time}|${new Date(n.at).toISOString()}>`,
          },
        ],
      },
    ],
  };
}

/** Body for a Discord webhook (embed). */
export function discordPayload(n: AlertNotification): unknown {
  const color =
    n.kind === "resolve"
      ? 0x57f287
      : { low: 0x5865f2, medium: 0xfee75c, high: 0xeb8f34, critical: 0xed4245 }[n.severity];
  return {
    embeds: [
      {
        title: cap(summarize(n)).slice(0, 256),
        description: cap(n.body).slice(0, 4096),
        color,
        footer: { text: `rule ${n.ruleId}` },
        timestamp: new Date(n.at).toISOString(),
      },
    ],
  };
}

/** A single HTTP attempt with a hard timeout. */
async function attempt(
  url: string,
  init: RequestInit,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    return { ok: res.ok, status: res.status, error: res.ok ? undefined : res.statusText };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** Sleep helper for backoff; injectable so tests do not actually wait. */
let sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Replace the backoff sleep (tests only). Pass nothing to restore. */
export function setDeliverySleep(fn?: (ms: number) => Promise<void>): void {
  sleep = fn ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
}

/**
 * POST with bounded retries. A 4xx is NOT retried — it means the request is
 * wrong (bad URL, revoked webhook), and hammering it three times only makes the
 * log noisier.
 */
interface PostOutcome {
  ok: boolean;
  status?: number;
  error?: string;
  attempts: number;
}

async function post(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  method = "POST",
): Promise<PostOutcome> {
  let last: { ok: boolean; status?: number; error?: string } = {
    ok: false,
    error: "not attempted",
  };
  for (let i = 0; i <= MAX_RETRIES; i++) {
    if (i > 0) await sleep(250 * 2 ** (i - 1));
    last = await attempt(url, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: cap(JSON.stringify(body)),
    });
    if (last.ok) return { ...last, attempts: i + 1 };
    // A client error will not become correct on retry.
    if (last.status !== undefined && last.status >= 400 && last.status < 500) {
      return { ...last, attempts: i + 1 };
    }
  }
  return { ...last, attempts: MAX_RETRIES + 1 };
}

/** Pushes an MCP `notifications/message` to the connected client, if wired. */
let mcpSender: ((n: AlertNotification) => void) | undefined;

/** Register the MCP notification sender (called once by the server). */
export function setMcpAlertSender(fn?: (n: AlertNotification) => void): void {
  mcpSender = fn;
}

/**
 * Deliver one notification on one channel.
 *
 * **Never throws.** Every failure — misconfiguration, timeout, DNS, a channel
 * adapter bug — comes back as `{ok: false}`. The caller is the recorder path,
 * and an alert that cannot be delivered must never become a failed tool call.
 */
export async function deliver(
  channel: ChannelName,
  cfg: ChannelConfig,
  n: AlertNotification,
): Promise<DeliveryResult> {
  const startedAt = Date.now();
  const done = (r: PostOutcome): DeliveryResult => ({
    channel,
    ok: r.ok,
    status: r.status,
    error: r.error,
    attempts: r.attempts,
    durationMs: Date.now() - startedAt,
  });

  try {
    switch (channel) {
      case "slack": {
        if (!cfg.slack?.url)
          return done({ ok: false, error: "slack channel not configured", attempts: 0 });
        return done(await post(cfg.slack.url, slackPayload(n)));
      }
      case "discord": {
        if (!cfg.discord?.url)
          return done({ ok: false, error: "discord channel not configured", attempts: 0 });
        return done(await post(cfg.discord.url, discordPayload(n)));
      }
      case "ntfy": {
        if (!cfg.ntfy?.url)
          return done({ ok: false, error: "ntfy channel not configured", attempts: 0 });
        return done(
          await post(
            cfg.ntfy.url,
            {
              title: summarize(n),
              message: cap(n.body),
              tags: [n.severity],
              priority: n.severity === "critical" ? 5 : 3,
            },
            cfg.ntfy.token ? { authorization: `Bearer ${cfg.ntfy.token}` } : {},
          ),
        );
      }
      case "webhook": {
        if (!cfg.webhook?.url)
          return done({ ok: false, error: "webhook channel not configured", attempts: 0 });
        return done(
          await post(cfg.webhook.url, n, cfg.webhook.headers ?? {}, cfg.webhook.method ?? "POST"),
        );
      }
      case "mcp": {
        if (!mcpSender) return done({ ok: false, error: "no MCP client connected", attempts: 0 });
        mcpSender(n);
        return done({ ok: true, attempts: 1 });
      }
    }
  } catch (e) {
    // A bug in an adapter must not escape into the recorder.
    const error = e instanceof Error ? e.message : String(e);
    logger.debug(`[alerts] channel ${channel} threw: ${error}`);
    return done({ ok: false, error, attempts: 0 });
  }
}
