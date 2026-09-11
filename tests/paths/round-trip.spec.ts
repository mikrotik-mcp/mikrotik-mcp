import { describe, expect, test } from "vite-plus/test";
import { roundTripInput, traceRoundTrip } from "../../src/paths/round-trip";
import { contentSha } from "../../src/snapshots/format";
import type { Snapshot } from "../../src/snapshots/store";

const now = 1_000_000;
const branch = `/ip address
add address=192.0.2.1/24 interface=lan
add address=10.0.0.1/30 interface=transit
/ip route
add dst-address=198.51.100.0/24 gateway=10.0.0.2
`;
const edge = `/ip address
add address=198.51.100.1/24 interface=servers
add address=10.0.0.2/30 interface=transit
/ip route
add dst-address=192.0.2.0/24 gateway=10.0.0.1
`;
function snapshot(device: string, body: string, ts = now): Snapshot {
  return {
    id: device,
    device,
    body,
    ts,
    sha: contentSha(body),
    bytes: body.length,
    lines: body.split("\n").length,
  };
}
function input() {
  return roundTripInput.parse({
    snapshots: [
      { device: "branch", id: "branch" },
      { device: "edge", id: "edge" },
    ],
    forward: [
      { device: "branch", ingress: "lan", egress: "transit" },
      { device: "edge", ingress: "transit", egress: "servers" },
    ],
    reverse: [
      { device: "edge", ingress: "servers", egress: "transit" },
      { device: "branch", ingress: "transit", egress: "lan" },
    ],
    packet: {
      srcAddress: "192.0.2.10",
      dstAddress: "198.51.100.10",
      protocol: "tcp",
      srcPort: 49152,
      dstPort: 443,
    },
  });
}
function run(branchText = branch, edgeText = edge) {
  return traceRoundTrip(input(), [snapshot("branch", branchText), snapshot("edge", edgeText)], now);
}
describe("explicit multi-router round trip", () => {
  test("models both directions, preserving evidence without claiming live delivery", () => {
    const r = run();
    expect(r.status).toBe("modelled");
    expect(r.liveDelivery).toBe("unverified");
    expect(r.forward.hops).toHaveLength(2);
    expect(r.reverse.hops).toHaveLength(2);
    expect(r.asymmetric).toBe(false);
    expect(r.provenance[0].sha).toBe(contentSha(branch));
    expect(JSON.stringify(r)).not.toContain('"raw":');
  });
  test("names forward firewall failure and never fabricates a return tuple", () => {
    const r = run(`${branch}/ip firewall filter\nadd chain=forward action=drop\n`);
    expect(r.status).toBe("blocked");
    expect(r.forward.hops.at(-1)?.device).toBe("branch");
    expect(r.reverse.hops).toHaveLength(0);
  });
  test("reverses ports and assumes established only for the hypothetical reply", () => {
    const r = run(
      branch,
      `${
        edge
      }/ip firewall filter\nadd chain=forward action=drop connection-state=established src-port=443\n`,
    );
    expect(r.forward.status).toBe("modelled");
    expect(r.reverse.status).toBe("blocked");
    expect(r.status).toBe("blocked");
  });
  test("does not propagate guessed masquerade addresses or reverse NAT", () => {
    const r = run(
      `${branch}/ip firewall nat\nadd chain=srcnat out-interface=transit action=masquerade\n`,
    );
    expect(r.status).toBe("unknown");
    expect(r.forward.hops[0].reason).toContain("NAT boundary");
    expect(r.forward.hops[0].trace?.nat).toHaveLength(1);
    expect(r.reverse.hops).toHaveLength(0);
  });
  test.each([
    "/ip dhcp-client\nadd interface=transit\n",
    "/ip firewall raw\nadd chain=prerouting action=drop\n",
    "/ip firewall filter\nadd chain=forward action=drop content=secret\n",
    "/routing rule\nadd action=lookup-only-in-table table=isolated\n",
    "/ip vrf\nadd name=isolated interfaces=lan\n",
    "/ip settings\nset ip-forward=no\n",
  ])("unsupported or runtime-dependent evidence never passes: %s", (extra) => {
    expect(run(branch + extra).status).toBe("unknown");
  });
  test("does not invent the next router when gateway is a different address", () => {
    const r = run(branch.replace("gateway=10.0.0.2", "gateway=10.0.0.3"));
    expect(r.status).toBe("unknown");
    expect(r.forward.hops[0].reason).toContain("next-hop");
  });
  test("egress mismatch is unknown, not a fabricated firewall failure", () => {
    const i = input();
    i.forward[0].egress = "lan";
    const r = traceRoundTrip(i, [snapshot("branch", branch), snapshot("edge", edge)], now);
    expect(r.forward.hops[0].reason).toContain("differs");
  });
  test("ECMP never selects an arbitrary path", () => {
    expect(run(`${branch}add dst-address=198.51.100.0/24 gateway=10.0.0.3\n`).status).toBe(
      "unknown",
    );
  });
  test("blocks a missing return route rather than trusting outbound success", () => {
    const r = run(branch, edge.replace("add dst-address=192.0.2.0/24 gateway=10.0.0.1", ""));
    expect(r.forward.status).toBe("modelled");
    expect(r.reverse.status).toBe("blocked");
  });
  test("rejects missing, wrong-owner, stale, skewed and modified snapshots", () => {
    const a = snapshot("branch", branch);
    const b = snapshot("edge", edge);
    for (const snapshots of [
      [a],
      [a, { ...b, device: "other" }],
      [a, { ...b, ts: 0 }],
      [a, { ...b, ts: now - 121_000 }],
      [a, { ...b, ts: now + 11_000 }],
      [a, { ...b, body: `${b.body}add dst-address=0.0.0.0/0 gateway=transit` }],
    ])
      expect(() => traceRoundTrip(input(), snapshots, now)).toThrow();
  });
  test("rejects loops, duplicate evidence, mismatched endpoints and incomplete port tuples", () => {
    const a = snapshot("branch", branch);
    const b = snapshot("edge", edge);
    const cases = [input(), input(), input(), input()];
    cases[0].forward.push(cases[0].forward[0]);
    cases[1].snapshots.push(cases[1].snapshots[0]);
    cases[2].reverse[0].ingress = "transit";
    cases[3].packet.srcPort = undefined;
    for (const c of cases) expect(() => traceRoundTrip(c, [a, b], now)).toThrow();
  });
  test("return-only routers make conntrack unknown and surface asymmetry", () => {
    const i = input();
    i.snapshots.push({ device: "middle", id: "middle" });
    i.reverse.splice(1, 0, { device: "middle", ingress: "transit", egress: "lan" });
    const r = traceRoundTrip(
      i,
      [snapshot("branch", branch), snapshot("edge", edge), snapshot("middle", branch)],
      now,
    );
    expect(r.asymmetric).toBe(true);
    expect(r.status).toBe("unknown");
    expect(r.reverse.hops[0].reason).toContain("conntrack");
  });
  test("input to a router itself is not transit delivery", () => {
    const i = input();
    i.packet.dstAddress = "198.51.100.1";
    const r = traceRoundTrip(i, [snapshot("branch", branch), snapshot("edge", edge)], now);
    expect(r.status).toBe("unknown");
    expect(r.forward.hops[1].reason).toContain("Router-local");
  });
});
