/**
 * `DeviceNarrative` → Markdown. PURE.
 *
 * This is the document someone who just inherited a router actually reads, so
 * it is ordered by what they need first: what is this box, what is exposed to
 * the internet, then the detail. Exposure sits near the top on purpose — it is
 * the section people actually read, and burying it under a VLAN table would be
 * a documentation failure dressed up as completeness.
 *
 * Deterministic: same narrative in, byte-identical Markdown out. `render` never
 * reads a clock — `generatedAt` comes from the narrative, stamped by the caller.
 */
import type { DeviceNarrative } from "./analyze";
import { topologyMermaid } from "./mermaid";

export interface RenderOptions {
  /** Include the Mermaid topology block. */
  diagram?: boolean;
  /** Only these sections, in this order. Omit for the whole document. */
  sections?: NarrativeSection[];
}

export type NarrativeSection =
  | "identity"
  | "topology"
  | "addressing"
  | "internet"
  | "firewall"
  | "exposure"
  | "vpn"
  | "services"
  | "unknowns";

export const NARRATIVE_SECTIONS: NarrativeSection[] = [
  "identity",
  "exposure",
  "topology",
  "addressing",
  "internet",
  "firewall",
  "vpn",
  "services",
  "unknowns",
];

/** Escape a value for a Markdown table cell — a stray `|` breaks the row. */
function cell(text: string | undefined): string {
  return (text ?? "—").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

const SEVERITY_MARK: Record<string, string> = {
  critical: "🔴 critical",
  high: "🟠 high",
  medium: "🟡 medium",
  low: "🟢 low",
};

function identitySection(n: DeviceNarrative): string[] {
  const out = ["## What this device is", ""];
  const facts: string[] = [];
  if (n.identity.name) facts.push(`**${n.identity.name}**`);
  if (n.identity.model) facts.push(n.identity.model);
  if (n.identity.version) facts.push(`RouterOS ${n.identity.version}`);
  out.push(facts.length > 0 ? facts.join(" · ") : "_The export carries no identity header._", "");

  const { primary, secondary } = n.identity.roles;
  if (!primary) {
    out.push(
      "The configuration has no signals this analyser recognises, so its role could not be inferred.",
      "",
    );
    return out;
  }

  out.push(`Primary role: **${primary.label}**`);
  if (secondary.length > 0) {
    out.push(`Also acts as: ${secondary.map((r) => r.label).join(", ")}`);
  }
  out.push("", "The signals behind that call:", "");
  for (const role of [primary, ...secondary]) {
    out.push(`- **${role.label}** (score ${role.score})`);
    for (const signal of role.signals) {
      out.push(`  - ${signal.signal} — \`${signal.section}\``);
    }
  }
  out.push("");
  return out;
}

function exposureSection(n: DeviceNarrative): string[] {
  const out = ["## Exposed to the internet", ""];
  if (n.exposure.length === 0) {
    out.push(
      "Nothing in the configuration accepts connections from outside without a source restriction.",
      "",
    );
    return out;
  }
  out.push(
    "Read this section first. Every row is something reachable from outside the LAN, taken from",
    "the configuration alone — a firewall rule may still stand in the way, and the firewall",
    "section below says whether one does.",
    "",
    "| What | How | Details | Reachable from | Severity | Line |",
    "| ---- | --- | ------- | -------------- | -------- | ---: |",
  );
  for (const e of n.exposure) {
    out.push(
      `| ${cell(e.what)} | ${cell(e.kind)} | ${cell(e.detail)} | ${cell(e.from)} | ${
        SEVERITY_MARK[e.severity] ?? e.severity
      } | ${e.line} |`,
    );
  }
  out.push("");
  return out;
}

function topologySection(n: DeviceNarrative, diagram: boolean): string[] {
  const out = ["## Topology", ""];
  if (diagram) {
    out.push("```mermaid", topologyMermaid(n), "```", "");
  }
  if (n.interfaces.length === 0) {
    out.push("_No interfaces found in the export._", "");
    return out;
  }
  out.push(
    "| Interface | Kind | Part of | Addresses | Lists | Purpose |",
    "| --------- | ---- | ------- | --------- | ----- | ------- |",
  );
  for (const iface of n.interfaces) {
    const name = iface.disabled ? `${iface.name} _(disabled)_` : iface.name;
    out.push(
      `| ${cell(name)} | ${cell(iface.kind)}${iface.vlanId !== undefined ? ` ${iface.vlanId}` : ""} | ${cell(
        iface.parent,
      )} | ${cell(iface.addresses.join(", ") || undefined)} | ${cell(
        iface.lists.join(", ") || undefined,
      )} | ${cell(iface.purpose ?? iface.comment)} |`,
    );
  }
  out.push("");
  return out;
}

function addressingSection(n: DeviceNarrative): string[] {
  const out = ["## Addressing", ""];
  if (n.subnets.length === 0) {
    out.push("_No IPv4 subnets are configured._", "");
    return out;
  }
  out.push(
    "| Subnet | On | Router address | VLAN | DHCP | Range |",
    "| ------ | -- | -------------- | ---- | ---- | ----- |",
  );
  for (const s of n.subnets) {
    out.push(
      `| ${cell(s.cidr)} | ${cell(s.interface)} | ${cell(s.routerAddress)} | ${
        s.vlanId !== undefined ? s.vlanId : "—"
      } | ${cell(s.dhcp ? s.dhcp.server : "none")} | ${cell(s.dhcp?.ranges.join(", ") || undefined)} |`,
    );
  }
  out.push("");

  const withReservations = n.subnets.filter((s) => s.reservations.length > 0);
  if (withReservations.length > 0) {
    out.push("### Static reservations", "");
    for (const s of withReservations) {
      out.push(`**${s.cidr}**`);
      for (const r of s.reservations) {
        out.push(
          `- \`${r.address}\`${r.macAddress ? ` → ${r.macAddress}` : ""}${r.comment ? ` — ${r.comment}` : ""}`,
        );
      }
      out.push("");
    }
  }

  const noDhcp = n.subnets.filter((s) => !s.dhcp);
  if (noDhcp.length > 0) {
    out.push(
      `Subnets with **no DHCP server**: ${noDhcp.map((s) => `\`${s.cidr}\``).join(", ")}. ` +
        "Hosts there are configured by hand or served from somewhere else.",
      "",
    );
  }
  return out;
}

function internetSection(n: DeviceNarrative): string[] {
  const out = ["## Internet path", ""];
  if (n.wans.length === 0) {
    out.push(
      "No upstream is configured — this device does not route to the internet on its own.",
      "",
    );
    return out;
  }
  out.push(
    "| Interface | Addressing | Gateway | Distance | Failover check | NAT |",
    "| --------- | ---------- | ------- | -------- | -------------- | --- |",
  );
  for (const w of n.wans) {
    out.push(
      `| ${cell(w.interface)} | ${cell(w.addressing)} | ${cell(w.gateway)} | ${
        w.distance ?? "—"
      } | ${cell(w.checkGateway)} | ${cell(w.nat)} |`,
    );
  }
  out.push("");
  if (n.wans.length > 1) {
    // Distance ordering IS the failover policy; saying so saves the reader
    // working it out from two numbers in a table.
    const sorted = [...n.wans].sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
    out.push(
      `${n.wans.length} upstreams. Lowest distance wins, so **${sorted[0].interface}** carries traffic ` +
        `and the others take over if it fails${
          sorted[0].checkGateway
            ? ` (checked by ${sorted[0].checkGateway})`
            : " — but nothing is checking it"
        }.`,
      "",
    );
  }
  return out;
}

function firewallSection(n: DeviceNarrative): string[] {
  const out = ["## Firewall", ""];
  const filter = n.chains.filter((c) => c.table === "filter");
  if (filter.length === 0) {
    out.push(
      "**There are no firewall filter rules at all.** Everything that reaches this device is accepted.",
      "",
    );
  }
  for (const chain of n.chains) {
    out.push(
      `### \`${chain.table}\` / \`${chain.chain}\``,
      "",
      `${chain.ruleCount} rule(s)${
        chain.disabledCount > 0 ? `, ${chain.disabledCount} disabled` : ""
      }. ${
        chain.defaultAction === "unknown"
          ? "There is no catch-all rule at the end."
          : `Anything not matched is **${chain.defaultAction}ed**.`
      }`,
      "",
    );
    chain.summary.forEach((line, i) => out.push(`${i}. ${line}`));
    out.push("");
  }
  return out;
}

