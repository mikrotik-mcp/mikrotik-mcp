import { z } from "zod";
import { Cmd, quoteValue } from "../core/routeros";
import { parseExport } from "../policy/parse";
import { contentSha, normalizeExport } from "../snapshots/format";

import { MIGRATION_SECTIONS } from "./sections";
import type { MigrationSection } from "./sections";
export { MIGRATION_SECTIONS } from "./sections";
export type { MigrationSection } from "./sections";
const disabledSections = new Set([
  "/interface/bridge",
  "/interface/vlan",
  "/interface/bridge/port",
  "/ip/address",
  "/ip/dhcp-server",
  "/ip/dhcp-server/lease",
  "/ip/route",
  "/ip/firewall/filter",
  "/ip/firewall/nat",
  "/ip/firewall/address-list",
]);
export const migrationInput = z
  .object({
    source: z.string().min(1).max(120),
    target: z.string().min(1).max(120),
    managementInterface: z.string().min(1).max(80),
    mapping: z.record(z.string().min(1).max(80), z.string().min(1).max(80)),
    sections: z
      .array(z.enum(Object.keys(MIGRATION_SECTIONS) as [MigrationSection, ...MigrationSection[]]))
      .min(1)
      .max(15),
  })
  .strict()
  .refine((a) => a.source !== a.target, "Source and target must differ.");
export type MigrationInput = z.infer<typeof migrationInput>;
export interface RouterInventory {
  version: string;
  model: string;
  architecture: string;
  packages: string[];
  interfaces: { name: string; type: string; mac?: string }[];
  export: string;
}
export interface MigrationItem {
  path: string;
  fields: Record<string, string>;
  command: string;
  undo: string;
  activate?: string;
  tag: string;
  line: number;
}
export interface MigrationPlan {
  id: string;
  device: string;
  createdAt: number;
  expiresAt: number;
  status: "preview" | "applying" | "rehearsed" | "staged" | "undoing" | "undone" | "uncertain";
  input: MigrationInput;
  source: Omit<RouterInventory, "export">;
  target: Omit<RouterInventory, "export">;
  fingerprint: string;
  items: MigrationItem[];
  blockers: string[];
  manual: { section: string; records: number; reason: string }[];
  snapshots?: { source: string; target: string };
  error?: string;
}
export const inventoryHash = (a: RouterInventory, b: RouterInventory) =>
  contentSha(
    JSON.stringify([
      a.version,
      b.version,
      a.interfaces,
      b.interfaces,
      normalizeExport(a.export),
      normalizeExport(b.export),
    ]),
  );
