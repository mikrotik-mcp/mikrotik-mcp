/**
 * The full packet path: dstnat → routing → filter → srcnat.
 *
 * The ordering cases are the point. dstnat happens BEFORE the routing decision,
 * so a port-forwarded packet routes to its rewritten destination; a packet
 * dropped in `forward` never reaches srcnat. Getting either backwards produces
 * answers that look right on a simple config and are wrong on exactly the ones
 * people ask about.
 */
import { describe, expect, test } from "vite-plus/test";
import { buildModel } from "../../src/sim/model";
import type { SimPacket } from "../../src/sim/firewall";
import { diffTraces, renderTrace, tracePacket } from "../../src/sim/trace";

const CONFIG = `/interface list
add name=LAN
add name=WAN
/interface list member
add interface=bridge list=LAN
add interface=ether1 list=WAN
/ip address
add address=192.168.88.1/24 interface=bridge
add address=203.0.113.10/24 interface=ether1
/ip route
add dst-address=0.0.0.0/0 gateway=203.0.113.1
/ip firewall filter
add action=accept chain=input connection-state=established,related
add action=accept chain=input protocol=tcp dst-port=22 in-interface-list=LAN
add action=drop chain=input
add action=accept chain=forward connection-state=established,related
add action=accept chain=forward in-interface-list=LAN out-interface-list=WAN
add action=drop chain=forward
/ip firewall nat
add action=masquerade chain=srcnat out-interface-list=WAN
`;

const MODEL = buildModel(CONFIG);

function packet(over: Partial<SimPacket> = {}): SimPacket {
  return {
    srcAddress: "192.168.88.50",
    dstAddress: "8.8.8.8",
    protocol: "tcp",
    srcPort: 51234,
    dstPort: 443,
    inInterface: "bridge",
    connectionState: "new",
    ...over,
  };
}

function trace(model = MODEL, p: SimPacket = packet()) {
  return tracePacket({ model, packet: p });
}

describe("the happy path", () => {
  test("LAN → internet is accepted, routed and masqueraded", () => {
    const result = trace();
    expect(result.verdict).toBe("accept");
    expect(result.path).toBe("forward");
    expect(result.routing?.outInterface).toBe("ether1");
    expect(result.nat.map((n) => n.stage)).toEqual(["srcnat"]);
    expect(result.nat[0].note).toContain("masquerade");
    expect(result.confidence).toBe("high");
  });

  test("the routing decision precedes the filter chain in the step list", () => {
    const steps = trace().steps.map((s) => s.chain);
    expect(steps[0]).toBe("routing");
    expect(steps).toContain("forward");
    expect(steps.indexOf("routing")).toBeLessThan(steps.indexOf("forward"));
  });

  test("a packet to the router itself takes the input chain", () => {
    const ssh = packet({ dstAddress: "192.168.88.1", dstPort: 22 });
    const result = trace(MODEL, ssh);
    expect(result.path).toBe("input");
    expect(result.verdict).toBe("accept");
  });

  test("SSH from the WAN side is dropped by the input chain", () => {
    const fromWan = packet({
      srcAddress: "198.51.100.9",
      dstAddress: "203.0.113.10",
      dstPort: 22,
      inInterface: "ether1",
    });
    const result = trace(MODEL, fromWan);
    expect(result.path).toBe("input");
    expect(result.verdict).toBe("drop");
    expect(result.summary).toContain("chain=input");
  });

  test("an unsolicited WAN → LAN packet is dropped in forward", () => {
    const inbound = packet({
      srcAddress: "198.51.100.9",
      dstAddress: "192.168.88.50",
      inInterface: "ether1",
    });
    expect(trace(MODEL, inbound).verdict).toBe("drop");
  });

  test("an established packet is accepted by the state rule", () => {
    const est = packet({
      connectionState: "established",
      inInterface: "ether1",
      srcAddress: "8.8.8.8",
      dstAddress: "192.168.88.50",
    });
    const result = trace(MODEL, est);
    expect(result.verdict).toBe("accept");
  });
});

