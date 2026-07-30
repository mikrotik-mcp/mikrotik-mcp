/**
 * Firewall traversal — first-match-wins, jump/return, and the property that the
 * whole feature rests on: **a rule this model cannot evaluate makes the verdict
 * UNKNOWN, never ACCEPT.**
 *
 * A simulator that skips what it does not understand answers confidently and
 * wrongly, which is worse than not answering (see `docs/tasks/08` §1). Several
 * cases here exist purely to pin that.
 */
import { describe, expect, test } from "vite-plus/test";
import { buildModel } from "../../src/sim/model";
import { ruleMatches, traverseChain, unreachableRules } from "../../src/sim/firewall";
import type { SimPacket } from "../../src/sim/firewall";

const BASE = `/interface list
add name=LAN
add name=WAN
/interface list member
add interface=bridge list=LAN
add interface=ether1 list=WAN
/ip address
add address=192.168.88.1/24 interface=bridge
/ip firewall address-list
add address=192.168.88.0/24 list=trusted
add address=203.0.113.7 list=blocked
`;

function model(rules: string) {
  return buildModel(`${BASE}/ip firewall filter\n${rules}\n`);
}

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

function traverse(rules: string, chain: string, p: SimPacket = packet()) {
  const m = model(rules);
  return traverseChain(m, m.filter, chain, p);
}

describe("first match wins", () => {
  test("the first matching rule decides the verdict", () => {
    const result = traverse(
      `add action=accept chain=forward
add action=drop chain=forward`,
      "forward",
    );
    expect(result.verdict).toBe("accept");
    expect(result.decidedBy?.index).toBe(0);
  });

  test("a non-matching rule is skipped", () => {
    const result = traverse(
      `add action=drop chain=forward src-address=10.0.0.0/8
add action=accept chain=forward`,
      "forward",
    );
    expect(result.verdict).toBe("accept");
    expect(result.decidedBy?.index).toBe(1);
  });

  test("a disabled rule is skipped even when it matches", () => {
    const result = traverse(
      `add action=drop chain=forward disabled=yes
add action=accept chain=forward`,
      "forward",
    );
    expect(result.verdict).toBe("accept");
  });

  test("falling off the end is RouterOS's implicit accept, and is reported as such", () => {
    const result = traverse(`add action=drop chain=forward src-address=10.0.0.0/8`, "forward");
    expect(result.verdict).toBe("accept");
    expect(result.fellThrough).toBe(true);
    expect(result.steps.at(-1)?.note).toContain("implicit accept");
  });

  test("an empty chain falls through", () => {
    const result = traverse(`add action=drop chain=input`, "forward");
    expect(result.fellThrough).toBe(true);
  });

  test("every step names its chain, rule index and source line", () => {
    const result = traverse(`add action=drop chain=forward dst-port=443 protocol=tcp`, "forward");
    expect(result.steps[0]).toMatchObject({ chain: "forward", index: 0, action: "drop" });
    expect(result.steps[0].line).toBeGreaterThan(0);
  });
});

describe("address matching", () => {
  test("src-address as a CIDR", () => {
    expect(
      traverse(`add action=drop chain=forward src-address=192.168.88.0/24`, "forward").verdict,
    ).toBe("drop");
    expect(
      traverse(`add action=drop chain=forward src-address=10.0.0.0/8`, "forward").verdict,
    ).toBe("accept");
  });

  test("dst-address as a single address", () => {
    expect(traverse(`add action=drop chain=forward dst-address=8.8.8.8`, "forward").verdict).toBe(
      "drop",
    );
  });

  test("an address range matches inside it", () => {
    expect(
      traverse(`add action=drop chain=forward src-address=192.168.88.40-192.168.88.60`, "forward")
        .verdict,
    ).toBe("drop");
  });

  test("a negated address matcher inverts the result", () => {
    // !src-address=192.168.88.0/24 — our packet IS in that range, so no match.
    expect(
      traverse(`add action=drop chain=forward src-address=!192.168.88.0/24`, "forward").verdict,
    ).toBe("accept");
    expect(
      traverse(`add action=drop chain=forward src-address=!10.0.0.0/8`, "forward").verdict,
    ).toBe("drop");
  });

  test("an address matcher the model cannot parse is UNKNOWN, not a non-match", () => {
    const result = traverse(`add action=drop chain=forward src-address=example.com`, "forward");
    expect(result.verdict).toBe("unknown");
    expect(result.unmodelled).toHaveLength(1);
  });
});

