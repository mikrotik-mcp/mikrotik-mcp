/**
 * Unit tests for the port-level L2 fabric join. Pure — no device I/O.
 */
import { describe, expect, test } from "vite-plus/test";
import { buildFabricMap, findHost, macKey } from "../../src/core/l2-fabric";
import type { BridgeHost, FabricInput } from "../../src/core/l2-fabric";

function host(over: Partial<BridgeHost> & { mac: string; onInterface: string }): BridgeHost {
  return { local: false, dynamic: true, bridge: "bridge1", ...over };
}

function input(over: Partial<FabricInput> = {}): FabricInput {
  return { device: "sw1", hosts: [], arp: [], leases: [], neighbors: [], ...over };
}

const LAPTOP = "AA:BB:CC:00:00:01";
const PRINTER = "AA:BB:CC:00:00:02";

describe("macKey", () => {
  test("normalises separators and case so tables join", () => {
    expect(macKey("aa:bb:cc:dd:ee:ff")).toBe("AABBCCDDEEFF");
    expect(macKey("AA-BB-CC-DD-EE-FF")).toBe("AABBCCDDEEFF");
    expect(macKey("AABBCCDDEEFF")).toBe("AABBCCDDEEFF");
  });

  test("rejects anything that is not a full MAC", () => {
    expect(macKey("AA:BB:CC")).toBeUndefined();
    expect(macKey(undefined)).toBeUndefined();
    expect(macKey("")).toBeUndefined();
  });
});

describe("buildFabricMap — naming", () => {
  test("a DHCP hostname wins over every other source", () => {
    const map = buildFabricMap(
      input({
        hosts: [host({ mac: LAPTOP, onInterface: "ether3" })],
        arp: [{ mac: LAPTOP, address: "192.168.1.50" }],
        leases: [{ mac: LAPTOP, address: "192.168.1.50", hostname: "alis-laptop" }],
      }),
    );
    const h = map.ports[0].hosts[0];
    expect(h.label).toBe("alis-laptop");
    expect(h.nameSource).toBe("dhcp");
    expect(h.ip).toBe("192.168.1.50");
  });

  test("falls back through identity, IP, then vendor", () => {
    const map = buildFabricMap(
      input({
        hosts: [
          host({ mac: "48:A9:8A:00:00:01", onInterface: "ether1" }),
          host({ mac: PRINTER, onInterface: "ether2" }),
          host({ mac: "00:11:99:00:00:03", onInterface: "ether4" }),
        ],
        arp: [{ mac: PRINTER, address: "192.168.1.40" }],
        neighbors: [{ mac: "48:A9:8A:00:00:01", identity: "core-rtr" }],
      }),
    );
    const byIface = new Map(map.ports.map((p) => [p.interface, p.hosts[0]]));
    expect(byIface.get("ether1")).toMatchObject({ label: "core-rtr", nameSource: "neighbor" });
    expect(byIface.get("ether2")).toMatchObject({ label: "192.168.1.40", nameSource: "arp" });
    // Unknown OUI and no IP/lease → the bare MAC, flagged as unidentified.
    expect(byIface.get("ether4")).toMatchObject({ nameSource: "none" });
    expect(map.stats.unidentified).toBe(1);
  });

  test("a known OUI names an otherwise anonymous host", () => {
    const map = buildFabricMap(
      input({ hosts: [host({ mac: "B8:27:EB:00:00:07", onInterface: "ether6" })] }),
    );
    expect(map.ports[0].hosts[0]).toMatchObject({
      vendor: "Raspberry Pi",
      nameSource: "vendor",
    });
  });

  test("the join works across mismatched MAC formatting", () => {
    // The bridge prints uppercase-colon, DHCP leases can differ — if the join
    // keyed on the raw string these tables would never meet.
    const map = buildFabricMap(
      input({
        hosts: [host({ mac: "aa:bb:cc:00:00:01", onInterface: "ether3" })],
        leases: [{ mac: "AA-BB-CC-00-00-01", hostname: "matched" }],
      }),
    );
    expect(map.ports[0].hosts[0].label).toBe("matched");
  });
});

