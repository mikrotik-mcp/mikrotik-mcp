/**
 * Caller-scoped access control — who may call what, on which device.
 *
 * The server already has three guards, and none of them cover this:
 *   • risk annotations DESCRIBE a tool (the host may show a prompt, or not);
 *   • the Policy Engine lints CONFIGURATION, not callers;
 *   • `readOnly` mode is all-or-nothing for the whole process.
 *
 * What is missing is the middle ground that makes pointing an autonomous agent
 * at production tolerable: *this session may read anything, write to the lab
 * router, and never touch the edge router — for the next two hours.*
 *
 * Deliberately NOT a token-minting/JWT system. Over stdio there is no
 * authenticated caller to bind a token to, so signing one would be security
 * theatre. The trust boundary that actually exists is the configuration file
 * the operator controls, so the policy lives there, and a session may only ever
 * NARROW it at runtime ({@link narrowScope}) — never widen it. That one-way
 * rule is the property worth having: a compromised or confused model cannot
 * talk its way back into permissions its operator did not grant.
 *
 * The evaluator is pure — no I/O, no clock of its own (the caller passes
 * `now`) — so every rule below is unit-tested directly. Only the process-wide
 * policy holder at the bottom touches the active configuration.
 */
import { getConfig, onConfigChanged } from "./runtime";

/** Risk tiers in ascending order of blast radius. Mirrors the registry presets. */
export const RISK_ORDER = [
  "READ",
  "WRITE",
  "WRITE_IDEMPOTENT",
  "DESTRUCTIVE",
  "DANGEROUS",
] as const;
export type RiskLevel = (typeof RISK_ORDER)[number];

/**
 * Rank used for ceiling comparisons. `WRITE` and `WRITE_IDEMPOTENT` share a
 * rank on purpose: idempotence makes a write safer to RETRY, not safer to
 * make, and an operator who allows one plainly means to allow the other.
 */
const RISK_RANK: Record<RiskLevel, number> = {
  READ: 0,
  WRITE: 1,
  WRITE_IDEMPOTENT: 1,
  DESTRUCTIVE: 2,
  DANGEROUS: 3,
};

export interface AccessScope {
  /**
   * Highest risk tier this scope may invoke. Everything above it is denied.
   * Omitted means no ceiling.
   */
  maxRisk?: RiskLevel;
  /**
   * Device keys this scope may target (allow-list). Empty/omitted = every
   * device. Matched against the RESOLVED device key, never the raw argument,
   * so an alias cannot be used to slip past the list.
   */
  devices?: string[];
  /** Device keys this scope may never target. Wins over `devices`. */
  denyDevices?: string[];
  /**
   * Tool-name globs this scope may invoke (allow-list). Empty/omitted = all.
   * `*` matches any run of characters; matching is case-insensitive.
   */
  tools?: string[];
  /** Tool-name globs this scope may never invoke. Wins over `tools`. */
  denyTools?: string[];
  /**
   * Epoch milliseconds after which this scope grants nothing. Omitted = no
   * expiry. Set by {@link narrowScope} when a session asks for a time-boxed
   * grant.
   */
  expiresAt?: number;
  /** Free-text note shown in denial messages and the dashboard audit view. */
  label?: string;
}

/** The effective policy: a configured base, optionally narrowed at runtime. */
export interface AccessPolicy {
  /** Master switch. When false, every call is allowed and this module is inert. */
  enabled: boolean;
  scope: AccessScope;
}

export interface AccessRequest {
  tool: string;
  risk: RiskLevel;
  /** The RESOLVED device key (post-alias), or undefined for no-device tools. */
  device?: string;
  /** Epoch ms. Passed in so the evaluator stays pure and testable. */
  now: number;
}

export interface AccessDecision {
  allowed: boolean;
  /** Present when denied: a sentence the model can act on. */
  reason?: string;
  /** Which rule denied it, for the dashboard's audit view. */
  rule?: "expired" | "risk" | "device" | "tool";
}

// ── Glob matching ───────────────────────────────────────────────────────────

/**
 * Match a tool name against a `*` glob.
 *
 * Anchored at both ends: `list_*` must not match `firewall_list_rules`. Every
 * regex metacharacter except `*` is escaped, so a pattern is data, never a
 * pattern-injection vector into the matcher itself.
 */
