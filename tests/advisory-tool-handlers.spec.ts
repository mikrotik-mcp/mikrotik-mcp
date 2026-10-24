import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../src/config";
import { getConfig, setConfig } from "../src/core/runtime";
import { advisoryTools, collectDeviceFacts } from "../src/tools/advisories";

const mocks = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: mocks.command }));
const original = getConfig();
const ctx = { device: "fixture", info: vi.fn(), error: vi.fn() };

async function call(name: string, args: Record<string, unknown> = {}) {
  const tool = advisoryTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(name);
  return tool.handler(args as never, ctx);
}

beforeEach(() => {
  vi.clearAllMocks();
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { fixture: { host: "192.0.2.1", port: 22 } },
      defaultDevice: "fixture",
    }),
  );
  mocks.command.mockImplementation(
    async (command: string) =>
      ({
        "/system resource print": "version: 6.48.0\nboard-name: lab-board",
        "/ip service print detail":
          "0 name=winbox port=8291 address=\n1 X name=www port=80 disabled=yes\n2 name=ssh port=22 address=192.0.2.0/24,198.51.100.1",
        "/system package print detail": "0 name=routeros\n1 X name=wireless disabled=yes",
      })[command] ?? "",
  );
});
afterEach(() => setConfig(original));

test("collector parses live service exposure and package enablement using only three reads", async () => {
  const facts = await collectDeviceFacts("fixture");
  expect(facts).toMatchObject({ device: "fixture", version: "6.48.0", board: "lab-board" });
  expect(facts.services).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "winbox", disabled: false, allowedFrom: [] }),
      expect.objectContaining({ name: "ssh", allowedFrom: ["192.0.2.0/24", "198.51.100.1"] }),
      expect.objectContaining({ name: "www", disabled: true }),
    ]),
  );
  expect(facts.packages).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "wireless", enabled: false })]),
  );
  expect(mocks.command).toHaveBeenCalledTimes(3);
});

test("one failed read does not conceal facts from the other sources", async () => {
  mocks.command.mockImplementation(async (command: string) => {
    if (command.includes("service")) throw new Error("offline service table");
    return command.includes("resource") ? "version: 6.48.0" : "failure: permission denied";
  });
  const facts = await collectDeviceFacts("fixture");
  expect(facts.version).toBe("6.48.0");
  expect(facts.services).toEqual([]);
  expect(facts.packages).toEqual([]);
});

test("audit reports matched advisories and warns when version cannot be read", async () => {
  const report = await call("audit_known_vulnerabilities", { include_mitigated: true });
  expect(report).toContain("KNOWN-VULNERABILITY AUDIT");
  expect(report).toContain("RouterOS 6.48.0 on lab-board");
  expect(report).toContain("Advisory dataset reviewed");
  mocks.command.mockResolvedValue("failure: permission denied");
  const unknown = await call("audit_known_vulnerabilities", { all_devices: true });
  expect(unknown).toContain("NOT audited");
  expect(unknown).toContain("unknown, not clean");
});

test("dataset search is local, case-insensitive, and explicit when unmatched", async () => {
  const all = await call("list_security_advisories");
  expect(all).toContain("ROUTEROS ADVISORY DATASET");
  expect(mocks.command).not.toHaveBeenCalled();
  expect(
    await call("list_security_advisories", { id_filter: "cVe-THAT-DOES-NOT-EXIST" }),
  ).toContain("No advisory matches");
});