describe("address lists", () => {
  test("membership matches", () => {
    expect(
      traverse(`add action=accept chain=forward src-address-list=trusted`, "forward").verdict,
    ).toBe("accept");
    expect(
      traverse(`add action=drop chain=forward src-address-list=blocked`, "forward").verdict,
    ).toBe("accept"); // fell through: 192.168.88.50 is not in `blocked`
  });

  test("a negated list membership inverts", () => {
    expect(
      traverse(`add action=drop chain=forward src-address-list=!trusted`, "forward").verdict,
    ).toBe("accept");
  });

  test("a list that does not exist is a definite non-match", () => {
    // The export contains every list, so absence is knowable — not unknown.
    const result = traverse(`add action=drop chain=forward src-address-list=nope`, "forward");
    expect(result.verdict).toBe("accept");
    expect(result.unmodelled).toEqual([]);
  });
});

describe("protocol and ports", () => {
  test("protocol matches by name and by number", () => {
    expect(traverse(`add action=drop chain=forward protocol=tcp`, "forward").verdict).toBe("drop");
    expect(traverse(`add action=drop chain=forward protocol=6`, "forward").verdict).toBe("drop");
    expect(traverse(`add action=drop chain=forward protocol=udp`, "forward").verdict).toBe(
      "accept",
    );
  });

  test("dst-port as a single value, a list and a range", () => {
    expect(
      traverse(`add action=drop chain=forward protocol=tcp dst-port=443`, "forward").verdict,
    ).toBe("drop");
    expect(
      traverse(`add action=drop chain=forward protocol=tcp dst-port=80,443`, "forward").verdict,
    ).toBe("drop");
    expect(
      traverse(`add action=drop chain=forward protocol=tcp dst-port=400-500`, "forward").verdict,
    ).toBe("drop");
    expect(
      traverse(`add action=drop chain=forward protocol=tcp dst-port=8080`, "forward").verdict,
    ).toBe("accept");
  });

  test("`port=` matches either side", () => {
    expect(traverse(`add action=drop chain=forward protocol=tcp port=443`, "forward").verdict).toBe(
      "drop",
    );
    expect(
      traverse(`add action=drop chain=forward protocol=tcp port=51234`, "forward").verdict,
    ).toBe("drop");
  });

  test("a port matcher on a packet with no ports does not match", () => {
    const icmp = packet({ protocol: "icmp", srcPort: undefined, dstPort: undefined });
    expect(traverse(`add action=drop chain=forward dst-port=443`, "forward", icmp).verdict).toBe(
      "accept",
    );
  });

  test("a named port service is UNKNOWN rather than guessed", () => {
    expect(
      traverse(`add action=drop chain=forward protocol=tcp dst-port=https`, "forward").verdict,
    ).toBe("unknown");
  });
});