function vpnSection(n: DeviceNarrative): string[] {
  const out = ["## VPN and tunnels", ""];
  if (n.tunnels.length === 0) {
    out.push("_No tunnels are configured._", "");
    return out;
  }
  for (const t of n.tunnels) {
    out.push(
      `### ${t.name}${t.disabled ? " _(disabled)_" : ""}`,
      "",
      `- Type: ${t.kind}`,
      `- Peers: ${t.peers.length > 0 ? t.peers.join(", ") : "none configured"}`,
    );
    if (t.subnets.length > 0) out.push(`- Carries: ${t.subnets.join(", ")}`);
    if (t.comment) out.push(`- Comment: ${t.comment}`);
    out.push("");
  }
  out.push(
    "_Whether a tunnel is currently up cannot be told from a configuration export — " +
      "this lists what is defined, not what is connected._",
    "",
  );
  return out;
}

function servicesSection(n: DeviceNarrative): string[] {
  const out = ["## Management services", ""];
  if (n.services.length === 0) {
    out.push("_The export does not change any service defaults._", "");
    return out;
  }
  out.push(
    "| Service | State | Port | Available from |",
    "| ------- | ----- | ---- | -------------- |",
  );
  for (const s of n.services) {
    out.push(
      `| ${cell(s.name)} | ${s.enabled ? "enabled" : "disabled"} | ${cell(s.port)} | ${cell(
        s.availableFrom ?? (s.enabled ? "**anywhere**" : "—"),
      )} |`,
    );
  }
  out.push("");
  return out;
}

