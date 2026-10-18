import { expect, test } from "vite-plus/test";
import { verifyPolicy } from "../../src/sim/verify";

const base = { source: "10.0.0.0/24", destination: "192.168.1.0/24" };
test("proves the entire space, with port and CIDR boundaries", () => {
  const report = verifyPolicy({
    ...base,
    config_text:
      "/ip firewall filter\nadd chain=forward src-address=10.0.0.0/25 dst-port=0-100 action=drop\nadd chain=forward action=drop",
  });
  expect(report.status).toBe("proved");
  expect(report.cells).toBe(4);
});
test("finds a narrow allow exception rather than sampling subnet endpoints", () => {
  const report = verifyPolicy({
    ...base,
    config_text:
      "/ip firewall filter\nadd chain=forward src-address=10.0.0.37 dst-port=443 action=accept\nadd chain=forward action=drop",
  });
  expect(report.status).toBe("violated");
  expect(report.witness?.srcAddress).toBe("10.0.0.37");
  expect(report.witness?.dstPort).toBe(443);
  expect(report.trace?.[0].line).toBe(2);
});
test("jump/return and negated address-list boundaries are exhaustive", () => {
  const config_text =
    "/ip firewall address-list\nadd list=trusted address=10.0.0.37\n/ip firewall filter\nadd chain=forward action=jump jump-target=child\nadd chain=forward action=accept\nadd chain=child src-address-list=!trusted action=drop\nadd chain=child action=return";
  const report = verifyPolicy({ ...base, config_text });
  expect(report.status).toBe("violated");
  expect(report.witness?.srcAddress).toBe("10.0.0.37");
});
test.each([
  "/ip firewall filter\nadd chain=forward layer7-protocol=test action=drop",
  "/ip firewall filter\nadd chain=forward action=fasttrack-connection",
  "/ip firewall filter\nadd chain=forward src-address-list=missing action=drop",
  "/ip firewall address-list\nadd list=a address=10.0.0.1 timeout=1h\n/ip firewall filter\nadd chain=forward src-address-list=a action=drop",
])("unsupported/dynamic constructs never prove a policy: %s", (config_text) => {
  expect(verifyPolicy({ ...base, config_text }).status).toBe("unknown");
});
test("enforces complexity cap instead of treating partial checking as proof", () => {
  const rules = Array.from(
    { length: 20 },
    (_, i) =>
      `add chain=forward src-address=10.0.0.${i * 2} dst-address=192.168.1.${i * 2} src-port=${i * 2} dst-port=${i * 2} action=drop`,
  );
  expect(
    verifyPolicy({
      ...base,
      config_text: `/ip firewall filter\n${rules.join("\n")}\nadd chain=forward action=drop`,
    }).reason,
  ).toContain("limit");
});
