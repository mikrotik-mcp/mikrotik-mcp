/**
 * The policy rule-file schema — Zod, so a rule file is validated with
 * line-usable errors before anything evaluates it.
 *
 * **A rule file is untrusted input.** It arrives from a repo, a pull request, or
 * a colleague, so the language is deliberately closed: a fixed predicate set, no
 * expressions, no code, no template interpolation. Evaluating a rule can do
 * nothing but read the parsed config.
 *
 * Two hardening details that are easy to miss:
 *
 * - `matches` regexes are **length-capped and anchored**. An unanchored,
 *   unbounded pattern from an untrusted file is a ReDoS vector aimed at your own
 *   auditor; anchoring also removes the "why does `.*admin` match everything"
 *   class of authoring bug.
 * - **Duplicate rule ids are rejected.** Ids are how findings are suppressed and
 *   tracked over time, so two rules sharing one id makes history meaningless.
 */
import { z } from "zod";

/** Longest permitted `matches` pattern. Long enough for real rules, short
 *  enough that catastrophic backtracking has nothing to chew on. */
export const MAX_REGEX_LENGTH = 200;

export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

const severitySchema = z.enum(SEVERITIES);

const ruleIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "rule id must be lowercase kebab-case (e.g. `wan-rpf-required`)");

/**
 * A regex predicate, compiled once at parse time to prove it is valid and to
 * keep evaluation from recompiling per record.
 */
const regexSchema = z
  .string()
  .min(1)
  .max(MAX_REGEX_LENGTH, `regex must be at most ${MAX_REGEX_LENGTH} characters`)
  .refine(
    (pattern) => {
      try {
        // Compiling proves the pattern is valid; the result is deliberately
        // discarded — evaluation compiles its own anchored copy.
        return Boolean(new RegExp(pattern));
      } catch {
        return false;
      }
    },
    { message: "not a valid regular expression" },
  );

/** `where` narrows which records a rule applies to, by exact field values. */
const whereSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

export const matchSchema = z.object({
  /** Menu path, in either `/ip firewall filter` or `/ip/firewall/filter` form. */
  section: z.string().min(1),
  /** Only records whose fields all equal these values. */
  where: whereSchema.optional(),
  /**
   * Treat the section's `set` lines as ONE record. The natural shape for
   * single-value menus (`/ip/ssh`, `/ip/settings`), where "the field must be X"
   * is a statement about the section, not about a list of rows.
   */
  settings: z.boolean().optional(),
});
export type PolicyMatch = z.infer<typeof matchSchema>;

/** One leaf predicate over a single field. */
const leafSchema = z
  .object({
    field: z.string().min(1),
    present: z.boolean().optional(),
    absent: z.boolean().optional(),
    equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
    not_equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
    in: z
      .array(z.union([z.string(), z.number()]))
      .min(1)
      .optional(),
    not_in: z
      .array(z.union([z.string(), z.number()]))
      .min(1)
      .optional(),
    contains: z.union([z.string(), z.number()]).optional(),
    matches: regexSchema.optional(),
  })
  .strict()
  .refine(
    (leaf) =>
      // Exactly one predicate per leaf: two predicates in one object reads as
      // "and" to an author but would silently evaluate only the first.
      [
        leaf.present,
        leaf.absent,
        leaf.equals,
        leaf.not_equals,
        leaf.in,
        leaf.not_in,
        leaf.contains,
        leaf.matches,
      ].filter((v) => v !== undefined).length === 1,
    {
      message:
        "a field predicate must set exactly one of present/absent/equals/not_equals/in/not_in/contains/matches",
    },
  );
export type PolicyLeaf = z.infer<typeof leafSchema>;

/** `count` constrains how MANY records matched, not their contents. */
const countSchema = z
  .object({
    count: z
      .object({
        min: z.number().int().nonnegative().optional(),
        max: z.number().int().nonnegative().optional(),
        exactly: z.number().int().nonnegative().optional(),
      })
      .strict()
      .refine((c) => c.min !== undefined || c.max !== undefined || c.exactly !== undefined, {
        message: "count must set at least one of min/max/exactly",
      }),
  })
  .strict();