export function globMatch(pattern: string, name: string): boolean {
  const rx = new RegExp(
    `^${pattern
      .toLowerCase()
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")}$`,
  );
  return rx.test(name.toLowerCase());
}

function matchesAny(patterns: string[] | undefined, name: string): boolean {
  return (patterns ?? []).some((p) => globMatch(p, name));
}

// ── Evaluation ──────────────────────────────────────────────────────────────

/**
 * Decide whether one call is permitted.
 *
 * Deny-lists are checked before allow-lists throughout, so an operator can hand
 * out a broad grant with a precise carve-out and trust the carve-out to hold.
 */
export function evaluateAccess(policy: AccessPolicy, req: AccessRequest): AccessDecision {
  if (!policy.enabled) return { allowed: true };
  const s = policy.scope;
  const where = s.label ? ` (scope: ${s.label})` : "";

  if (s.expiresAt !== undefined && req.now >= s.expiresAt) {
    return {
      allowed: false,
      rule: "expired",
      reason:
        `Access scope expired at ${new Date(s.expiresAt).toISOString()}${where}. ` +
        "Restart the session or widen the configured policy to continue.",
    };
  }

  if (matchesAny(s.denyTools, req.tool)) {
    return {
      allowed: false,
      rule: "tool",
      reason: `Tool '${req.tool}' is explicitly denied by the active access scope${where}.`,
    };
  }
  if (s.tools && s.tools.length > 0 && !matchesAny(s.tools, req.tool)) {
    return {
      allowed: false,
      rule: "tool",
      reason:
        `Tool '${req.tool}' is outside the active access scope${where}. ` +
        `Allowed: ${s.tools.join(", ")}.`,
    };
  }

  if (req.device !== undefined) {
    if ((s.denyDevices ?? []).some((d) => d.toLowerCase() === req.device!.toLowerCase())) {
      return {
        allowed: false,
        rule: "device",
        reason: `Device '${req.device}' is explicitly denied by the active access scope${where}.`,
      };
    }
    if (
      s.devices &&
      s.devices.length > 0 &&
      !s.devices.some((d) => d.toLowerCase() === req.device!.toLowerCase())
    ) {
      return {
        allowed: false,
        rule: "device",
        reason:
          `Device '${req.device}' is outside the active access scope${where}. ` +
          `Allowed: ${s.devices.join(", ")}.`,
      };
    }
  }

  if (s.maxRisk !== undefined && RISK_RANK[req.risk] > RISK_RANK[s.maxRisk]) {
    return {
      allowed: false,
      rule: "risk",
      reason:
        `'${req.tool}' is a ${req.risk} tool; the active access scope allows at most ` +
        `${s.maxRisk}${where}. Use a read-only alternative, or ask the operator to raise the ` +
        "ceiling in the server configuration.",
    };
  }

  return { allowed: true };
}

// ── Narrowing ───────────────────────────────────────────────────────────────

/**
 * Intersect `base` with `requested`, returning a scope no wider than either.
 *
 * This is the only way a running session changes its own permissions, and every
 * field narrows monotonically:
 *   • ceilings take the LOWER of the two;
 *   • allow-lists INTERSECT (an empty base list means "all", so the request
 *     wins; an empty request means "unchanged", so the base wins);
 *   • deny-lists UNION — a denial can never be dropped;
 *   • expiry takes the EARLIER of the two.
 *
 * The consequence worth stating: calling this can only ever cost the session
 * permissions. There is no argument that returns a wider scope than `base`.
 */
