/**
 * Security Shield — harden a RouterOS firewall against common attacks (DDoS,
 * SSH/Winbox brute-force, port scans, spoofing, floods) by applying a curated,
 * OPT-IN set of best-practice rules the user chooses (granular toggles or a
 * preset). Composes the existing /ip firewall building blocks; it does not
 * duplicate CRUD.
 *
 * Safety is the whole point of a firewall tool:
 *   • anti-lockout — `trusted_sources` and established/related are accepted
 *     BEFORE any drop, and input-chain drops are refused without a trusted
 *     source (unless `i_accept_lockout_risk`);
 *   • Safe-Mode apply (default) — changes ride the persistent Safe-Mode session,
 *     so a rule that drops your own access auto-reverts when the SSH session dies
 *     mid-apply, and only a still-connected session commits;
 *   • every rule is tagged with a `security-shield:` comment so it is auditable
 *     and removable.
 *
 * The pure `buildShieldRules` is unit-tested; the handler wires apply/preview.
 */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { DANGEROUS, DESTRUCTIVE, READ, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { getDevice, resolveDeviceName } from "../core/runtime";
import { getSafeModeManager } from "../ssh/safe-mode";
import { Cmd, looksLikeError, quoted } from "../core/routeros";

/** Comment prefix that tags (and later identifies/removes) every rule we add. */
export const SHIELD_TAG = "security-shield";

/** The protections a caller can toggle on. */
export const PROTECTIONS = [
  "state_hygiene",
  "ssh_bruteforce",
  "ddos_conn_limit",
  "syn_flood",
  "icmp_limit",
  "port_scan",
  "anti_spoof",
  "raw_drops",
  "mgmt_lockdown",
] as const;
export type Protection = (typeof PROTECTIONS)[number];

/** Preset bundles — the "user choices more" knob. */
export const PRESETS: Record<string, Protection[]> = {
  basic: ["state_hygiene", "ssh_bruteforce", "icmp_limit"],
  standard: [
    "state_hygiene",
    "ssh_bruteforce",
    "ddos_conn_limit",
    "syn_flood",
    "icmp_limit",
    "port_scan",
    "anti_spoof",
  ],
  paranoid: [...PROTECTIONS],
};

/** RFC1918 / martian source prefixes that must never arrive on a WAN. */
const BOGONS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "224.0.0.0/4",
  "240.0.0.0/4",
];

export interface ShieldOptions {
  enabled: Set<Protection> | Protection[];
  mgmtPorts: string; // e.g. "22,8291,8728"
  sshPorts: string; // ports the brute-force ladder watches
  connLimit: number; // per-source TCP connection cap
  synRate: string; // e.g. "200,50:packet"
  icmpRate: string; // e.g. "50,10:packet"
  wanInterface?: string; // required for anti_spoof
  trustedSources?: string; // address or address-list name accepted first
}

/** One protection's generated commands, kept grouped for a readable preview. */
export interface ShieldGroup {
  protection: Protection | "trusted" | "blacklist";
  commands: string[];
}