/**
 * The assertion tree. One level of nesting for the combinators is deliberate:
 * `any_of` of `all_of` of leaves covers every real rule, and unbounded recursion
 * in an untrusted file is a complexity budget nobody asked for.
 */
const groupSchema = z.union([
  z.object({ any_of: z.array(leafSchema).min(1) }).strict(),
  z.object({ all_of: z.array(leafSchema).min(1) }).strict(),
  z.object({ none_of: z.array(leafSchema).min(1) }).strict(),
]);

export const assertSchema = z.union([leafSchema, groupSchema, countSchema]);
export type PolicyAssert = z.infer<typeof assertSchema>;

export const policySchema = z
  .object({
    id: ruleIdSchema,
    severity: severitySchema.default("medium"),
    description: z.string().max(500).optional(),
    /** Free-text remediation hint shown with a finding. */
    remediation: z.string().max(500).optional(),
    match: matchSchema,
    assert: assertSchema,
    /**
     * What it means when the section/`where` matches NO records. Default
     * `not-applicable`: a rule about WAN interfaces on a router with no WAN is
     * neither passing nor failing, and counting it as a pass is how a compliance
     * score becomes a lie.
     */
    on_empty: z.enum(["not-applicable", "pass", "fail"]).default("not-applicable"),
    /** Author-facing labels; carried through to findings for filtering. */
    tags: z.array(z.string().max(40)).max(20).default([]),
  })
  .strict();
export type Policy = z.infer<typeof policySchema>;

export const policyFileSchema = z
  .object({
    version: z.literal(1),
    /** Optional file-level label, shown in the rule browser. */
    name: z.string().max(120).optional(),
    policies: z.array(policySchema).min(1),
  })
  .strict()
  .superRefine((file, ctx) => {
    const seen = new Map<string, number>();
    for (const [index, policy] of file.policies.entries()) {
      const first = seen.get(policy.id);
      if (first !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["policies", index, "id"],
          message: `duplicate rule id '${policy.id}' (first defined at policies[${first}]) — ids are how findings are tracked over time`,
        });
        continue;
      }
      seen.set(policy.id, index);
    }
  });
export type PolicyFile = z.infer<typeof policyFileSchema>;

export interface ValidationIssue {
  /** Dotted path into the document, e.g. `policies.2.assert.field`. */
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  file?: PolicyFile;
  issues: ValidationIssue[];
}

/**
 * Parse an already-decoded rule document. Returns issues rather than throwing —
 * validating a file is one of the tools, so an invalid file is a normal result.
 */
export function validatePolicyDocument(document: unknown): ValidationResult {
  const parsed = policyFileSchema.safeParse(document);
  if (parsed.success) return { ok: true, file: parsed.data, issues: [] };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
      message: issue.message,
    })),
  };
}

/**
 * Decode rule-file TEXT. YAML when the runtime provides it (Bun ships
 * `Bun.YAML` natively — no dependency), otherwise JSON.
 *
 * JSON is not a fallback of last resort: it is a strict subset of YAML, so a JSON
 * rule file is a valid rule file everywhere, which is what keeps the pure engine
 * testable on the Node test runner where `Bun` does not exist.
 */
export function decodePolicyText(text: string): { document?: unknown; error?: string } {
  const yaml = (globalThis as { Bun?: { YAML?: { parse(input: string): unknown } } }).Bun?.YAML;
  try {
    if (yaml) return { document: yaml.parse(text) };
    return { document: JSON.parse(text) };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return {
      error: yaml
        ? `not valid YAML or JSON: ${detail}`
        : `not valid JSON: ${detail} (YAML needs the Bun runtime)`,
    };
  }
}

/** Decode and validate rule-file text in one step. */
export function validatePolicyText(text: string): ValidationResult {
  const decoded = decodePolicyText(text);
  if (decoded.error !== undefined) {
    return { ok: false, issues: [{ path: "(root)", message: decoded.error }] };
  }
  return validatePolicyDocument(decoded.document);
}
