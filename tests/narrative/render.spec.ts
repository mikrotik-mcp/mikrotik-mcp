/**
 * Mermaid and Markdown rendering.
 *
 * The load-bearing property is stability. `diff_explanations` compares two
 * rendered narratives, so a renderer that reorders a Map on a whim reports a
 * change on every run and the diff feature is worthless. The escaping cases
 * matter for a different reason: `ether1 (uplink)` is a legal RouterOS interface
 * name and an illegal Mermaid identifier, so an unescaped diagram is a broken
 * page rather than a wrong one.
 */
import { describe, expect, test } from "vite-plus/test";
import { analyzeDevice } from "../../src/narrative/analyze";
import { topologyMermaid } from "../../src/narrative/mermaid";
import { NARRATIVE_SECTIONS, renderNarrative } from "../../src/narrative/render";
import {
  HOME_ROUTER,
  MULTI_WAN,
  PURE_SWITCH,
  SPARSE,
  VPN_CONCENTRATOR,
  WIDE_OPEN,
  WITH_UNKNOWN_MENU,
} from "./fixtures/exports";

describe("mermaid", () => {
  test("is stable across runs", () => {
    for (const fixture of [HOME_ROUTER, PURE_SWITCH, VPN_CONCENTRATOR, MULTI_WAN]) {
      const a = topologyMermaid(analyzeDevice(fixture));
      const b = topologyMermaid(analyzeDevice(fixture));
      expect(a).toBe(b);
    }
  });

  test("opens with a graph declaration", () => {
    expect(topologyMermaid(analyzeDevice(HOME_ROUTER)).split("\n")[0]).toBe("graph LR");
  });

  test("draws the internet, the WAN interface and the NAT between them", () => {
    const src = topologyMermaid(analyzeDevice(HOME_ROUTER));
    expect(src).toContain("internet((");
    expect(src).toContain("ether1-wan");
    expect(src).toContain("masquerade");
  });

  test("a bridge port hangs off its BRIDGE, not off the router", () => {
    // Flattening it would hide the layer-2 structure the diagram exists to show.
    const src = topologyMermaid(analyzeDevice(HOME_ROUTER));
    const bridgeId = src.match(/^ {2}(\S+)\[[^\]]*bridge/m)?.[1];
    expect(bridgeId).toBeDefined();
    expect(src).toContain(`${bridgeId} --- `);
  });

  test("special characters in an interface name cannot break the syntax", () => {
    const src = topologyMermaid(
      analyzeDevice(
        '/interface bridge add name="ether1 (uplink) [main]"\n' +
          '/ip address add address=10.0.0.1/24 interface="ether1 (uplink) [main]"\n',
      ),
    );
    // Node ids carry no punctuation…
    for (const id of src.matchAll(/^ {2}([A-Za-z0-9_]+)[[({]/gm)) {
      expect(id[1]).toMatch(/^[A-Za-z0-9_]+$/);
    }
    // …and the raw name only ever appears inside a quoted label.
    expect(src).toContain('"ether1 (uplink) [main]');
  });

  test("a quote inside a name is escaped rather than closing the label", () => {
    const src = topologyMermaid(analyzeDevice('/interface bridge add name="say \\"hi\\""\n'));
    expect(src).toContain("&quot;");
  });

  test("two names that slugify identically still get distinct ids", () => {
    const src = topologyMermaid(
      analyzeDevice("/interface bridge add name=wg-home\n/interface bridge add name=wg.home\n"),
    );
    const ids = [...src.matchAll(/^ {2}([A-Za-z0-9_]+)\[/gm)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a tunnel is drawn to its peer with a dotted link", () => {
    const src = topologyMermaid(analyzeDevice(VPN_CONCENTRATOR));
    expect(src).toContain("-.-");
    expect(src).toContain("wireguard");
  });

  test("an empty config still produces valid, honest output", () => {
    const src = topologyMermaid(analyzeDevice("# empty\n"));
    expect(src).toContain("graph LR");
    expect(src).toContain("no interfaces found");
  });
});

describe("markdown", () => {
  test("is stable across runs", () => {
    for (const fixture of [HOME_ROUTER, PURE_SWITCH, WIDE_OPEN]) {
      expect(renderNarrative(analyzeDevice(fixture))).toBe(renderNarrative(analyzeDevice(fixture)));
    }
  });

  test("leads with the device name and a provenance line", () => {
    const md = renderNarrative(analyzeDevice(HOME_ROUTER, "edge"));
    expect(md.split("\n")[0]).toBe("# home-gw");
    expect(md).toContain("Device: `edge`");
    expect(md).toContain("configuration records");
  });

  test("exposure comes BEFORE the topology tables", () => {
    // It is the section people actually read; burying it under a VLAN table
    // would be a documentation failure dressed up as completeness.
    const md = renderNarrative(analyzeDevice(WIDE_OPEN));
    expect(md.indexOf("## Exposed to the internet")).toBeLessThan(md.indexOf("## Topology"));
  });

  test("every section appears in a full render", () => {
    const md = renderNarrative(analyzeDevice(HOME_ROUTER));
    for (const heading of [
      "## What this device is",
      "## Exposed to the internet",
      "## Topology",
      "## Addressing",
      "## Internet path",
      "## Firewall",
      "## VPN and tunnels",
      "## Management services",
      "## What this document does not cover",
    ]) {
      expect(md).toContain(heading);
    }
  });

  test("a section subset renders only what was asked for, in that order", () => {
    const md = renderNarrative(analyzeDevice(HOME_ROUTER), { sections: ["firewall", "identity"] });
    expect(md).toContain("## Firewall");
    expect(md).toContain("## What this device is");
    expect(md).not.toContain("## Addressing");
    expect(md.indexOf("## Firewall")).toBeLessThan(md.indexOf("## What this device is"));
  });

  test("the diagram can be turned off", () => {
    const md = renderNarrative(analyzeDevice(HOME_ROUTER), { diagram: false });
    expect(md).not.toContain("```mermaid");
    expect(md).toContain("## Topology");
  });

  test("the role call shows its reasoning", () => {
    const md = renderNarrative(analyzeDevice(HOME_ROUTER));
    expect(md).toContain("Primary role: **Edge router**");
    expect(md).toContain("The signals behind that call");
    // Every signal cites the menu it came from — this fixture's WAN is DHCP, so
    // the edge call rests on the NAT rule rather than a static default route.
    expect(md).toContain("`/ip/firewall/nat`");
  });

  test("a device with no exposure says so plainly", () => {
    const md = renderNarrative(analyzeDevice(PURE_SWITCH));
    expect(md).toContain("Nothing in the configuration accepts connections from outside");
  });

  test("no firewall rules at all is called out, not left blank", () => {
    const md = renderNarrative(analyzeDevice(SPARSE));
    expect(md).toContain("no firewall filter rules at all");
  });

  test("subnets with no DHCP are named", () => {
    const md = renderNarrative(analyzeDevice(HOME_ROUTER));
    expect(md).toContain("no DHCP server");
    expect(md).toContain("198.51.100.0/24");
  });

  test("multi-WAN explains which upstream wins and why", () => {
    const md = renderNarrative(analyzeDevice(MULTI_WAN));
    expect(md).toContain("Lowest distance wins");
    expect(md).toContain("ether1");
  });

  test("unknowns are listed with the line to go and read", () => {
    const md = renderNarrative(analyzeDevice(WITH_UNKNOWN_MENU));
    expect(md).toContain("What this document does not cover");
    expect(md).toContain("/queue/tree");
  });

  test("a fully understood config says so instead of showing an empty table", () => {
    const md = renderNarrative(analyzeDevice(HOME_ROUTER));
    expect(md).toContain("was recognised");
  });

  test("a pipe in a value cannot break a table row", () => {
    const md = renderNarrative(analyzeDevice('/interface bridge add comment="a|b" name=bridge\n'));
    expect(md).toContain("a\\|b");
  });

  test("tunnel liveness is explicitly NOT claimed", () => {
    // An export says what is defined, never what is connected. Implying
    // otherwise in a document someone trusts would be a lie.
    const md = renderNarrative(analyzeDevice(VPN_CONCENTRATOR));
    expect(md).toContain("cannot be told from a configuration export");
  });

  test("ends with exactly one trailing newline", () => {
    const md = renderNarrative(analyzeDevice(HOME_ROUTER));
    expect(md.endsWith("\n")).toBe(true);
    expect(md.endsWith("\n\n")).toBe(false);
  });

  test("every declared section id actually renders", () => {
    for (const section of NARRATIVE_SECTIONS) {
      const md = renderNarrative(analyzeDevice(HOME_ROUTER), { sections: [section] });
      expect(md.split("\n").filter((l) => l.startsWith("## ")).length).toBe(1);
    }
  });
});
