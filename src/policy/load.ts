/**
 * Rule-file discovery and loading — the only I/O in the whole policy feature.
 *
 * Everything else (`parse`, `schema`, `evaluate`, `report`) is pure; this reads
 * files off disk, validates them, and caches the result. A file that fails
 * validation is kept in the listing WITH its errors rather than dropped: a
 * policy set that silently shrank because someone mistyped a key is worse than
 * one that says so.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getConfig } from "../core/runtime";
import { logger } from "../logger";
import { validatePolicyText } from "./schema";
import type { Policy, ValidationIssue } from "./schema";

export interface LoadedPolicyFile {
  /** Absolute path on disk. */
  path: string;
  /** File-level label from the document, when set. */
  name?: string;
  policies: Policy[];
  issues: ValidationIssue[];
  ok: boolean;
}

export interface PolicySet {
  files: LoadedPolicyFile[];
  /** Every rule from every valid file, in load order. */
  policies: Policy[];
  /** Ids defined in more than one file — the cross-file duplicate case. */
  duplicateIds: string[];
  /** Patterns that matched no files, so "0 rules" is explainable. */
  emptyPatterns: string[];
}

const RULE_EXTENSIONS = [".yaml", ".yml", ".json"];

/**
 * Expand one `dir/*.yaml`-style pattern.
 *
 * Deliberately not a glob library: the supported shape is a directory plus an
 * optional `*.ext` filename pattern, which covers the config default and keeps a
 * dependency (and a whole class of path-traversal surprises) out of a feature
 * whose input is untrusted.
 */
function expand(pattern: string, cwd: string): string[] {
  const absolute = isAbsolute(pattern) ? pattern : resolve(cwd, pattern);
  const base = dirname(absolute);
  const leaf = absolute.slice(base.length + 1);

  if (!leaf.includes("*")) {
    try {
      return statSync(absolute).isDirectory()
        ? readdirSync(absolute)
            .filter((f) => RULE_EXTENSIONS.some((e) => f.endsWith(e)))
            .map((f) => join(absolute, f))
            .sort()
        : [absolute];
    } catch {
      return [];
    }
  }

  const suffix = leaf.replace(/^\*/, "");
  try {
    return readdirSync(base)
      .filter((f) => (suffix === "" ? true : f.endsWith(suffix)))
      .map((f) => join(base, f))
      .sort();
  } catch {
    return [];
  }
}

/** Read and validate one rule file. Never throws. */
export function loadPolicyFile(path: string): LoadedPolicyFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return {
      path,
      policies: [],
      ok: false,
      issues: [
        { path: "(file)", message: `cannot read: ${e instanceof Error ? e.message : String(e)}` },
      ],
    };
  }
  const result = validatePolicyText(text);
  return {
    path,
    name: result.file?.name,
    policies: result.file?.policies ?? [],
    issues: result.issues,
    ok: result.ok,
  };
}

/**
 * Load every configured rule file.
 *
 * Cross-file duplicate ids are reported but not fatal — the in-file case is a
 * schema error, while across files it is usually one pack shadowing another, and
 * the honest move is to name the collision rather than to refuse to run.
 */
export function loadPolicies(patterns?: string[], cwd = process.cwd()): PolicySet {
  const configured = patterns ?? getConfig().policy.paths;
  const files: LoadedPolicyFile[] = [];
  const emptyPatterns: string[] = [];

  for (const pattern of configured) {
    const matches = expand(pattern, cwd);
    if (matches.length === 0) {
      emptyPatterns.push(pattern);
      continue;
    }
    for (const match of matches) files.push(loadPolicyFile(match));
  }

  const policies: Policy[] = [];
  const seen = new Map<string, string>();
  const duplicateIds: string[] = [];
  for (const file of files) {
    if (!file.ok) {
      logger.warn(`policy file ${file.path} has ${file.issues.length} validation issue(s)`);
      continue;
    }
    for (const policy of file.policies) {
      const first = seen.get(policy.id);
      if (first !== undefined && first !== file.path) {
        duplicateIds.push(policy.id);
        continue;
      }
      seen.set(policy.id, file.path);
      policies.push(policy);
    }
  }

  return { files, policies, duplicateIds, emptyPatterns };
}