function unknownsSection(n: DeviceNarrative): string[] {
  const out = ["## What this document does not cover", ""];
  if (n.unknowns.length === 0) {
    out.push(`Every one of the ${n.stats.recordCount} configuration records was recognised.`, "");
    return out;
  }
  out.push(
    "These parts of the configuration were not analysed. They are not necessarily wrong — they are",
    "simply outside what this document describes, and you should read them yourself.",
    "",
    "| Menu | What | Line |",
    "| ---- | ---- | ---: |",
  );
  for (const u of n.unknowns) {
    out.push(`| \`${cell(u.section)}\` | ${cell(u.what)} | ${u.line} |`);
  }
  out.push("");
  return out;
}

const RENDERERS: Record<NarrativeSection, (n: DeviceNarrative, diagram: boolean) => string[]> = {
  identity: (n) => identitySection(n),
  exposure: (n) => exposureSection(n),
  topology: (n, diagram) => topologySection(n, diagram),
  addressing: (n) => addressingSection(n),
  internet: (n) => internetSection(n),
  firewall: (n) => firewallSection(n),
  vpn: (n) => vpnSection(n),
  services: (n) => servicesSection(n),
  unknowns: (n) => unknownsSection(n),
};

/** Render a narrative as Markdown. */
export function renderNarrative(narrative: DeviceNarrative, options: RenderOptions = {}): string {
  const sections = options.sections ?? NARRATIVE_SECTIONS;
  const diagram = options.diagram ?? true;

  const title = narrative.identity.name ?? narrative.device ?? "this device";
  const lines: string[] = [`# ${title}`, ""];

  const provenance: string[] = [];
  if (narrative.device) provenance.push(`Device: \`${narrative.device}\``);
  if (narrative.identity.exportedAt)
    provenance.push(`Configuration exported ${narrative.identity.exportedAt}`);
  provenance.push(`${narrative.stats.recordCount} configuration records`);
  if (narrative.stats.unparsedLines > 0) {
    provenance.push(`**${narrative.stats.unparsedLines} line(s) could not be parsed**`);
  }
  lines.push(`_${provenance.join(" · ")}_`, "");

  for (const section of sections) {
    lines.push(...RENDERERS[section](narrative, diagram));
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
