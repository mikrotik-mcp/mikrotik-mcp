import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../src/config";
import type { ToolContext } from "../src/core/context";
import { getConfig, setConfig } from "../src/core/runtime";
import { policyTools } from "../src/tools/policy";

const command = vi.hoisted(() => vi.fn());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
vi.mock("../src/policy/load", async () => {
  const { validatePolicyDocument } = await import("../src/policy/schema");
  const result = validatePolicyDocument({
    version: 1,
    policies: [
      {
        id: "ssh-strong",
        severity: "high",
        description: "Strong SSH encryption",
        match: { section: "/ip/ssh", settings: true },
        assert: { field: "strong-crypto", equals: "yes" },
      },
    ],
  });
  if (!result.ok) throw new Error("Invalid policy fixture");
  const policies = result.file!.policies;
  return {
    loadPolicies: (patterns: string[]) =>
      patterns.length
        ? {
            files: [
              { path: "fixture-policy.json", name: "Fixture", policies, issues: [], ok: true },
            ],
            policies,
            duplicateIds: [],
            emptyPatterns: [],
          }
        : { files: [], policies: [], duplicateIds: [], emptyPatterns: [] },
  };
});
const original = getConfig();
const ctx: ToolContext = { device: "lab", info: vi.fn(), error: vi.fn() };
const exportText = "/ip ssh\nset strong-crypto=no\n/ip service\nset telnet disabled=no\n";

function tool(name: string) {
  const found = policyTools.find((entry) => entry.name === name);
  if (!found) throw new Error(`Unknown policy tool ${name}`);
  return found;
}
function config(includeStarterPack: boolean) {
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { lab: { host: "192.0.2.1", port: 22 } },
      defaultDevice: "lab",
      policy: { paths: [], includeStarterPack },
    }),
  );
}
beforeEach(() => {
  config(true);
  command.mockReset().mockResolvedValue(exportText);
});
afterEach(() => setConfig(original));

test("empty policy set is explained and never touches a router", async () => {
  config(false);
  expect(await tool("list_policies").handler({}, ctx)).toContain("No policy rules are loaded");
  expect(await tool("check_policy_snapshot").handler({ config_text: exportText }, ctx)).toContain(
    "No policy rules are loaded",
  );
  expect(command).not.toHaveBeenCalled();
});

test("policy file validation handles missing input, invalid rules and valid JSON", async () => {
  expect(await tool("validate_policy_file").handler({}, ctx)).toContain("Provide either");
  expect(
    await tool("validate_policy_file").handler({ path: "/nonexistent/fixture.json" }, ctx),
  ).toContain("Cannot read");
  expect(
    await tool("validate_policy_file").handler({ content: "not valid yaml: [" }, ctx),
  ).toContain("INVALID");
  const valid = JSON.stringify({
    version: 1,
    policies: [
      {
        id: "ssh-strong",
        severity: "high",
        match: { section: "/ip/ssh", settings: true },
        assert: { field: "strong-crypto", equals: "yes" },
      },
    ],
  });
  expect(await tool("validate_policy_file").handler({ content: valid }, ctx)).toContain(
    "VALID — 1 rule(s)",
  );
  expect(command).not.toHaveBeenCalled();
});

test("starter policies can be listed and evaluated against supplied export text offline", async () => {
  const listed = await tool("list_policies").handler({}, ctx);
  expect(listed).toContain("POLICY RULES");
  const report = await tool("check_policy_snapshot").handler(
    { config_text: exportText, device: "lab" },
    ctx,
  );
  expect(report).toContain("lab");
  expect(report).toContain("explain_policy_finding");
  expect(command).not.toHaveBeenCalled();
});

test("live check reads only /export terse and refuses empty/error output", async () => {
  command.mockResolvedValueOnce("failure: denied");
  expect(await tool("run_policy_check").handler({}, ctx)).toContain(
    "Failed to read the configuration",
  );
  command.mockResolvedValueOnce(exportText);
  expect(await tool("run_policy_check").handler({}, ctx)).toContain("lab");
  expect(command.mock.calls.map(([text]) => text)).toEqual(["/export terse", "/export terse"]);
});

test("finding explanation and SARIF export use the most recent stored report", async () => {
  await tool("check_policy_snapshot").handler({ config_text: exportText, device: "lab" }, ctx);
  expect(
    await tool("explain_policy_finding").handler({ rule_id: "does-not-exist" }, ctx),
  ).toContain("No finding for rule");
  const sarif = await tool("export_policy_report").handler(
    { format: "sarif", artifact: "lab.rsc" },
    ctx,
  );
  expect(sarif).toContain("2.1.0");
  expect(sarif).toContain("lab.rsc");
});
