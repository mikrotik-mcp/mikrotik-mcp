/**
 * Topology → Mermaid `graph LR`. PURE.
 *
 * Two constraints shape everything here:
 *
 * 1. **Deterministic node order.** Two runs over the same config must emit
 *    byte-identical source, or `diff_explanations` reports a diagram change on
 *    every run and the whole diff feature becomes noise. Nothing iterates a Map
 *    in insertion order; everything sorts.
 * 2. **Identifiers are escaped, not trusted.** RouterOS interface names may
 *    contain spaces, hyphens, dots, brackets and quotes — `ether1 (uplink)` is a
 *    perfectly legal name and is also a Mermaid syntax error. Node ids are
 *    generated, and the display label is quoted with its own quotes escaped.
 */
import type { DeviceNarrative, NarrativeInterface } from "./analyze";

/**
 * A safe Mermaid node id derived from a name.
 *
 * Mermaid ids may only be alphanumerics and underscores, so anything else is
 * replaced — and because two different names can collapse to the same slug
 * (`wg-home` and `wg.home`), an index is appended to keep them distinct.
 */
function nodeId(name: string, index: number): string {
  const slug = name.replace(/[^A-Za-z0-9]/g, "_").replace(/_+/g, "_");
  return `n${index}_${slug}`;
}

/** A Mermaid label: quoted, with embedded quotes escaped as HTML entities. */
function label(text: string): string {
  return `"${text.replace(/"/g, "&quot;")}"`;
}

/** Node shape by interface kind — a bridge reads differently from a tunnel. */
function shape(id: string, text: string, kind: string): string {
  const l = label(text);
  switch (kind) {
    case "bridge":
      return `${id}[${l}]`;
    case "vlan":
      return `${id}(${l})`;
    case "wireguard":
    case "gre":
    case "ipip":
    case "eoip":
    case "vxlan":
    case "l2tp-client":
    case "pptp-client":
    case "sstp-client":
    case "ovpn-client":
    case "pppoe-client":
      return `${id}{{${l}}}`;
    case "wireless":
    case "wifi":
      return `${id}([${l}])`;
    default:
      return `${id}[${l}]`;
  }
}

function describeInterface(iface: NarrativeInterface, subnetsFor: string[]): string {
  const bits = [iface.name];
  if (iface.vlanId !== undefined) bits.push(`VLAN ${iface.vlanId}`);
  if (subnetsFor.length > 0) bits.push(subnetsFor.join(", "));
  else if (iface.addresses.length > 0) bits.push(iface.addresses.join(", "));
  if (iface.disabled) bits.push("disabled");
  // `<br/>` is Mermaid's line break inside a node label; a literal `\n` renders
  // as the two characters, not a newline.
  return bits.join("<br/>");
}

/**
 * Render the topology as Mermaid source.
 *
 * The internet sits on the left, the router in the middle, local segments on the
 * right — the direction traffic is usually being asked about.
 */
export function topologyMermaid(narrative: DeviceNarrative): string {
  const lines = ["graph LR"];
  const ids = new Map<string, string>();
  // Sorted, so the id assignment (and therefore the whole file) is stable.
  const interfaces = [...narrative.interfaces].sort((a, b) => a.name.localeCompare(b.name));
  interfaces.forEach((iface, i) => ids.set(iface.name, nodeId(iface.name, i)));

  const subnetsByInterface = new Map<string, string[]>();
  for (const subnet of narrative.subnets) {
    const list = subnetsByInterface.get(subnet.interface);
    if (list) list.push(subnet.cidr);
    else subnetsByInterface.set(subnet.interface, [subnet.cidr]);
  }

  const wanNames = new Set(narrative.wans.map((w) => w.interface));
  const tunnelNames = new Set(narrative.tunnels.map((t) => t.name));

  // ── The router itself ───────────────────────────────────────────────────
  const routerLabel = narrative.identity.name ?? narrative.device ?? "router";
  lines.push(`  router[${label(routerLabel)}]`);

  // ── Upstream ────────────────────────────────────────────────────────────
  if (narrative.wans.length > 0) {
    lines.push(`  internet((${label("Internet")}))`);
    for (const wan of [...narrative.wans].sort((a, b) => a.interface.localeCompare(b.interface))) {
      const id = ids.get(wan.interface);
      if (!id) continue;
      const iface = interfaces.find((i) => i.name === wan.interface);
      lines.push(
        `  ${shape(id, describeInterface(iface ?? { name: wan.interface, kind: "ethernet", lists: [], addresses: [], disabled: false }, subnetsByInterface.get(wan.interface) ?? []), "ethernet")}`,
      );
      lines.push(`  internet ---|${label(wan.addressing)}| ${id}`);
      lines.push(`  ${id} ---|${label(wan.nat)}| router`);
    }
  }

  // ── Everything else, hanging off the router ─────────────────────────────
  for (const iface of interfaces) {
    if (wanNames.has(iface.name)) continue;
    const id = ids.get(iface.name);
    if (!id) continue;
    const subnets = subnetsByInterface.get(iface.name) ?? [];
    // A bridge port is drawn under its bridge, not under the router — that is
    // what "switched into" means, and flattening it would hide the layer-2
    // structure the diagram exists to show.
    const parentId = iface.parent ? ids.get(iface.parent) : undefined;
    lines.push(`  ${shape(id, describeInterface(iface, subnets), iface.kind)}`);
    if (parentId) lines.push(`  ${parentId} --- ${id}`);
    else lines.push(`  router --- ${id}`);
  }

  // ── Tunnel peers ────────────────────────────────────────────────────────
  const tunnels = [...narrative.tunnels].sort((a, b) => a.name.localeCompare(b.name));
  tunnels.forEach((tunnel, i) => {
    const id = ids.get(tunnel.name);
    if (!id || tunnel.peers.length === 0) return;
    const peerId = `peer${i}`;
    lines.push(`  ${peerId}[${label(tunnel.peers.join(", "))}]`);
    lines.push(`  ${id} -.-|${label(tunnel.kind)}| ${peerId}`);
  });

  // Nothing but the router: still valid Mermaid, and honest about it.
  if (lines.length === 2 && tunnelNames.size === 0) {
    lines.push(`  router --- empty[${label("no interfaces found in the export")}]`);
  }

  return lines.join("\n");
}
