import { expect, test } from "vite-plus/test";
import { buildTripInput, returnSteps } from "../../ui/observability/round-trip-form";
import type { RouterChoice, TripForm } from "../../ui/observability/round-trip-form";
import { roundTripInput, validatePath } from "../../src/paths/round-trip";

const choices: RouterChoice[] = [
  { device: "branch", snapshots: [{ id: "b1", device: "branch", ts: 1000 }] },
  { device: "edge", snapshots: [{ id: "e1", device: "edge", ts: 1100 }] },
];
const form: TripForm = {
  forward: [
    { key: "a", device: "branch", snapshotId: "b1", ingress: "lan", egress: "vpn" },
    { key: "b", device: "edge", snapshotId: "e1", ingress: "vpn", egress: "servers" },
  ],
  reverse: [],
  mirror: true,
  src: "192.0.2.10",
  dst: "198.51.100.10",
  protocol: "tcp",
  srcPort: "49152",
  dstPort: "443",
  maxAge: 900,
  maxSkew: 120,
};
test("guided fields produce a valid backend request, with no editor-only properties", () => {
  const input = buildTripInput(form, choices, 2000);
  expect(roundTripInput.parse(input)).toEqual(input);
  expect(validatePath(input)).toEqual(["branch", "edge"]);
  expect(input.reverse).toEqual([
    { device: "edge", ingress: "servers", egress: "vpn" },
    { device: "branch", ingress: "vpn", egress: "lan" },
  ]);
  expect(JSON.stringify(input)).not.toContain('"key"');
});
test("mirroring does not mutate outbound steps", () => {
  const before = JSON.stringify(form.forward);
  returnSteps(form.forward);
  expect(JSON.stringify(form.forward)).toBe(before);
});
test("custom reverse path keeps explicit interfaces", () => {
  const reverse = returnSteps(form.forward);
  reverse[0].egress = "backup";
  expect(buildTripInput({ ...form, mirror: false, reverse }, choices, 2000).reverse[0].egress).toBe(
    "backup",
  );
});
test("invalid addresses, incomplete choices and wrong device ownership fail early", () => {
  expect(() => buildTripInput({ ...form, src: "example.com" }, choices, 2000)).toThrow("IPv4");
  expect(() => buildTripInput({ ...form, dst: "256.0.0.1" }, choices, 2000)).toThrow("IPv4");
  expect(() =>
    buildTripInput({ ...form, forward: [{ ...form.forward[0], ingress: "" }] }, choices, 2000),
  ).toThrow("select a router");
  expect(() =>
    buildTripInput({ ...form, forward: [{ ...form.forward[0], snapshotId: "e1" }] }, choices, 2000),
  ).toThrow("unavailable");
});
test("snapshot age and skew never silently increase", () => {
  expect(() => buildTripInput(form, choices, 1_000_000)).toThrow("too old");
  expect(() => buildTripInput({ ...form, maxSkew: 0 }, choices, 2000)).toThrow("too far apart");
  expect(() => buildTripInput({ ...form, maxAge: 90000 }, choices, 2000)).toThrow("1–86400");
});
test("ports are mandatory for TCP/UDP, omitted for ICMP", () => {
  expect(() => buildTripInput({ ...form, srcPort: "" }, choices, 2000)).toThrow("ports");
  expect(() => buildTripInput({ ...form, dstPort: "65536" }, choices, 2000)).toThrow("ports");
  expect(
    buildTripInput({ ...form, protocol: "icmp", srcPort: "", dstPort: "" }, choices, 2000).packet,
  ).not.toHaveProperty("srcPort");
});
test("repeated routers and disconnected return endpoints fail early", () => {
  expect(() =>
    buildTripInput({ ...form, forward: [form.forward[0], form.forward[0]] }, choices, 2000),
  ).toThrow("only once");
  expect(() =>
    buildTripInput({ ...form, mirror: false, reverse: form.forward }, choices, 2000),
  ).toThrow("return path must start");
});
