/**
 * Human approval for changes an AI asks for.
 *
 * When approvals are on, a tool call at or above the configured risk does not
 * run. It becomes a request that waits for a person in the dashboard. After the
 * person approves it, the model calls the same tool again with the same
 * arguments and that one call runs.
 *
 * An approval is for exactly one call: the tool, the router and the arguments
 * are hashed together, so an approved request cannot be spent on other
 * arguments. It is used once, and it expires.
 *
 * Only the dashboard can decide a request. There is no tool for it, so the
 * model cannot approve its own change.
 *
 * Requests live in memory. A restart clears them; a change that was waiting is
 * simply requested again.
 */
import { createHash, randomBytes } from "node:crypto";
import type { RiskLevel } from "./access";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "used" | "expired";

export interface ApprovalRequest {
  id: string;
  tool: string;
  title: string;
  risk: RiskLevel;
  device?: string;
  /** The arguments, with secrets redacted, for the person who decides. */
  args: unknown;
  /** The reason a DANGEROUS tool was given. */
  reason?: string;
  status: ApprovalStatus;
  requestedAt: number;
  expiresAt: number;
  decidedAt?: number;
  /** What the person wrote when they decided. */
  note?: string;
}

export interface ApprovalPolicy {
  enabled?: boolean;
  /** The lowest risk that needs approval. Default DESTRUCTIVE. */
  minRisk?: "WRITE" | "DESTRUCTIVE" | "DANGEROUS";
  /** How long a request, and then its approval, stays valid. Default 30. */
  ttlMinutes?: number;
}

const RANK: Record<RiskLevel, number> = {
  READ: 0,
  WRITE: 1,
  WRITE_IDEMPOTENT: 1,
  DESTRUCTIVE: 2,
  DANGEROUS: 3,
};
const MAX_REQUESTS = 200;

interface Entry extends ApprovalRequest {
  fingerprint: string;
}
const requests = new Map<string, Entry>();
let onRequest: ((request: ApprovalRequest) => void) | undefined;

/** Called for each new request (the server sends a notification). */
export function setApprovalNotifier(fn?: (request: ApprovalRequest) => void): void {
  onRequest = fn;
}

/** Forget every request (tests only). */
export function resetApprovals(): void {
  requests.clear();
}

/** JSON with object keys in a fixed order, so equal arguments hash equally. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function fingerprintOf(tool: string, device: string | undefined, args: unknown): string {
  return createHash("sha256")
    .update(canonical([tool, device ?? "", args]))
    .digest("hex");
}

export function needsApproval(policy: ApprovalPolicy | undefined, risk: RiskLevel): boolean {
  return policy?.enabled === true && RANK[risk] >= RANK[policy.minRisk ?? "DESTRUCTIVE"];
}

function expire(now: number): void {
  for (const [id, entry] of requests) {
    if (entry.expiresAt > now) continue;
    // A used or decided request stays a while as a record, then goes.
    if (entry.status === "pending" || entry.status === "approved") entry.status = "expired";
    if (now - entry.expiresAt > 24 * 60 * 60 * 1000) requests.delete(id);
  }
  while (requests.size > MAX_REQUESTS) requests.delete(requests.keys().next().value as string);
}

export interface ApprovalCall {
  tool: string;
  title: string;
  risk: RiskLevel;
  device?: string;
  /** The real arguments: hashed, never stored. */
  args: unknown;
  /** The same arguments with secrets redacted: stored and shown. */
  shownArgs: unknown;
  reason?: string;
}

/**
 * Decide whether a call may run now. An approved request for the same call is
 * spent; otherwise the call is refused with what the model must do next.
 */
export function checkApproval(
  policy: ApprovalPolicy,
  call: ApprovalCall,
  now = Date.now(),
): { allowed: true; id: string } | { allowed: false; text: string } {
  expire(now);
  const fingerprint = fingerprintOf(call.tool, call.device, call.args);
  const open = Array.from(requests.values())
    .reverse()
    .find(
      (entry) =>
        entry.fingerprint === fingerprint &&
        (entry.status === "pending" || entry.status === "approved" || entry.status === "rejected"),
    );
  if (open?.status === "approved") {
    open.status = "used";
    return { allowed: true, id: open.id };
  }
  if (open?.status === "rejected")
    return {
      allowed: false,
      text:
        `Not run: a person rejected this change (request ${open.id})` +
        `${open.note ? `: ${open.note}` : "."} Do not ask for it again. Tell the user it was rejected.`,
    };
  if (open?.status === "pending")
    return {
      allowed: false,
      text:
        `Not run: request ${open.id} still waits for a person to approve it in the dashboard ` +
        "(Access page, Approvals). Do not retry in a loop. Tell the user it is waiting.",
    };

  const ttl = (policy.ttlMinutes ?? 30) * 60_000;
  const entry: Entry = {
    id: `apr_${randomBytes(4).toString("hex")}`,
    fingerprint,
    tool: call.tool,
    title: call.title,
    risk: call.risk,
    device: call.device,
    args: call.shownArgs,
    reason: call.reason,
    status: "pending",
    requestedAt: now,
    expiresAt: now + ttl,
  };
  requests.set(entry.id, entry);
  try {
    onRequest?.(publicView(entry));
  } catch {
    // a failed notification must not change the answer
  }
  return {
    allowed: false,
    text:
      `Not run: this ${call.risk} change needs a person to approve it. Request ${entry.id} now ` +
      "waits in the dashboard (Access page, Approvals). Nothing was changed. Tell the user to " +
      `approve it, then call ${call.tool} again with exactly the same arguments. The request ` +
      `expires in ${policy.ttlMinutes ?? 30} minutes.`,
  };
}

function publicView(entry: Entry): ApprovalRequest {
  const { fingerprint: _fingerprint, ...request } = entry;
  return request;
}

/** Every request, newest first, for the dashboard. */
export function listApprovals(now = Date.now()): ApprovalRequest[] {
  expire(now);
  return Array.from(requests.values()).reverse().map(publicView);
}

/**
 * A person approves or rejects a pending request. An approval is valid for a
 * full time-to-live from the moment it is given.
 */
export function decideApproval(
  id: string,
  approve: boolean,
  note: string | undefined,
  ttlMinutes = 30,
  now = Date.now(),
): ApprovalRequest | null {
  expire(now);
  const entry = requests.get(id);
  if (!entry || entry.status !== "pending") return null;
  entry.status = approve ? "approved" : "rejected";
  entry.decidedAt = now;
  entry.expiresAt = now + ttlMinutes * 60_000;
  entry.note = note?.trim().slice(0, 500) || undefined;
  return publicView(entry);
}