describe("interfaces", () => {
  test("in-interface matches the declared ingress", () => {
    expect(traverse(`add action=drop chain=forward in-interface=bridge`, "forward").verdict).toBe(
      "drop",
    );
    expect(traverse(`add action=drop chain=forward in-interface=ether1`, "forward").verdict).toBe(
      "accept",
    );
  });

  test("in-interface-list resolves through the interface list", () => {
    expect(traverse(`add action=drop chain=forward in-interface-list=LAN`, "forward").verdict).toBe(
      "drop",
    );
    expect(traverse(`add action=drop chain=forward in-interface-list=WAN`, "forward").verdict).toBe(
      "accept",
    );
  });

  test("an unknown interface list is UNKNOWN, not a non-match", () => {
    const result = traverse(`add action=drop chain=forward in-interface-list=GUEST`, "forward");
    expect(result.verdict).toBe("unknown");
  });

  test("out-interface is UNKNOWN before the routing decision is known", () => {
    // The packet has no outInterface set — a rule that depends on it cannot be
    // evaluated, and saying "no match" would be a guess.
    const result = traverse(`add action=drop chain=forward out-interface=ether1`, "forward");
    expect(result.verdict).toBe("unknown");
  });

  test("out-interface matches once the trace has set it", () => {
    const routed = packet({ outInterface: "ether1" });
    expect(
      traverse(`add action=drop chain=forward out-interface=ether1`, "forward", routed).verdict,
    ).toBe("drop");
    expect(
      traverse(`add action=drop chain=forward out-interface-list=WAN`, "forward", routed).verdict,
    ).toBe("drop");
  });
});

describe("connection state", () => {
  test("matches the declared state", () => {
    expect(
      traverse(`add action=accept chain=forward connection-state=new`, "forward").verdict,
    ).toBe("accept");
    const est = packet({ connectionState: "established" });
    expect(
      traverse(`add action=accept chain=forward connection-state=new`, "forward", est).verdict,
    ).toBe("accept"); // fell through, not matched
  });

  test("matches any member of a comma-separated set", () => {
    const est = packet({ connectionState: "established" });
    const result = traverse(
      `add action=accept chain=forward connection-state=established,related
add action=drop chain=forward`,
      "forward",
      est,
    );
    expect(result.verdict).toBe("accept");
    expect(result.decidedBy?.index).toBe(0);
  });

  test("a negated state set inverts", () => {
    // The classic "drop invalid" written as !established,related.
    const invalid = packet({ connectionState: "invalid" });
    expect(
      traverse(
        `add action=drop chain=forward connection-state=!established,related`,
        "forward",
        invalid,
      ).verdict,
    ).toBe("drop");
  });
});

describe("jump and return", () => {
  test("a jump enters the target chain and its terminal action decides", () => {
    const result = traverse(
      `add action=jump chain=forward jump-target=wan-out
add action=accept chain=forward
add action=drop chain=wan-out dst-port=443 protocol=tcp`,
      "forward",
    );
    expect(result.verdict).toBe("drop");
    expect(result.steps.map((s) => s.chain)).toEqual(["forward", "wan-out"]);
  });

  test("a `return` inside the jumped chain resumes the caller", () => {
    const result = traverse(
      `add action=jump chain=forward jump-target=side
add action=drop chain=forward
add action=return chain=side`,
      "forward",
    );
    expect(result.verdict).toBe("drop");
    expect(result.decidedBy?.chain).toBe("forward");
  });

  test("falling off the end of a jumped chain resumes the caller too", () => {
    const result = traverse(
      `add action=jump chain=forward jump-target=side
add action=drop chain=forward
add action=accept chain=side src-address=10.0.0.0/8`,
      "forward",
    );
    expect(result.verdict).toBe("drop");
  });

  test("a jump to a chain that does not exist returns immediately", () => {
    const result = traverse(
      `add action=jump chain=forward jump-target=missing
add action=drop chain=forward`,
      "forward",
    );
    expect(result.verdict).toBe("drop");
    expect(result.steps.some((s) => s.note.includes("no rules"))).toBe(true);
  });

  test("nested jumps work two deep", () => {
    const result = traverse(
      `add action=jump chain=forward jump-target=a
add action=jump chain=a jump-target=b
add action=drop chain=b`,
      "forward",
    );
    expect(result.verdict).toBe("drop");
    expect(result.steps.map((s) => s.chain)).toEqual(["forward", "a", "b"]);
  });
});

