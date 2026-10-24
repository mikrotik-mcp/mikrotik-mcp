/** Real local-file discovery and validation, isolated from project policy config. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { loadPolicies, loadPolicyFile } from "../../src/policy/load";

const dirs: string[] = [];
function directory() {
  const dir = mkdtempSync(join(tmpdir(), "policy-load-deep-"));
  dirs.push(dir);
  return dir;
}
function rule(id: string) {
  return {
    id,
    match: { section: "/ip ssh", settings: true },
    assert: { field: "strong-crypto", equals: "yes" },
  };
}
function put(dir: string, name: string, policies: unknown[]) {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify({ version: 1, name, policies }));
  return path;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("policy file loading", () => {
  test("keeps invalid and unreadable files visible with diagnostic paths", () => {
    const dir = directory();
    const invalid = put(dir, "invalid.json", [{ ...rule("bad"), severity: "urgent" }]);
    const valid = put(dir, "valid.json", [rule("good")]);
    const missing = join(dir, "missing.json");
    const set = loadPolicies([invalid, valid, missing]);
    expect(set.files).toHaveLength(2);
    expect(set.files[0]).toMatchObject({ path: invalid, ok: false, policies: [] });
    expect(set.files[0].issues.some((issue) => issue.path.includes("severity"))).toBe(true);
    expect(set.files[1]).toMatchObject({ path: valid, name: "valid.json", ok: true });
    expect(set.policies.map((policy) => policy.id)).toEqual(["good"]);
    expect(set.emptyPatterns).toEqual([missing]);
    expect(loadPolicyFile(missing)).toMatchObject({ path: missing, ok: false, policies: [] });
    expect(loadPolicyFile(missing).issues[0]).toMatchObject({ path: "(file)" });
  });

  test("directory expansion sorts supported files and excludes unrelated files", () => {
    const dir = directory();
    put(dir, "z.yaml", [rule("z")]);
    put(dir, "a.json", [rule("a")]);
    writeFileSync(join(dir, "notes.txt"), "ignored");
    const set = loadPolicies([dir]);
    expect(set.files.map((file) => file.name)).toEqual(["a.json", "z.yaml"]);
    expect(set.policies.map((policy) => policy.id)).toEqual(["a", "z"]);
  });

  test("wildcard is relative to cwd; cross-file duplicate keeps first definition", () => {
    const dir = directory();
    put(dir, "a.json", [rule("shared"), rule("first")]);
    put(dir, "b.json", [rule("shared"), rule("second")]);
    const set = loadPolicies(["*.json", "*.absent"], dir);
    expect(set.files).toHaveLength(2);
    expect(set.policies.map((policy) => policy.id)).toEqual(["shared", "first", "second"]);
    expect(set.duplicateIds).toEqual(["shared"]);
    expect(set.emptyPatterns).toEqual(["*.absent"]);
  });

  test("invalid JSON is retained with a root parse issue", () => {
    const dir = directory();
    const path = join(dir, "broken.json");
    writeFileSync(path, "{not-json");
    const file = loadPolicyFile(path);
    expect(file.ok).toBe(false);
    expect(file.issues).toMatchObject([{ path: "(root)" }]);
  });
});