describe("buildFabricMap — port roles", () => {
  test("one host is an access port", () => {
    const map = buildFabricMap(input({ hosts: [host({ mac: LAPTOP, onInterface: "ether3" })] }));
    expect(map.ports[0].role).toBe("access");
  });

  test("a handful of hosts is hybrid, not an uplink", () => {
    // A laptop with a VM must not be mislabelled as an uplink.
    const hosts = ["01", "02", "03"].map((n) =>
      host({ mac: `AA:BB:CC:00:00:${n}`, onInterface: "ether3" }),
    );
    expect(buildFabricMap(input({ hosts })).ports[0].role).toBe("hybrid");
  });

  test("many hosts is an uplink", () => {
    const hosts = ["01", "02", "03", "04", "05"].map((n) =>
      host({ mac: `AA:BB:CC:00:00:${n}`, onInterface: "ether1" }),
    );
    expect(buildFabricMap(input({ hosts })).ports[0].role).toBe("uplink");
  });

  test("a discovered network device makes a port an uplink regardless of count", () => {
    const map = buildFabricMap(
      input({
        hosts: [host({ mac: "48:A9:8A:00:00:01", onInterface: "ether1" })],
        neighbors: [{ mac: "48:A9:8A:00:00:01", identity: "core-rtr" }],
      }),
    );
    expect(map.ports[0].role).toBe("uplink");
    expect(map.ports[0].peerIdentity).toBe("core-rtr");
  });
});

describe("buildFabricMap — hygiene", () => {
  test("the bridge's own MAC is excluded from every port", () => {
    // Otherwise a phantom device appears on every port of every switch.
    const map = buildFabricMap(
      input({
        hosts: [
          host({ mac: "00:0C:42:AA:AA:AA", onInterface: "bridge1", local: true }),
          host({ mac: LAPTOP, onInterface: "ether3" }),
        ],
      }),
    );
    expect(map.stats.hosts).toBe(1);
    expect(map.localMacs).toEqual(["00:0C:42:AA:AA:AA"]);
  });

  test("a MAC learned twice on one port is counted once", () => {
    const map = buildFabricMap(
      input({
        hosts: [
          host({ mac: LAPTOP, onInterface: "ether3" }),
          host({ mac: LAPTOP, onInterface: "ether3" }),
        ],
      }),
    );
    expect(map.ports[0].hostCount).toBe(1);
  });

  test("unkeyable rows are dropped rather than throwing", () => {
    const map = buildFabricMap(
      input({
        hosts: [
          host({ mac: "not-a-mac", onInterface: "ether3" }),
          host({ mac: LAPTOP, onInterface: "" }),
        ],
      }),
    );
    expect(map.ports).toEqual([]);
    expect(map.stats.hosts).toBe(0);
  });

  test("ports are ordered busiest first", () => {
    const map = buildFabricMap(
      input({
        hosts: [
          host({ mac: LAPTOP, onInterface: "ether9" }),
          ...["01", "02", "03"].map((n) =>
            host({ mac: `BB:BB:CC:00:00:${n}`, onInterface: "ether1" }),
          ),
        ],
      }),
    );
    expect(map.ports.map((p) => p.interface)).toEqual(["ether1", "ether9"]);
  });
});

describe("findHost", () => {
  const map = buildFabricMap(
    input({
      hosts: [
        host({ mac: PRINTER, onInterface: "ether2" }),
        host({ mac: LAPTOP, onInterface: "ether3" }),
      ],
      arp: [{ mac: PRINTER, address: "192.168.1.40" }],
      leases: [{ mac: LAPTOP, hostname: "alis-laptop" }],
    }),
  );

  test("locates by IP", () => {
    const hits = findHost(map, "192.168.1.40");
    expect(hits).toHaveLength(1);
    expect(hits[0].port.interface).toBe("ether2");
  });

  test("locates by MAC in any format", () => {
    expect(findHost(map, "aa-bb-cc-00-00-01")[0].port.interface).toBe("ether3");
  });

  test("locates by hostname substring", () => {
    expect(findHost(map, "laptop")[0].host.hostname).toBe("alis-laptop");
  });

  test("returns nothing for an absent host", () => {
    expect(findHost(map, "10.9.9.9")).toEqual([]);
  });
});