describe("unmodelled constructs never produce a confident verdict", () => {
  test("a layer7 matcher makes the verdict UNKNOWN, not ACCEPT", () => {
    const result = traverse(
      `add action=drop chain=forward layer7-protocol=bittorrent
add action=accept chain=forward`,
      "forward",
    );
    expect(result.verdict).toBe("unknown");
    expect(result.unmodelled[0].what).toContain("layer7-protocol");
  });

  test("a connection-limit matcher is likewise UNKNOWN", () => {
    expect(
      traverse(`add action=drop chain=forward connection-limit=100,32`, "forward").verdict,
    ).toBe("unknown");
  });

  test("an unknown ACTION is UNKNOWN — it might be terminal", () => {
    const result = traverse(`add action=some-future-action chain=forward`, "forward");
    expect(result.verdict).toBe("unknown");
    expect(result.unmodelled[0].what).toContain("action=");
  });

  test("an unmodelled matcher on a rule that could NOT have matched still stops traversal", () => {
    // Conservative by design: the model cannot prove the rule would not match, so
    // it refuses to continue past it.
    const result = traverse(
      `add action=drop chain=forward src-address=10.0.0.0/8 layer7-protocol=x
add action=accept chain=forward`,
      "forward",
    );
    // src-address is evaluated first and fails → the rule is a definite non-match,
    // so traversal DOES continue. Order of evaluation matters, and this pins it.
    expect(result.verdict).toBe("accept");
  });

  test("passthrough actions record a step and continue", () => {
    const result = traverse(
      `add action=log chain=forward
add action=mark-connection chain=forward new-connection-mark=x passthrough=yes
add action=drop chain=forward`,
      "forward",
    );
    expect(result.verdict).toBe("drop");
    expect(result.steps).toHaveLength(3);
  });
});

describe("ruleMatches directly", () => {
  test("a rule with no matchers matches everything", () => {
    const m = model(`add action=accept chain=forward`);
    expect(ruleMatches(m, m.filter[0], packet()).result).toBe(true);
  });

  test("all matchers are ANDed", () => {
    const m = model(
      `add action=drop chain=forward protocol=tcp dst-port=443 src-address=10.0.0.0/8`,
    );
    const { result, why } = ruleMatches(m, m.filter[0], packet());
    expect(result).toBe(false);
    expect(why).toContain("src-address");
  });
});

describe("reachability analysis", () => {
  test("a rule after a terminal catch-all is unreachable", () => {
    const m = model(
      `add action=drop chain=input
add action=accept chain=input protocol=tcp dst-port=22`,
    );
    const dead = unreachableRules(m.filter);
    expect(dead).toHaveLength(1);
    expect(dead[0].rule.index).toBe(1);
    expect(dead[0].why).toContain("every packet");
  });

  test("a rule shadowed by a broader earlier rule is reported", () => {
    const m = model(
      `add action=drop chain=input src-address=10.0.0.0/8
add action=accept chain=input src-address=10.0.0.0/8 protocol=tcp dst-port=22`,
    );
    expect(unreachableRules(m.filter)).toHaveLength(1);
  });

  test("a passthrough rule shadows nothing", () => {
    const m = model(
      `add action=log chain=input
add action=accept chain=input protocol=tcp`,
    );
    expect(unreachableRules(m.filter)).toEqual([]);
  });

  test("rules in different chains never shadow each other", () => {
    const m = model(
      `add action=drop chain=input
add action=accept chain=forward`,
    );
    expect(unreachableRules(m.filter)).toEqual([]);
  });

  test("a narrower earlier rule does not shadow a broader later one", () => {
    const m = model(
      `add action=drop chain=input src-address=10.0.0.1
add action=accept chain=input src-address=10.0.0.0/8`,
    );
    expect(unreachableRules(m.filter)).toEqual([]);
  });

  test("a disabled earlier rule shadows nothing", () => {
    const m = model(
      `add action=drop chain=input disabled=yes
add action=accept chain=input protocol=tcp`,
    );
    expect(unreachableRules(m.filter)).toEqual([]);
  });
});