/** Build the firewall command list for the selected protections, in firewall order. */
export function buildShieldRules(o: ShieldOptions): ShieldGroup[] {
  const on = new Set(o.enabled);
  const groups: ShieldGroup[] = [];
  const fw = (
    parts: [string, string | number][],
    label: string,
    table: "filter" | "raw" = "filter",
  ): string => {
    const c = new Cmd(`/ip firewall ${table} add`);
    for (const [k, v] of parts) c.set(k, v);
    c.set("comment", `${SHIELD_TAG}: ${label}`);
    return c.build();
  };
  const bl = `${SHIELD_TAG}-blacklist`;

  // 0. Trusted sources are accepted before anything can drop them.
  if (o.trustedSources) {
    const key = /^[\d.:/]+$/.test(o.trustedSources) ? "src-address" : "src-address-list";
    groups.push({
      protection: "trusted",
      commands: [
        fw(
          [
            ["chain", "input"],
            ["action", "accept"],
            [key, o.trustedSources],
          ],
          "trusted source",
        ),
      ],
    });
  }

  if (on.has("state_hygiene")) {
    groups.push({
      protection: "state_hygiene",
      commands: [
        fw(
          [
            ["chain", "input"],
            ["action", "accept"],
            ["connection-state", "established,related,untracked"],
          ],
          "accept established/related",
        ),
        fw(
          [
            ["chain", "input"],
            ["action", "drop"],
            ["connection-state", "invalid"],
          ],
          "drop invalid",
        ),
      ],
    });
  }

  // Blacklisted sources are dropped early (raw too, to save CPU under attack).
  if (on.has("ssh_bruteforce") || on.has("ddos_conn_limit") || on.has("raw_drops")) {
    const cmds = [
      fw(
        [
          ["chain", "input"],
          ["action", "drop"],
          ["src-address-list", bl],
        ],
        "drop blacklisted",
      ),
    ];
    if (on.has("raw_drops")) {
      cmds.unshift(
        fw(
          [
            ["chain", "prerouting"],
            ["action", "drop"],
            ["src-address-list", bl],
          ],
          "raw drop blacklisted",
          "raw",
        ),
      );
    }
    groups.push({ protection: "blacklist", commands: cmds });
  }

  if (on.has("ssh_bruteforce")) {
    const base: [string, string | number][] = [
      ["chain", "input"],
      ["protocol", "tcp"],
      ["dst-port", o.sshPorts],
      ["connection-state", "new"],
    ];
    const stage = (from: string | null, to: string, timeout: string, label: string): string =>
      fw(
        [
          ...base,
          ...(from ? ([["src-address-list", `${SHIELD_TAG}-${from}`]] as [string, string][]) : []),
          ["action", "add-src-to-address-list"],
          ["address-list", to === "blacklist" ? bl : `${SHIELD_TAG}-${to}`],
          ["address-list-timeout", timeout],
        ],
        label,
      );
    groups.push({
      protection: "ssh_bruteforce",
      commands: [
        stage("stage3", "blacklist", "1d", "brute-force → blacklist"),
        stage("stage2", "stage3", "1m", "brute-force stage2→3"),
        stage("stage1", "stage2", "1m", "brute-force stage1→2"),
        stage(null, "stage1", "1m", "brute-force new→stage1"),
      ],
    });
  }

  if (on.has("ddos_conn_limit")) {
    groups.push({
      protection: "ddos_conn_limit",
      commands: [
        fw(
          [
            ["chain", "input"],
            ["protocol", "tcp"],
            ["connection-limit", `${o.connLimit},32`],
            ["action", "add-src-to-address-list"],
            ["address-list", bl],
            ["address-list-timeout", "1h"],
          ],
          `per-source connection cap (${o.connLimit})`,
        ),
      ],
    });
  }

  if (on.has("syn_flood")) {
    const syn: [string, string | number][] = [
      ["chain", "input"],
      ["protocol", "tcp"],
      ["tcp-flags", "syn"],
      ["connection-state", "new"],
    ];
    groups.push({
      protection: "syn_flood",
      commands: [
        fw([...syn, ["limit", o.synRate], ["action", "accept"]], "SYN within rate"),
        fw([...syn, ["action", "drop"]], "SYN flood drop"),
      ],
    });
  }

  if (on.has("icmp_limit")) {
    const icmp: [string, string | number][] = [
      ["chain", "input"],
      ["protocol", "icmp"],
    ];
    groups.push({
      protection: "icmp_limit",
      commands: [
        fw([...icmp, ["limit", o.icmpRate], ["action", "accept"]], "ICMP within rate"),
        fw([...icmp, ["action", "drop"]], "ICMP flood drop"),
      ],
    });
  }

  if (on.has("port_scan")) {
    const scanners = `${SHIELD_TAG}-scanners`;
    groups.push({
      protection: "port_scan",
      commands: [
        fw(
          [
            ["chain", "input"],
            ["protocol", "tcp"],
            ["psd", "21,3s,3,1"],
            ["action", "add-src-to-address-list"],
            ["address-list", scanners],
            ["address-list-timeout", "1d"],
          ],
          "detect port scan",
        ),
        fw(
          [
            ["chain", "input"],
            ["src-address-list", scanners],
            ["action", "drop"],
          ],
          "drop scanners",
        ),
      ],
    });
  }

  if (on.has("anti_spoof") && o.wanInterface) {
    groups.push({
      protection: "anti_spoof",
      commands: BOGONS.map((p) =>
        fw(
          [
            ["chain", "input"],
            ["in-interface", o.wanInterface as string],
            ["src-address", p],
            ["action", "drop"],
          ],
          `anti-spoof ${p}`,
        ),
      ),
    });
  }

  if (on.has("mgmt_lockdown") && o.trustedSources) {
    const key = /^[\d.:/]+$/.test(o.trustedSources) ? "src-address" : "src-address-list";
    groups.push({
      protection: "mgmt_lockdown",
      commands: [
        fw(
          [
            ["chain", "input"],
            ["protocol", "tcp"],
            ["dst-port", o.mgmtPorts],
            [key, o.trustedSources],
            ["action", "accept"],
          ],
          "mgmt allow trusted",
        ),
        fw(
          [
            ["chain", "input"],
            ["protocol", "tcp"],
            ["dst-port", o.mgmtPorts],
            ["action", "drop"],
          ],
          "mgmt lockdown",
        ),
      ],
    });
  }

  return groups;
}