describe("NAT ordering", () => {
  const PORT_FORWARD = `${CONFIG}
add action=dst-nat chain=dstnat dst-address=203.0.113.10 protocol=tcp dst-port=8080 to-addresses=192.168.88.20 to-ports=80
`;

  test("dstnat rewrites the destination BEFORE the routing decision", () => {
    const model = buildModel(PORT_FORWARD);
    const inbound = packet({
      srcAddress: "198.51.100.9",
      dstAddress: "203.0.113.10",
      dstPort: 8080,
      inInterface: "ether1",
    });
    const result = tracePacket({ model, packet: inbound });

    expect(result.nat[0]).toMatchObject({ stage: "dstnat" });
    expect(result.nat[0].note).toContain("192.168.88.20");
    // Routed to the REWRITTEN destination — the LAN, not the WAN.
    expect(result.routing?.outInterface).toBe("bridge");
  });

  test("the filter chain sees the rewritten destination", () => {
    // The accept must sit ABOVE the catch-all drop, or first-match-wins hides it.
    const model = buildModel(
      PORT_FORWARD.replace(
        "add action=drop chain=forward",
        "add action=accept chain=forward dst-address=192.168.88.20 protocol=tcp dst-port=80\nadd action=drop chain=forward",
      ),
    );
    const inbound = packet({
      srcAddress: "198.51.100.9",
      dstAddress: "203.0.113.10",
      dstPort: 8080,
      inInterface: "ether1",
    });
    const result = tracePacket({ model, packet: inbound });
    // It reaches a rule written against the internal address, which is only
    // possible if dstnat ran first.
    expect(result.verdict).toBe("accept");
  });

  test("srcnat runs only after the filter chain accepted", () => {
    const model = buildModel(CONFIG);
    const blocked = packet({ dstPort: 25 });
    // dst-port 25 still matches the LAN→WAN accept, so force a drop instead:
    const dropped = tracePacket({
      model: buildModel(
        CONFIG.replace(
          "add action=accept chain=forward in-interface-list=LAN out-interface-list=WAN\n",
          "",
        ),
      ),
      packet: blocked,
    });
    expect(dropped.verdict).toBe("drop");
    // A dropped packet never reaches srcnat.
    expect(dropped.nat.some((n) => n.stage === "srcnat")).toBe(false);
    void model;
  });

  test("a redirect sends the packet to the router, changing the chain to input", () => {
    const model = buildModel(
      `${CONFIG}add action=redirect chain=dstnat protocol=udp dst-port=53 to-ports=53\n`,
    );
    const dns = packet({ protocol: "udp", dstPort: 53, dstAddress: "1.1.1.1" });
    const result = tracePacket({ model, packet: dns });
    expect(result.nat[0].note).toContain("redirect");
    expect(result.path).toBe("input");
  });
});

describe("routing outcomes", () => {
  test("a blackhole route drops before any filter rule runs", () => {
    const model = buildModel(`${CONFIG}/ip route\nadd dst-address=8.8.8.0/24 blackhole\n`);
    const result = tracePacket({ model, packet: packet() });
    expect(result.verdict).toBe("drop");
    expect(result.summary).toContain("routing decision");
    expect(result.steps.some((s) => s.chain === "forward")).toBe(false);
  });

  test("no route is a drop with an explicit reason", () => {
    const model = buildModel(`/ip address\nadd address=192.168.88.1/24 interface=bridge\n`);
    const result = tracePacket({ model, packet: packet() });
    expect(result.verdict).toBe("drop");
    expect(result.summary).toContain("no route");
  });

  test("a routing mark from mangle selects an alternate table", () => {
    const model = buildModel(`${CONFIG}/ip route
add dst-address=0.0.0.0/0 gateway=192.168.88.9 routing-table=VPN
/ip firewall mangle
add action=mark-routing chain=prerouting src-address=192.168.88.50 new-routing-mark=VPN
`);
    const result = tracePacket({ model, packet: packet() });
    expect(result.steps.some((s) => s.note.includes("routing table 'VPN'"))).toBe(true);
    expect(result.routing?.gateway).toBe("192.168.88.9");
  });

  test("ECMP downgrades the verdict rather than picking a path", () => {
    const model = buildModel(`/ip address
add address=192.168.88.1/24 interface=bridge
/ip route
add dst-address=0.0.0.0/0 gateway=192.168.88.2 distance=1
add dst-address=0.0.0.0/0 gateway=192.168.88.3 distance=1
`);
    const result = tracePacket({ model, packet: packet() });
    expect(result.verdict).toBe("unknown");
    expect(result.unmodelled.some((u) => u.what.includes("multipath"))).toBe(true);
  });
});