export function buildMigration(
  id: string,
  input: MigrationInput,
  source: RouterInventory,
  target: RouterInventory,
) {
  const sourceConfig = parseExport(source.export),
    targetConfig = parseExport(target.export),
    blockers: string[] = [],
    items: MigrationItem[] = [],
    manual: MigrationPlan["manual"] = [];
  if (!source.version.startsWith("7.") || source.version !== target.version)
    blockers.push("Use the same RouterOS 7 version on both devices before migration.");
  const sourceMacs = source.interfaces
    .filter((i) => i.type === "ether" && i.mac)
    .map((i) => i.mac!.toLowerCase());
  const targetMacs = target.interfaces
    .filter((i) => i.type === "ether" && i.mac)
    .map((i) => i.mac!.toLowerCase());
  if (
    !sourceMacs.length ||
    !targetMacs.length ||
    targetMacs.some((mac) => sourceMacs.includes(mac))
  )
    blockers.push(
      "Distinct physical routers could not be verified from Ethernet MAC addresses. Check device aliases and cloned MACs.",
    );
  if (sourceConfig.unparsed.length || targetConfig.unparsed.length)
    blockers.push("An export contains unparsed statements. Resolve them before staging.");
  const targetNames = new Set(target.interfaces.map((i) => i.name));
  if (!targetNames.has(input.managementInterface))
    blockers.push("Choose an existing target management interface.");
  if (!target.interfaces.some((i) => i.name === input.managementInterface && i.type === "ether"))
    blockers.push("Keep a dedicated physical Ethernet port for target management.");
  if (Object.values(input.mapping).includes(input.managementInterface))
    blockers.push("The target management interface must not be mapped or changed.");
  if (new Set(Object.values(input.mapping)).size !== Object.values(input.mapping).length)
    blockers.push("Each source port must map to a distinct target port.");
  for (const [from, to] of Object.entries(input.mapping)) {
    if (
      !source.interfaces.some((i) => i.name === from && i.type === "ether") ||
      !target.interfaces.some((i) => i.name === to && i.type === "ether")
    )
      blockers.push(`Map physical Ethernet ports only: ${from} → ${to}.`);
    const inUse = targetConfig.sections.some(
      (s) =>
        ["/interface/bridge/port", "/ip/address", "/ip/dhcp-client", "/interface/vlan"].includes(
          s.path,
        ) && s.records.some((r) => r.fields.interface === to),
    );
    if (inUse)
      blockers.push(
        `Target port ${to} is in use; choose an unused port. Existing configuration is never removed.`,
      );
  }
  const selected = new Set(input.sections),
    declared = new Set<string>();
  const pools = new Set<string>(),
    lists = new Set<string>(),
    tables = new Set(["main"]),
    servers = new Set<string>();
  for (const path of Object.keys(MIGRATION_SECTIONS) as MigrationSection[]) {
    if (!selected.has(path)) continue;
    const section = sourceConfig.byPath.get(path);
    if (!section) continue;
    for (const r of section.records) {
      const reject = (why: string) => blockers.push(`${path}, line ${r.line}: ${why}`);
      if (r.op !== "add" || r.flags.length || /[\\[\]$]/.test(r.raw)) {
        reject("Only literal add records are supported; no selectors, flags or expressions.");
        continue;
      }
      const allowed = new Set(`${MIGRATION_SECTIONS[path]} comment disabled`.split(" "));
      const unknown = Object.keys(r.fields).filter((k) => !allowed.has(k));
      if (unknown.length) {
        reject(`Unsupported properties: ${unknown.join(", ")}.`);
        continue;
      }
      const fields = { ...r.fields };
      delete fields.comment;
      delete fields.disabled;
      if (fields.name) {
        if (
          targetConfig.byPath.get(path)?.records.some((t) => t.fields.name === fields.name) ||
          (path.startsWith("/interface/") && targetNames.has(fields.name))
        )
          reject(`Name ${fields.name} already exists on target.`);
      }
      if (path === "/interface/bridge" && fields["vlan-filtering"] === "yes")
        reject(
          "VLAN-aware bridges require an explicit bridge VLAN table migration, not a partial copy.",
        );
      for (const key of ["interface", "in-interface", "out-interface"]) {
        const name = fields[key];
        if (!name) continue;
        if (declared.has(name)) continue;
        const mapped = input.mapping[name];
        if (!mapped) reject(`Map interface ${name} first.`);
        else fields[key] = mapped;
      }
      if (fields.bridge && !declared.has(fields.bridge))
        reject(`Bridge ${fields.bridge} is not included.`);
      if (path === "/interface/bridge" || path === "/interface/vlan") {
        if (!fields.name) reject("Missing name.");
        else declared.add(fields.name);
      }
      if (path === "/ip/pool" && fields.name) pools.add(fields.name);
      if (path === "/interface/list" && fields.name) lists.add(fields.name);
      if (path === "/routing/table" && fields.name) tables.add(fields.name);
      if (path === "/ip/dhcp-server" && fields.name) servers.add(fields.name);
      if (
        fields["address-pool"] &&
        fields["address-pool"] !== "static-only" &&
        !pools.has(fields["address-pool"])
      )
        reject("Include the referenced address pool.");
      if (path === "/ip/dhcp-server/lease" && (!fields.server || !servers.has(fields.server)))
        reject("Static leases must reference one included DHCP server, not all servers.");
      for (const key of ["in-interface-list", "out-interface-list"])
        if (fields[key] && !lists.has(fields[key]))
          reject(`Include interface list ${fields[key]}.`);
      if (path === "/interface/list/member" && !lists.has(fields.list))
        reject("Include the interface list.");
      if (path === "/ip/route") {
        if (!z.ipv4().safeParse(fields.gateway).success)
          reject(
            "Only a literal IPv4 next hop is supported; recursive/interface/ECMP gateways need manual review.",
          );
        if (!tables.has(fields["routing-table"] ?? "main"))
          reject("Include the referenced routing table.");
      }
      if (path === "/ip/firewall/filter" && !["input", "forward", "output"].includes(fields.chain))
        reject("Custom chains need manual dependency review.");
      if (
        path === "/ip/firewall/filter" &&
        !["accept", "drop", "reject", "log"].includes(fields.action)
      )
        reject("Unsupported firewall action.");
      if (
        path === "/ip/firewall/nat" &&
        !["masquerade", "src-nat", "dst-nat", "accept"].includes(fields.action)
      )
        reject("Unsupported NAT action.");
      if (path === "/ip/firewall/nat" && !["srcnat", "dstnat"].includes(fields.chain))
        reject("Custom NAT chains need manual dependency review.");
      if (path === "/ip/dhcp-server/network" && targetConfig.byPath.get(path)?.records.length)
        reject("Target DHCP networks must be empty to avoid altering existing clients.");
      if (
        path === "/ip/firewall/address-list" &&
        targetConfig.byPath.get(path)?.records.some((t) => t.fields.list === fields.list)
      )
        reject("Address-list name already exists on target.");
      const tag = `mcp-migrate-${id}-${items.length}`;
      // Pools and routing tables have no comment property; unique names are their ownership key.
      const named = path === "/ip/pool" || path === "/routing/table";
      if (named && !fields.name) reject("Missing ownership name.");
      if (!named) fields.comment = tag;
      if (disabledSections.has(path)) fields.disabled = "yes";
      const selector = `[find where ${named ? "name" : "comment"}=${quoteValue(named ? (fields.name ?? "") : tag)}]`;
      const command = new Cmd(`${path.replaceAll("/", " ").trimStart().replace(/^/, "/")} add`);
      for (const [key, value] of Object.entries(fields)) command.set(key, value);
      items.push({
        path,
        fields,
        command: command.build(),
        undo: new Cmd(`${path} remove ${selector}`).build(),
        activate:
          disabledSections.has(path) && r.fields.disabled !== "yes"
            ? new Cmd(`${path} enable ${selector}`).build()
            : undefined,
        tag,
        line: r.line,
      });
    }
  }
  for (const s of sourceConfig.sections)
    if (s.records.length && !selected.has(s.path as MigrationSection))
      manual.push({
        section: s.path,
        records: s.records.length,
        reason:
          "Not selected or not supported. Retain and migrate manually; nothing from this section is replayed.",
      });
  // Resolve address-list dependencies after all included records are known.
  const addrLists = new Set(
    items.filter((i) => i.path === "/ip/firewall/address-list").map((i) => i.fields.list),
  );
  for (const i of items)
    for (const key of ["src-address-list", "dst-address-list"])
      if (i.fields[key] && !addrLists.has(i.fields[key]))
        blockers.push(`Include address-list ${i.fields[key]} or remove its dependent section.`);
  if (!items.length) blockers.push("No transferable objects in the selected sections.");
  if (items.length > 60)
    blockers.push(
      "At most 60 objects per plan; split the migration to stay below Safe Mode history capacity.",
    );
  return {
    items,
    blockers: [...new Set(blockers)],
    manual,
    fingerprint: inventoryHash(source, target),
  };
}