/** Protections that add an input-chain drop and so risk locking out the admin. */
const LOCKOUT_RISK: Protection[] = ["state_hygiene", "anti_spoof", "mgmt_lockdown"];

export const securityShieldTools: ToolModule = [
  defineTool({
    name: "harden_firewall",
    title: "Harden Firewall (Security Shield)",
    annotations: DANGEROUS,
    description:
      "Hardens the IPv4 firewall against common attacks by applying a chosen set of best-practice " +
      "rules (DDoS/connection-rate, SSH/Winbox brute-force ladder, SYN-flood and ICMP rate limits, " +
      "port-scan detection, anti-spoof/bogon, raw pre-conntrack drops, management lock-down). Pick a " +
      "`preset` (basic · standard · paranoid) and/or toggle individual `protections`. DEFAULTS TO A " +
      "DRY RUN (`apply=false`) that returns the exact commands grouped by protection. Applying " +
      "defaults to SAFE MODE (`safe_mode=true`) so a rule that cuts your own access auto-reverts. " +
      "Anti-lockout: set `trusted_sources` (an address or address-list always accepted first); " +
      "input-drop protections are refused without it unless `i_accept_lockout_risk=true`. Every rule " +
      "is tagged with a 'security-shield:' comment — audit with audit_firewall_hardening, undo with " +
      "remove_firewall_hardening. Rules are appended; review order for an existing ruleset.",
    inputSchema: {
      preset: z
        .enum(["basic", "standard", "paranoid", "custom"])
        .default("standard")
        .describe("Bundle to apply; 'custom' uses only the `protections` toggles"),
      protections: z
        .record(z.enum(PROTECTIONS), z.boolean())
        .optional()
        .describe("Per-protection on/off, overriding/extending the preset"),
      trusted_sources: z
        .string()
        .optional()
        .describe("Address or address-list name always accepted first (anti-lockout)"),
      wan_interface: z.string().optional().describe("WAN interface (required for anti_spoof)"),
      mgmt_ports: z.string().default("22,8291,8728").describe("Management TCP ports"),
      ssh_ports: z.string().default("22").describe("Ports watched by the brute-force ladder"),
      conn_limit: z.number().int().default(100).describe("Per-source TCP connection cap"),
      syn_rate: z.string().default("200,50:packet"),
      icmp_rate: z.string().default("50,10:packet"),
      apply: z.boolean().default(false).describe("false = preview only (default); true = apply"),
      safe_mode: z
        .boolean()
        .default(true)
        .describe("Apply through Safe Mode (auto-revert on lockout)"),
      i_accept_lockout_risk: z.boolean().default(false),
    },
    async handler(a, ctx) {
      const enabled = new Set<Protection>(a.preset === "custom" ? [] : PRESETS[a.preset]);
      const toggles = (a.protections ?? {}) as Partial<Record<Protection, boolean>>;
      for (const p of PROTECTIONS) {
        if (toggles[p] === true) enabled.add(p);
        if (toggles[p] === false) enabled.delete(p);
      }
      if (enabled.has("anti_spoof") && !a.wan_interface) {
        return "anti_spoof requires `wan_interface`. Set it, or disable anti_spoof.";
      }
      const risky = LOCKOUT_RISK.some((p) => enabled.has(p));
      if (risky && !a.trusted_sources && !a.i_accept_lockout_risk) {
        return "Refusing to apply input-chain drops without `trusted_sources` (you could lock yourself out). Set trusted_sources to your admin address/list, or pass i_accept_lockout_risk=true.";
      }

      const groups = buildShieldRules({
        enabled,
        mgmtPorts: a.mgmt_ports,
        sshPorts: a.ssh_ports,
        connLimit: a.conn_limit,
        synRate: a.syn_rate,
        icmpRate: a.icmp_rate,
        wanInterface: a.wan_interface,
        trustedSources: a.trusted_sources,
      });
      const all = groups.flatMap((g) => g.commands);
      if (all.length === 0) return "No protections selected — nothing to do.";

      if (!a.apply) {
        const preview = groups
          .map((g) => `# ${g.protection}\n${g.commands.map((c) => `  ${c}`).join("\n")}`)
          .join("\n\n");
        return `DRY RUN — ${all.length} rule(s) across ${groups.length} protection group(s) (set apply=true to apply):\n\n${preview}`;
      }

      const deviceName = resolveDeviceName(ctx.device);
      const useSafe = a.safe_mode && !getDevice(deviceName).mac;
      const mgr = getSafeModeManager(deviceName);
      if (useSafe) {
        const en = await mgr.enable();
        if (en.startsWith("Error")) return `Could not enter Safe Mode: ${en}`;
      }
      const done: string[] = [];
      for (const cmd of all) {
        const result = useSafe
          ? await mgr.execute(cmd).catch((e: unknown) => `error: ${String(e)}`)
          : await executeMikrotikCommand(cmd, ctx);
        if (looksLikeError(result)) {
          if (useSafe) await mgr.rollback();
          return `Applied ${done.length}/${all.length} rules, then FAILED: ${result}\n${useSafe ? "Safe Mode rolled back — no changes kept." : "Partial rules remain; review with audit_firewall_hardening."}`;
        }
        done.push(cmd);
      }
      if (useSafe) {
        const c = await mgr.commit();
        if (!c.ok) {
          return (
            `Applied ${done.length} rule(s) but Safe Mode COMMIT FAILED — changes are NOT saved ` +
            `and will revert: ${c.message}`
          );
        }
      }
      return `Security Shield applied — ${done.length} rule(s) across ${groups.length} protection(s)${useSafe ? " (committed via Safe Mode)" : ""}. Audit with audit_firewall_hardening; undo with remove_firewall_hardening.`;
    },
  }),

  defineTool({
    name: "audit_firewall_hardening",
    title: "Audit Firewall Hardening",
    annotations: READ,
    description:
      "Reports which Security Shield protections are present on the firewall by scanning for the " +
      "'security-shield:' tagged rules (`/ip firewall filter` + `/ip firewall raw`), and notes the " +
      "foundational checks (accept established/related, drop invalid) regardless of tag. Use to see " +
      "coverage and gaps before/after harden_firewall. Complements the broader firewall-audit tools. " +
      "Returns a per-protection present/absent summary.",
    async handler(_a, ctx) {
      ctx.info("Auditing firewall hardening");
      const filter = await executeMikrotikCommand("/ip firewall filter print", ctx);
      const raw = await executeMikrotikCommand("/ip firewall raw print", ctx);
      const text = `${filter}\n${raw}`;
      const has = (needle: string): boolean => text.includes(needle);
      const checks: [string, boolean][] = [
        ["Shield rules installed", has(`${SHIELD_TAG}:`)],
        ["Brute-force ladder", has(`${SHIELD_TAG}: brute-force`)],
        ["DDoS connection cap", has(`${SHIELD_TAG}: per-source connection cap`)],
        ["SYN-flood limit", has(`${SHIELD_TAG}: SYN`)],
        ["ICMP rate limit", has(`${SHIELD_TAG}: ICMP`)],
        ["Port-scan detection", has(`${SHIELD_TAG}: detect port scan`)],
        ["Anti-spoof / bogon", has(`${SHIELD_TAG}: anti-spoof`)],
        ["Raw pre-conntrack drops", has(`${SHIELD_TAG}: raw drop`)],
        ["Management lock-down", has(`${SHIELD_TAG}: mgmt lockdown`)],
        ["Accept established/related (any)", /connection-state=.*established/.test(text)],
        [
          "Drop invalid (any)",
          /action=drop\b.*connection-state=invalid|connection-state=invalid.*action=drop/.test(
            text,
          ),
        ],
      ];
      const lines = checks.map(([label, ok]) => `  ${ok ? "✅" : "❌"} ${label}`);
      return `FIREWALL HARDENING AUDIT:\n\n${lines.join("\n")}\n\n(✅ from Security Shield tags or foundational rules; ❌ = not detected.)`;
    },
  }),

  defineTool({
    name: "remove_firewall_hardening",
    title: "Remove Firewall Hardening",
    annotations: DESTRUCTIVE,
    description:
      "Removes every firewall rule that Security Shield installed — all `/ip firewall filter` and " +
      "`/ip firewall raw` entries tagged with the 'security-shield:' comment (the shield's own " +
      "address-lists are left, since they may be referenced elsewhere). Use to roll back harden_firewall. " +
      "Does NOT touch rules you created by hand. Returns how many rules were removed.",
    async handler(_a, ctx) {
      ctx.info("Removing Security Shield firewall rules");
      let removed = 0;
      for (const table of ["filter", "raw"]) {
        const before = await executeMikrotikCommand(
          `/ip firewall ${table} print count-only where comment~${quoted(SHIELD_TAG)}`,
          ctx,
        );
        const n = Number.parseInt(before.trim(), 10);
        if (Number.isFinite(n) && n > 0) {
          const r = await executeMikrotikCommand(
            `/ip firewall ${table} remove [find comment~${quoted(SHIELD_TAG)}]`,
            ctx,
          );
          if (looksLikeError(r))
            return `Failed removing ${table} rules: ${r} (removed ${removed} so far)`;
          removed += n;
        }
      }
      return removed > 0
        ? `Removed ${removed} Security Shield rule(s). Shield address-lists were left in place.`
        : "No Security Shield rules found to remove.";
    },
  }),
];