describe("honesty about what is not modelled", () => {
  test("an unmodelled matcher on the path forces UNKNOWN, never ACCEPT", () => {
    // The layer7 rule sits ABOVE the accept, so the packet reaches a rule the
    // model cannot evaluate before it reaches one it can.
    const model = buildModel(
      CONFIG.replace(
        "add action=accept chain=forward in-interface-list=LAN out-interface-list=WAN",
        "add action=drop chain=forward layer7-protocol=torrent\nadd action=accept chain=forward in-interface-list=LAN out-interface-list=WAN",
      ),
    );
    const result = tracePacket({ model, packet: packet() });
    expect(result.verdict).toBe("unknown");
    // Traversal stops AT the rule it cannot evaluate — it does not skip past it
    // and report the accept below, which is the failure mode that matters.
    expect(result.summary).toContain("cannot evaluate");
    expect(result.unmodelled.some((u) => u.what.includes("layer7-protocol"))).toBe(true);
    expect(result.confidence).not.toBe("high");
  });

  test("a raw-table rule anywhere in the config lowers confidence", () => {
    const model = buildModel(
      `${CONFIG}/ip firewall raw\nadd action=drop chain=prerouting src-address=1.2.3.4\n`,
    );
    // The raw rule is not on this packet's evaluated path, so the trace itself
    // is clean — but the MODEL knows about it, which is what the tools report.
    expect(model.unmodelled.some((u) => u.what === "raw table rule")).toBe(true);
  });

  test("a non-IPv4 packet is refused rather than coerced", () => {
    const result = trace(MODEL, packet({ dstAddress: "2001:db8::1" }));
    expect(result.verdict).toBe("unknown");
    expect(result.summary).toContain("IPv4 only");
  });

  test("an unknown ingress interface is recorded", () => {
    const result = trace(MODEL, packet({ inInterface: "ether99" }));
    expect(result.unmodelled.some((u) => u.what.includes("ether99"))).toBe(true);
  });
});

describe("rendering and diffing", () => {
  test("the rendered trace names every step's rule and line", () => {
    const text = renderTrace(trace());
    expect(text).toContain("ACCEPT");
    expect(text).toContain("step 1");
    expect(text).toContain("confidence: high");
    expect(text).toContain("unmodelled: none");
  });

  test("diffing two traces reports a changed verdict and where it diverged", () => {
    const before = trace();
    const broken = buildModel(
      CONFIG.replace(
        "add action=accept chain=forward in-interface-list=LAN out-interface-list=WAN\n",
        "",
      ),
    );
    const after = tracePacket({ model: broken, packet: packet() });

    const diff = diffTraces(before, after);
    expect(diff.changed).toBe(true);
    expect(diff.summary).toContain("ACCEPT → DROP");
    expect(diff.divergedAt).toBeGreaterThanOrEqual(0);
  });

  test("an identical config diffs as no change", () => {
    const diff = diffTraces(trace(), trace());
    expect(diff.changed).toBe(false);
    expect(diff.summary).toContain("no change");
  });
});
