/**
 * Fidelity regressions — every case here comes from comparing the simulator
 * against a REAL RouterOS device's own routing table (`docs/tasks/08` Phase 4).
 *
 * The fixtures are anonymised reproductions of the config structures those
 * devices actually had, not synthetic guesses. Each test pins a behaviour that
 * was WRONG before the comparison, so a future change cannot quietly reintroduce
 * a divergence that a live router already caught once.
 */
import { describe, expect, test } from "vite-plus/test";
import { HOME_DHCP_WAN, VPS_ON_LINK } from "./fixtures/configs";
import { buildModel } from "../../src/sim/model";
import { selectRoute } from "../../src/sim/routing";
import { tracePacket } from "../../src/sim/trace";
import type { SimPacket } from "../../src/sim/firewall";

const VPS = buildModel(VPS_ON_LINK);
const HOME = buildModel(HOME_DHCP_WAN);

function packet(over: Partial<SimPacket> = {}): SimPacket {
  return {
    srcAddress: "10.10.10.5",
    dstAddress: "8.8.8.8",
    protocol: "tcp",
    srcPort: 51234,
    dstPort: 443,
    inInterface: "bridge",
    connectionState: "new",
    ...over,
  };
}

describe("on-link gateway declared by `network=` (real VPS)", () => {
  test("the egress interface resolves through `network=`, not the address's subnet", () => {
    // The device answers ether1 / 10.0.0.1. Before the fidelity pass the model
    // could not resolve the gateway at all: 10.0.0.1 is nowhere near 203.0.113.33/32.
    const decision = selectRoute(VPS, "8.8.8.8");
    expect(decision.outcome).toBe("routed");
    expect(decision.gateway).toBe("10.0.0.1");
    expect(decision.outInterface).toBe("ether1");
  });

  test("a /32 address still yields its own connected route", () => {
    expect(VPS.routes.some((r) => r.dst.text === "203.0.113.33/32")).toBe(true);
  });

  test("the tunnel network routes over the tunnel", () => {
    expect(selectRoute(VPS, "10.64.60.2").outInterface).toBe("wg-to-home");
  });
});

describe("dynamically-learned routes are absent from an export (real home router)", () => {
  test("the DHCP client is recorded as a source of routes the export cannot show", () => {
    expect(HOME.dynamicRouteSources).toContain("DHCP client on ether1");
  });

  test("`no route` says the export cannot see it, rather than asserting there is none", () => {
    // The real device routes 8.8.8.8 fine, via a DHCP-learned default. The model
    // must not claim otherwise.
    const decision = selectRoute(HOME, "203.0.113.1");
    expect(decision.outcome).toBe("no-route");
    expect(decision.reason).toContain("IN THE EXPORT");
    expect(decision.reason).toContain("DHCP client");
  });

  test("a trace with no route on a DHCP-WAN device is UNKNOWN, never a confident drop", () => {
    // This is the divergence that mattered most: "dropped, no route" for every
    // internet-bound packet on the commonest setup there is.
    const result = tracePacket({
      model: HOME,
      packet: packet({ srcAddress: "192.0.2.5", dstAddress: "203.0.113.1", inInterface: "ether1" }),
    });
    expect(result.verdict).toBe("unknown");
    expect(result.unmodelled.some((u) => u.what === "dynamically-learned routes")).toBe(true);
  });

  test("a device with NO dynamic source still reports a definite drop", () => {
    const isolated = buildModel(`/ip address\nadd address=10.10.10.1/24 interface=bridge\n`);
    const result = tracePacket({ model: isolated, packet: packet() });
    expect(result.verdict).toBe("drop");
    expect(result.summary).toContain("no route");
  });
});

describe("policy routing, as the real device has it", () => {
  test("a mangle mark selects the VPN table and its 0.0.0.0/1 half", () => {
    const result = tracePacket({ model: HOME, packet: packet() });
    expect(result.steps.some((s) => s.action === "mark-routing")).toBe(true);
    expect(result.routing?.route?.dst.text).toBe("0.0.0.0/1");
    expect(result.routing?.outInterface).toBe("wg-to-relay");
  });

  test("check-gateway makes the verdict UNKNOWN, because liveness is unknowable", () => {
    // The device may have deactivated this route seconds ago; an export cannot
    // say. Reporting ACCEPT here would be exactly the confident-wrong answer.
    const result = tracePacket({ model: HOME, packet: packet() });
    expect(result.verdict).toBe("unknown");
    expect(result.unmodelled.some((u) => u.what === "check-gateway liveness")).toBe(true);
    // …and it still says what the verdict would otherwise have been.
    expect(result.summary).toContain("would have been");
  });
});

describe("connection-nat-state is evaluable, because dstnat runs before filter", () => {
  const WITH_NAT = `${HOME_DHCP_WAN}
/ip firewall nat add action=dst-nat chain=dstnat dst-port=8080 protocol=tcp to-addresses=10.10.10.20 to-ports=80
/ip firewall filter add action=accept chain=forward connection-nat-state=dstnat
`;

  test("a dstnat'ed packet matches `connection-nat-state=dstnat`", () => {
    const model = buildModel(WITH_NAT);
    const result = tracePacket({
      model,
      packet: packet({
        srcAddress: "192.0.2.9",
        dstAddress: "203.0.113.33",
        dstPort: 8080,
        inInterface: "ether1",
      }),
    });
    expect(result.nat.some((n) => n.stage === "dstnat")).toBe(true);
    // It got past the rules by being recognised as translated — not by the
    // matcher being unevaluable.
    expect(result.unmodelled.some((u) => u.what.includes("connection-nat-state"))).toBe(false);
  });

  test("srcnat state is still unknown at filter time, because srcnat has not run", () => {
    const model = buildModel(
      `${HOME_DHCP_WAN}\n/ip firewall filter add action=drop chain=forward connection-nat-state=srcnat\n`,
    );
    const result = tracePacket({ model, packet: packet() });
    expect(result.verdict).toBe("unknown");
  });
});

describe("coverage reporting on a real-shaped config", () => {
  test("the model lists what it could not read, rather than staying silent", () => {
    // `tcp-flags` on the MSS-clamp rule is genuinely out of scope.
    expect(VPS.unmodelled.map((u) => u.what)).toContain("tcp-flags");
  });

  test("a real export parses without unreadable lines", () => {
    expect(VPS.unparsedLines).toBe(0);
    expect(HOME.unparsedLines).toBe(0);
  });
});
