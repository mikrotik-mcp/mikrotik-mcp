/// <reference types="bun" />
/** Configuration templates: places become safe values, and applying is checked first. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import { MikrotikConfigSchema } from "../src/config";
import {
  checkTemplate,
  renderTemplate,
  templateCommands,
  templateVariables,
} from "../src/core/config-template";
import { getConfig, setConfig } from "../src/core/runtime";

const command = vi.hoisted(() => vi.fn());
const applied = vi.hoisted(() => vi.fn());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
vi.mock("../src/snapshots/capture", () => ({ captureSnapshot: async () => "snap_1" }));
vi.mock("../src/utils/safe-mode-apply", () => ({ applyWritesSafely: applied }));
const { configTemplateTools } = await import("../src/tools/config-template");

const TEMPLATE = `# branch router
/system identity set name={{identity}}
/ip address
add address={{lan_ip}} interface={{lan_if|bridge}} comment={{site}}
add address=10.0.0.1/30 \\
    interface=ether1
:log info ready
`;

test("variables are found with their defaults, and a place inside quotes is refused", () => {
  expect(templateVariables(TEMPLATE)).toEqual([
    { name: "identity", default: undefined },
    { name: "lan_ip", default: undefined },
    { name: "lan_if", default: "bridge" },
    { name: "site", default: undefined },
  ]);
  expect(checkTemplate(TEMPLATE)).toEqual([]);
  expect(checkTemplate('/system note set note="site {{site}}"')[0]).toContain("inside quotes");
  expect(checkTemplate("/system note set note={{ bad name }}")[0]).toContain(
    "not a valid {{variable}}",
  );
  expect(checkTemplate("  ")).toEqual(["The template is empty."]);
});

test("a value is always one RouterOS value: it cannot add a parameter or a command", () => {
  const rendered = renderTemplate(TEMPLATE, {
    identity: "branch 7",
    lan_ip: "192.168.7.1/24",
    site: 'x" disabled=yes ; /system reset-configuration ; "',
  });
  expect(rendered).toContain('name="branch 7"');
  expect(rendered).toContain("address=192.168.7.1/24 interface=bridge");
  expect(rendered).toContain('comment="x\\" disabled=yes ; /system reset-configuration ; \\""');
  expect(() => renderTemplate(TEMPLATE, { identity: "a" })).toThrow("No value for: lan_ip, site");
});

test("export style and continued lines become full commands", () => {
  expect(
    templateCommands(
      renderTemplate(TEMPLATE, { identity: "r1", lan_ip: "10.1.0.1/24", site: "hq" }),
    ),
  ).toEqual([
    "/system identity set name=r1",
    "/ip address add address=10.1.0.1/24 interface=bridge comment=hq",
    "/ip address add address=10.0.0.1/30 interface=ether1",
    ":log info ready",
  ]);
});

const run = async (name: string, args: Record<string, unknown>): Promise<string> => {
  const tool = configTemplateTools.find((t) => t.name === name)!;
  const result = await (tool.handler as (a: unknown, c: unknown) => Promise<unknown>)(
    z.object(tool.inputSchema).parse(args),
    { info() {}, error() {} },
  );
  return typeof result === "string" ? result : (result as { text: string }).text;
};

const original = getConfig();
beforeEach(() => {
  vi.stubEnv("MIKROTIK_TEMPLATE_DIR", mkdtempSync(join(tmpdir(), "templates-")));
  command.mockReset();
  applied.mockReset();
  command.mockResolvedValue("(evl ok)");
  applied.mockResolvedValue({
    applied: 4,
    total: 4,
    safeMode: "committed",
    committed: true,
    fellBack: false,
  });
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { edge: { host: "10.0.0.1" }, core: { host: "10.0.0.2" } },
      defaultDevice: "edge",
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  setConfig(original);
});

test("templates are saved, listed and removed on the host", async () => {
  expect(await run("list_config_templates", {})).toContain("No template yet");
  expect(
    await run("save_config_template", { name: "branch", content: '/x set a="{{b}}"' }),
  ).toContain("Not saved");
  expect(await run("save_config_template", { name: "branch", content: TEMPLATE })).toBe(
    "Saved template 'branch' (4 command(s)). Variables: identity, lan_ip, lan_if (default bridge), site.",
  );
  expect(await run("list_config_templates", {})).toBe(
    "branch: identity, lan_ip, lan_if (default bridge), site",
  );
  const schema = z.object(
    configTemplateTools.find((t) => t.name === "save_config_template")!.inputSchema,
  );
  expect(schema.safeParse({ name: "../../etc/x", content: "a" }).success).toBe(false);
  expect(await run("remove_config_template", { name: "branch" })).toBe(
    "Removed template 'branch'.",
  );
  expect(await run("remove_config_template", { name: "branch" })).toBe(
    "No template named 'branch'.",
  );
});

test("applying renders for each router, parses there first, then writes in Safe Mode", async () => {
  await run("save_config_template", { name: "branch", content: TEMPLATE });
  const args = {
    name: "branch",
    devices: ["edge", "core"],
    variables: { site: "hq" },
    per_device: {
      edge: { identity: "edge-1", lan_ip: "10.1.0.1/24" },
      core: { identity: "core-1", lan_ip: "10.2.0.1/24" },
    },
  };
  const dry = await run("apply_config_template", args);
  expect(dry).toContain("DRY RUN");
  expect(dry).toContain("── edge ──\n  /system identity set name=edge-1");
  expect(dry).toContain("/ip address add address=10.2.0.1/24 interface=bridge comment=hq");
  expect(applied).not.toHaveBeenCalled();
  // Every command was parsed on its own router.
  expect(command.mock.calls.filter((c) => String(c[0]).startsWith(":put [:parse"))).toHaveLength(8);

  const done = await run("apply_config_template", { ...args, apply: true });
  expect(done).toContain("snapshot=snap_1  safe-mode=committed");
  expect(applied.mock.calls.map((c) => c[1])).toEqual(["edge", "core"]);
  expect(applied.mock.calls[0]![3]).toEqual({ allowDirectFallback: false });

  // The built-in variables need no value from the caller.
  await run("save_config_template", {
    name: "note",
    content: "/system note set note={{device}} show-at-login={{host}}",
  });
  expect(await run("apply_config_template", { name: "note", devices: ["edge"] })).toContain(
    "/system note set note=edge show-at-login=10.0.0.1",
  );
});

test("a missing value, an invalid command or a failed router stops the run", async () => {
  await run("save_config_template", { name: "branch", content: TEMPLATE });
  const base = { name: "branch", devices: ["edge", "core"], apply: true };
  expect(await run("apply_config_template", base)).toContain(
    "Not rendered. No value for: identity, lan_ip, site",
  );
  expect(applied).not.toHaveBeenCalled();

  const values = { variables: { identity: "r", lan_ip: "10.1.0.1/24", site: "hq" } };
  command.mockImplementation(async (cmd?: string) =>
    String(cmd).includes("identity")
      ? "(<%% bad command name identity (line 1 column 9))"
      : "(evl ok)",
  );
  const invalid = await run("apply_config_template", { ...base, ...values });
  expect(invalid).toContain("Nothing was written: this router does not accept");
  expect(invalid).not.toContain("── core ──");
  expect(applied).not.toHaveBeenCalled();

  command.mockResolvedValue("(evl ok)");
  applied.mockResolvedValue({
    applied: 1,
    total: 4,
    safeMode: "rolled back",
    committed: false,
    fellBack: false,
    error: "failure: already have such address",
  });
  const failed = await run("apply_config_template", { ...base, ...values });
  expect(failed).toContain("FAILED: failure: already have such address");
  expect(failed).toContain("The routers after this one were not touched.");
  expect(applied).toHaveBeenCalledTimes(1);
  expect(await run("apply_config_template", { name: "nope", devices: ["edge"] })).toContain(
    "No template named 'nope'",
  );
});
