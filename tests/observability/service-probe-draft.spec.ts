import { expect, test } from "vite-plus/test";
import {
  newProbeDraft,
  parseProbeDraft,
  probeTargets,
  updateProbeTarget,
} from "../../ui/observability/service-probe-draft";
import { ProbeTargetSchema } from "../../src/service-contracts/model";
const draft = {
  ...newProbeDraft(),
  alias: "checkout",
  host: "api.example.com",
  addresses: "192.0.2.1, 2001:db8::1/128\n192.0.2.1",
};
test("uses the server schema, trims fields and deduplicates pasted IPv4/IPv6 ranges", () => {
  const result = parseProbeDraft({ ...draft, alias: " checkout ", host: " api.example.com " }, {});
  expect(result.errors).toEqual({});
  expect(result.value?.target.addresses).toEqual(["192.0.2.1", "2001:db8::1/128"]);
  expect(ProbeTargetSchema.safeParse(result.value?.target).success).toBe(true);
});
test.each([
  ["alias", ""],
  ["alias", "bad.id"],
  ["alias", "__proto__"],
  ["alias", "a".repeat(65)],
  ["host", "https://api.example.com"],
  ["host", "host/path"],
  ["host", ""],
  ["port", ""],
  ["port", "65536"],
  ["port", "1.5"],
  ["path", "//evil.test"],
  ["path", "/?secret=bad"],
  ["path", "/#hash"],
  ["path", "/\n"],
  ["addresses", ""],
  ["addresses", "192.0.2.1,not-an-ip"],
  ["addresses", "2001:db8::/129"],
  ["addresses", Array.from({ length: 33 }, (_, n) => `192.0.2.${n}`).join(",")],
])("rejects invalid %s: %s", (key, value) => {
  const result = parseProbeDraft({ ...draft, [key]: value }, {});
  expect(result.errors[key]).toBeTruthy();
  expect(result.value).toBeUndefined();
});
test("rejects duplicates and renames but allows editing the same stable alias", () => {
  const targets = { checkout: parseProbeDraft(draft, {}).value!.target };
  expect(parseProbeDraft(draft, targets).errors.alias).toContain("already in use");
  expect(parseProbeDraft(draft, targets, "checkout").value).toBeDefined();
  expect(
    parseProbeDraft({ ...draft, alias: "different" }, targets, "checkout").errors.alias,
  ).toContain("existing ID");
});
test.each(["dns", "tcp", "tls"] as const)("ignores hidden HTTP path for %s", (kind) => {
  expect(
    parseProbeDraft({ ...draft, kind, path: "bad", port: kind === "dns" ? "" : "8443" }, {}).value
      ?.target,
  ).toMatchObject({ kind, path: "/", port: kind === "dns" ? 443 : 8443 });
});
test("target add/edit/removal preserves schedules, timeout, siblings and input", () => {
  const target = parseProbeDraft(draft, {}).value!.target;
  const cfg = {
    devices: { home: { host: "router" } },
    serviceProbes: { timeoutMs: 2300, scheduled: { home: ["contract"] }, targets: { old: target } },
  };
  const next = updateProbeTarget(cfg, "checkout", target);
  expect(probeTargets(next).checkout).toEqual(target);
  expect(probeTargets(cfg)).not.toHaveProperty("checkout");
  expect(updateProbeTarget(next, "checkout", null)).toEqual(cfg);
  expect(next.serviceProbes).toMatchObject({
    timeoutMs: 2300,
    scheduled: cfg.serviceProbes.scheduled,
  });
});
test("schema-invalid JSON drafts remain renderable without mutating them", () => {
  const cfg = {
    serviceProbes: { targets: { broken: null, partial: { host: "x", addresses: [null, "bad"] } } },
  };
  expect(() =>
    Object.entries(probeTargets(cfg)).map(([id, t]) => newProbeDraft(id, t)),
  ).not.toThrow();
  expect(cfg.serviceProbes.targets.broken).toBeNull();
});