export function narrowScope(base: AccessScope, requested: AccessScope): AccessScope {
  const out: AccessScope = { ...base };

  if (requested.maxRisk !== undefined) {
    out.maxRisk =
      base.maxRisk === undefined || RISK_RANK[requested.maxRisk] < RISK_RANK[base.maxRisk]
        ? requested.maxRisk
        : base.maxRisk;
  }

  const intersect = (a: string[] | undefined, b: string[] | undefined): string[] | undefined => {
    if (!b || b.length === 0) return a;
    if (!a || a.length === 0) return b;
    const lower = new Set(a.map((x) => x.toLowerCase()));
    return b.filter((x) => lower.has(x.toLowerCase()));
  };
  out.devices = intersect(base.devices, requested.devices);
  // Tool allow-lists are globs, so a literal set intersection is wrong: `list_*`
  // and `list_ip_*` have no common STRING but a real common meaning. Keeping
  // both lists and requiring a name to satisfy each would need an AND-list the
  // evaluator does not model, so the narrower approach is to keep the REQUESTED
  // list when one is given — it can only be checked against, never around, and
  // the base's deny-list survives untouched below.
  out.tools = requested.tools && requested.tools.length > 0 ? requested.tools : base.tools;

  out.denyDevices = [...new Set([...(base.denyDevices ?? []), ...(requested.denyDevices ?? [])])];
  out.denyTools = [...new Set([...(base.denyTools ?? []), ...(requested.denyTools ?? [])])];
  if (out.denyDevices.length === 0) delete out.denyDevices;
  if (out.denyTools.length === 0) delete out.denyTools;

  if (requested.expiresAt !== undefined) {
    out.expiresAt =
      base.expiresAt === undefined
        ? requested.expiresAt
        : Math.min(base.expiresAt, requested.expiresAt);
  }
  if (requested.label) out.label = requested.label;

  return out;
}

// ── Process-wide active policy ──────────────────────────────────────────────

/**
 * The live policy. Held here rather than in `runtime.ts` so that a config
 * reload (which replaces the whole `MikrotikConfig`) cannot silently discard a
 * runtime narrowing: `installAccessPolicy` re-applies the session's narrowing
 * on top of whatever base the new config carries.
 */
let basePolicy: AccessPolicy = { enabled: false, scope: {} };
let sessionNarrowing: AccessScope | undefined;

/** Install the configured base policy (called on startup and on config reload). */
export function installAccessPolicy(policy: AccessPolicy): void {
  basePolicy = policy;
}

/**
 * Adopt the `access` block from the active configuration.
 *
 * Subscribed rather than pushed from `setConfig` because the config is replaced
 * from a dozen call sites (CLI startup, the dashboard's config editor, device
 * add/remove). Registering from this side means every one of them re-installs
 * the policy without each having to remember to — and a session's runtime
 * narrowing survives, because it is applied on top in {@link getAccessPolicy}.
 */
function adoptConfiguredPolicy(): void {
  const a = getConfig().access;
  installAccessPolicy({
    enabled: a.enabled,
    scope: {
      maxRisk: a.maxRisk,
      devices: a.devices,
      denyDevices: a.denyDevices,
      tools: a.tools,
      denyTools: a.denyTools,
      label: a.label,
    },
  });
}
onConfigChanged(adoptConfiguredPolicy);
adoptConfiguredPolicy();

/** The effective policy: configured base, intersected with any runtime narrowing. */
export function getAccessPolicy(): AccessPolicy {
  if (!sessionNarrowing) return basePolicy;
  return {
    // A narrowing implies enforcement even if the base was permissive —
    // otherwise asking for less would grant more.
    enabled: true,
    scope: narrowScope(basePolicy.scope, sessionNarrowing),
  };
}

/** Narrow the current session. Returns the resulting effective scope. */
export function narrowSession(requested: AccessScope): AccessScope {
  sessionNarrowing = sessionNarrowing
    ? narrowScope(sessionNarrowing, requested)
    : narrowScope(basePolicy.scope, requested);
  return getAccessPolicy().scope;
}

/** Test seam: drop any runtime narrowing. Never called by the server itself. */
export function resetSessionScope(): void {
  sessionNarrowing = undefined;
}

// ── Denial audit trail ──────────────────────────────────────────────────────

export interface AccessDenial {
  ts: number;
  tool: string;
  risk: RiskLevel;
  device?: string;
  rule: NonNullable<AccessDecision["rule"]>;
  reason: string;
}

/**
 * Recent denials, newest last. A bounded ring rather than a table in the events
 * DB: denials must be recorded even when the dashboard (and therefore the
 * SQLite store) is disabled, and an unbounded array in a long-lived process is
 * a slow leak.
 */
const DENIAL_LIMIT = 200;
const denials: AccessDenial[] = [];

export function recordDenial(d: AccessDenial): void {
  denials.push(d);
  if (denials.length > DENIAL_LIMIT) denials.splice(0, denials.length - DENIAL_LIMIT);
}

export function recentDenials(limit = DENIAL_LIMIT): AccessDenial[] {
  return denials.slice(-limit).reverse();
}

/** Test seam. */
export function clearDenials(): void {
  denials.length = 0;
}
