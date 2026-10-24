import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import { clearDenials, installAccessPolicy, resetSessionScope } from "../src/core/access";
import { accessTools } from "../src/tools/access";

function run(name: string, args: Record<string, unknown> = {}) {
  const tool = accessTools.find((item) => item.name === name);
  if (!tool) throw new Error(name);
  return tool.handler(z.object(tool.inputSchema ?? {}).parse(args) as never, {} as never);
}
beforeEach(() => {
  vi.useRealTimers();
  resetSessionScope();
  clearDenials();
  installAccessPolicy({ enabled: false, scope: {} });
});

describe("access introspection and self narrowing", () => {
  test("disabled policy explains unrestricted access", () => {
    expect(run("get_access_scope")).toContain("ACCESS SCOPE: not enforced");
  });

  test("enforced scope renders restrictions and can omit denials", () => {
    installAccessPolicy({
      enabled: true,
      scope: {
        maxRisk: "READ",
        devices: ["edge"],
        denyDevices: ["lab"],
        tools: ["get_*"],
        denyTools: ["get_secret"],
        label: "audit",
      },
    });
    const text = run("get_access_scope", { denials: 0 });
    expect(text).toContain("max risk    : READ");
    expect(text).toContain("devices     : edge");
    expect(text).toContain("denied devs : lab");
    expect(text).toContain("denied tools: get_secret");
    expect(text).not.toContain("RECENT DENIALS");
  });

  test("narrowing displays effective lower ceiling and device intersection", () => {
    installAccessPolicy({ enabled: true, scope: { maxRisk: "WRITE", devices: ["edge", "lab"] } });
    const text = run("narrow_access_scope", {
      max_risk: "READ",
      devices: ["lab", "other"],
      deny_tools: ["remove_*"],
      label: "review",
    });
    expect(text).toContain("max risk    : READ");
    expect(text).toContain("devices     : lab");
    expect(text).toContain("denied tools: remove_*");
    expect(run("get_access_scope", { denials: 0 })).toContain("label       : review");
    expect(run("narrow_access_scope", { max_risk: "DANGEROUS" })).toContain("max risk    : READ");
  });

  test("disjoint devices render no overlap", () => {
    installAccessPolicy({ enabled: true, scope: { devices: ["edge"] } });
    expect(run("narrow_access_scope", { devices: ["lab"] })).toContain(
      "(none: scopes do not overlap)",
    );
  });

  test("schema rejects excessive denial count and expiry", () => {
    expect(() => run("get_access_scope", { denials: 201 })).toThrow();
    expect(() => run("narrow_access_scope", { expires_in_minutes: 10081 })).toThrow();
  });
});
