/**
 * Sell a hotspot voucher from a payment or billing system.
 *
 * The usual flow: a guest pays, the payment provider calls your billing system,
 * and that system asks here for a voucher to show the guest. This route is that
 * last step: `POST /api/vouchers/issue` creates the voucher on the router and
 * returns its code.
 *
 * - It has its own token, apart from the dashboard token, so a billing system
 *   holds one narrow credential that can only issue vouchers.
 * - A `reference` (the payment id) makes the call safe to repeat: a second call
 *   with the same reference returns the same code and creates nothing. Payment
 *   providers do resend a notification.
 * - It is rate limited, and every issue reaches the audit feed.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { executeMikrotikCommand } from "../core/connector";
import { createContext } from "../core/context";
import { Cmd, looksLikeError, quoted } from "../core/routeros";
import { parseRecords } from "../core/routeros-parse";
import { getConfig, resolveDeviceName } from "../core/runtime";
import { secretOf } from "../core/secret-ref";
import { recordToolCall } from "./recorder";

export interface VoucherIssueConfig {
  token?: string;
  tokenFrom?: string;
  device?: string;
  profile?: string;
  uptimeLimit?: string;
  batch?: string;
  codePrefix?: string;
  maxPerMinute?: number;
}

const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const json = (body: unknown, status = 200): Response => Response.json(body, { status });

/** Compare two secrets in constant time (hashes first, so lengths do not show). */
function sameSecret(given: string, expected: string): boolean {
  const digest = (text: string): Buffer => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

const recent: number[] = [];
/** Forget the rate window (tests only). */
export function resetVoucherIssue(): void {
  recent.length = 0;
}

export async function voucherIssueRoute(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname !== "/api/vouchers/issue") return null;
  const cfg = (getConfig() as { vouchers?: { issue?: VoucherIssueConfig } }).vouchers?.issue;
  // Not configured: the route does not exist. It is never open by accident.
  if (!cfg) return json({ error: "Voucher issuing is not configured." }, 404);
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  let expected: string | undefined;
  try {
    expected = secretOf(cfg.token, cfg.tokenFrom);
  } catch {
    expected = undefined;
  }
  const given = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!expected || !given || !sameSecret(given, expected))
    return json({ error: "A valid voucher token is required." }, 401);

  const now = Date.now();
  while (recent.length > 0 && now - recent[0]! > 60_000) recent.shift();
  if (recent.length >= (cfg.maxPerMinute ?? 30))
    return json({ error: "Too many vouchers in one minute. Try again shortly." }, 429);

  let body: { reference?: unknown };
  try {
    const raw = await req.text();
    if (raw.length > 2048) return json({ error: "Request too large." }, 413);
    body = raw ? (JSON.parse(raw) as { reference?: unknown }) : {};
  } catch {
    return json({ error: "The request body is not JSON." }, 400);
  }
  const reference = body.reference;
  if (reference !== undefined && (typeof reference !== "string" || !REFERENCE.test(reference)))
    return json(
      { error: "reference: use letters, digits, '.', '_', ':' and '-' (64 at most)." },
      400,
    );

  const device = resolveDeviceName(cfg.device);
  const batch = cfg.batch ?? "sold";
  const ctx = createContext(undefined, device);
  ctx.risk = "WRITE";
  const started = Date.now();
  const answer = (code: string, repeated: boolean): Response =>
    json({
      code,
      username: code,
      password: code,
      batch,
      reference,
      repeated,
      validity: cfg.uptimeLimit,
    });
  try {
    if (reference) {
      // The same payment asked again: return its voucher, create nothing.
      const before = parseRecords(
        await executeMikrotikCommand(
          `/ip hotspot user print detail where comment=${quoted(`voucher-batch: ${batch} ref=${reference}`)}`,
          { ...ctx, risk: "READ" },
        ),
      ).rows[0];
      if (before?.name) return answer(before.name, true);
    }
    recent.push(now);
    const code = `${cfg.codePrefix ?? "g"}${randomBytes(4).toString("hex")}`;
    const result = await executeMikrotikCommand(
      new Cmd("/ip hotspot user add")
        .set("name", code)
        .set("password", code)
        .opt("limit-uptime", cfg.uptimeLimit)
        .opt("profile", cfg.profile)
        .set("comment", `voucher-batch: ${batch}${reference ? ` ref=${reference}` : ""}`)
        .build(),
      ctx,
    );
    const failed = looksLikeError(result);
    recordToolCall({
      tool: "voucher_issue",
      title: "Issue a hotspot voucher",
      risk: "WRITE",
      device,
      ts: started,
      durationMs: Date.now() - started,
      isError: failed,
      error: failed ? result.trim() : undefined,
      // The code is a password: the record holds the batch and the reference only.
      args: { batch, reference },
      output: failed ? result.trim() : "1 voucher issued",
      hasStructured: false,
    });
    if (failed) return json({ error: "The router refused the voucher." }, 502);
    return answer(code, false);
  } catch {
    return json({ error: "The router could not be reached." }, 502);
  }
}
