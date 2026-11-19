/**
 * Captive Portal Builder — stand up a guest Wi-Fi hotspot with a sign-in portal
 * from one intent: the IP gateway, address pool, DHCP, the `/ip hotspot` server +
 * profile (with a per-guest bandwidth cap and DNS name), and a walled garden
 * (sites reachable before sign-in). Plus a voucher generator for printable
 * guest codes. Previewable before applying.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { DANGEROUS, DESTRUCTIVE, READ, WRITE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { Cmd, looksLikeError, quoted } from "../core/routeros";
import { parseRecords } from "../core/routeros-parse";
import { voucherSheetCsv, voucherSheetHtml } from "../core/voucher-sheet";

/** Where printable voucher sheets go: `MIKROTIK_VOUCHER_DIR`, or `~/.mikrotik-mcp/vouchers`. */
export function voucherDir(): string {
  return process.env.MIKROTIK_VOUCHER_DIR || join(homedir(), ".mikrotik-mcp", "vouchers");
}

const BATCH_TAG = "voucher-batch: ";
const BATCH = /^[A-Za-z0-9][A-Za-z0-9_-]{0,30}$/;

function defaultRange(subnet: string): string {
  const o = subnet.split("/")[0].split(".");
  return `${o[0]}.${o[1]}.${o[2]}.10-${o[0]}.${o[1]}.${o[2]}.254`;
}

export const hotspotBuilderTools: ToolModule = [
  defineTool({
    name: "build_guest_hotspot",
    title: "Build Guest Hotspot (Captive Portal)",
    annotations: DANGEROUS,
    description:
      "Stands up a guest hotspot with a captive sign-in portal in one call: the gateway IP, an address " +
      "pool, a DHCP server, the `/ip hotspot` server + profile (with a per-guest `rate_limit` bandwidth " +
      "cap and optional `dns_name`), and a walled garden (the `walled_garden` domains reachable BEFORE " +
      "sign-in, e.g. your payment/login pages). DEFAULTS TO A DRY RUN (`apply=false`) showing every " +
      "command; set `apply=true` to build it. Generate printable guest codes with " +
      "generate_hotspot_vouchers. Returns the plan or a build report.",
    inputSchema: {
      interface: z.string().describe("Interface/bridge the hotspot runs on, e.g. 'guest-bridge'"),
      subnet: z.string().default("10.5.50.0/24").describe("Hotspot subnet"),
      gateway: z.string().default("10.5.50.1").describe("Router address in the hotspot subnet"),
      pool_range: z.string().optional().describe("DHCP/hotspot pool; defaults to .10–.254"),
      dns_name: z.string().optional().describe("Captive-portal hostname, e.g. 'guest.wifi'"),
      rate_limit: z.string().default("5M/5M").describe("Per-guest max-limit (rx/tx)"),
      walled_garden: z
        .array(z.string())
        .optional()
        .describe("Domains reachable before sign-in, e.g. ['*.stripe.com']"),
      apply: z.boolean().default(false).describe("false = preview (default); true = build"),
    },
    async handler(a, ctx) {
      const prefix = a.subnet.split("/")[1] ?? "24";
      const range = a.pool_range ?? defaultRange(a.subnet);
      const pool = `hs-${a.interface}-pool`;
      const profile = `hs-${a.interface}`;
      const groups: { label: string; commands: string[] }[] = [
        {
          label: "Gateway + pool + DHCP",
          commands: [
            new Cmd("/ip address add")
              .set("address", `${a.gateway}/${prefix}`)
              .set("interface", a.interface)
              .build(),
            new Cmd("/ip pool add").set("name", pool).set("ranges", range).build(),
            new Cmd("/ip dhcp-server add")
              .set("name", profile)
              .set("interface", a.interface)
              .set("address-pool", pool)
              .set("disabled", "no")
              .build(),
            new Cmd("/ip dhcp-server network add")
              .set("address", a.subnet)
              .set("gateway", a.gateway)
              .set("dns-server", a.gateway)
              .build(),
          ],
        },
        {
          label: "Hotspot server + profile (per-guest cap)",
          commands: [
            new Cmd("/ip hotspot profile add")
              .set("name", profile)
              .set("hotspot-address", a.gateway)
              .opt("dns-name", a.dns_name)
              .set("rate-limit", a.rate_limit)
              .build(),
            new Cmd("/ip hotspot add")
              .set("name", profile)
              .set("interface", a.interface)
              .set("address-pool", pool)
              .set("profile", profile)
              .set("addresses-per-mac", 2)
              .build(),
          ],
        },
      ];
      const garden = (a.walled_garden ?? []) as string[];
      if (garden.length) {
        groups.push({
          label: "Walled garden (pre-auth access)",
          commands: garden.map((host) =>
            new Cmd("/ip hotspot walled-garden add")
              .set("dst-host", host)
              .set("comment", `hotspot ${profile}`)
              .build(),
          ),
        });
      }

      const all = groups.flatMap((g) => g.commands);
      if (!a.apply) {
        const preview = groups
          .map((g) => `# ${g.label}\n${g.commands.map((c) => `  ${c}`).join("\n")}`)
          .join("\n\n");
        return `DRY RUN — guest hotspot on '${a.interface}' (${a.subnet}, cap ${a.rate_limit}); ${all.length} command(s) (set apply=true to build):\n\n${preview}`;
      }
      const done: string[] = [];
      for (const cmd of all) {
        const result = await executeMikrotikCommand(cmd, ctx);
        if (looksLikeError(result)) {
          return `Built ${done.length}/${all.length} commands, then FAILED: ${result}\nReview the partial hotspot.`;
        }
        done.push(cmd);
      }
      return `Guest hotspot built on '${a.interface}' (${a.subnet}, ${a.rate_limit} per guest)${garden.length ? `, walled garden: ${garden.join(", ")}` : ""}. Add guest codes with generate_hotspot_vouchers.`;
    },
  }),

  defineTool({
    name: "generate_hotspot_vouchers",
    title: "Generate Hotspot Vouchers",
    annotations: WRITE,
    description:
      "Creates `count` random guest login codes as `/ip hotspot user` entries (username = password = " +
      "code), each with an optional uptime limit and hotspot user profile — the printable vouchers you " +
      "hand to guests. DEFAULTS TO A DRY RUN (`apply=false`) that just shows the codes it would create; " +
      "set `apply=true` to add them. Every voucher of one call belongs to a batch (the `batch` name, " +
      "or one made from the date), so `list_voucher_batches` can count how many were used and " +
      "`remove_voucher_batch` can clear the unused ones. With `print=true` the tool also writes a " +
      "print-ready HTML sheet (cards with cut lines, three across) and a CSV file to a folder on the " +
      "MCP host and returns the paths; `title`, `validity`, `price` and `note` are printed on each " +
      "card, and `login_url` adds a QR code that signs the guest in when scanned. Returns the " +
      "generated codes.",
    inputSchema: {
      count: z.number().int().min(1).max(200).default(10),
      batch: z.string().regex(BATCH).optional().describe("Batch name, e.g. 'hotel-2026-11'"),
      print: z.boolean().default(false).describe("Write a printable HTML sheet and a CSV file"),
      title: z.string().max(60).default("Guest Wi-Fi").describe("Printed on each card"),
      validity: z.string().max(40).optional().describe("Printed text, e.g. '1 day'"),
      price: z.string().max(20).optional().describe("Printed text, e.g. '5 EUR'"),
      note: z.string().max(120).optional().describe("Small print, e.g. how to connect"),
      login_url: z
        .string()
        .url()
        .optional()
        .describe("Hotspot login address, e.g. 'http://hotspot.lan/login', for a QR code"),
      uptime_limit: z.string().optional().describe("Per-voucher uptime, e.g. '1h', '1d'"),
      profile: z.string().optional().describe("Hotspot user profile to assign"),
      code_prefix: z.string().default("g").describe("Prefix for the generated codes"),
      apply: z.boolean().default(false).describe("false = preview codes (default); true = create"),
    },
    async handler(a, ctx) {
      const codes = Array.from(
        { length: a.count },
        () => `${a.code_prefix}${randomBytes(3).toString("hex")}`,
      );
      if (!a.apply) {
        return `DRY RUN — ${codes.length} voucher(s) would be created (set apply=true):\n\n${codes.join("\n")}`;
      }
      const batch =
        a.batch ?? `b${new Date().toISOString().slice(0, 10)}-${randomBytes(2).toString("hex")}`;
      const created: string[] = [];
      for (const code of codes) {
        const cmd = new Cmd("/ip hotspot user add")
          .set("name", code)
          .set("password", code)
          .opt("limit-uptime", a.uptime_limit)
          .opt("profile", a.profile)
          .set("comment", `${BATCH_TAG}${batch}`)
          .build();
        const result = await executeMikrotikCommand(cmd, ctx);
        if (looksLikeError(result)) {
          return `Created ${created.length}/${codes.length} vouchers, then FAILED: ${result}\nCodes so far: ${created.join(", ")}`;
        }
        created.push(code);
      }
      const files: string[] = [];
      if (a.print) {
        try {
          const sheet = {
            title: a.title,
            batch,
            codes: created,
            validity: a.validity ?? a.uptime_limit,
            price: a.price,
            note: a.note,
            loginUrl: a.login_url,
          };
          const dir = voucherDir();
          // The codes are passwords: the folder and files are for the owner only.
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          writeFileSync(join(dir, `${batch}.html`), voucherSheetHtml(sheet), { mode: 0o600 });
          writeFileSync(join(dir, `${batch}.csv`), voucherSheetCsv(sheet), { mode: 0o600 });
          files.push(
            `Printable sheet: ${join(dir, `${batch}.html`)} (open it in a browser and print)`,
            `CSV: ${join(dir, `${batch}.csv`)}`,
          );
        } catch (error) {
          files.push(`NOT written: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return [
        `Created ${created.length} hotspot voucher(s)${a.uptime_limit ? ` (${a.uptime_limit} each)` : ""} in batch '${batch}'.`,
        ...files,
        "",
        created.join("\n"),
      ].join("\n");
    },
  }),

  defineTool({
    name: "list_voucher_batches",
    title: "List Hotspot Voucher Batches",
    annotations: READ,
    description:
      "Lists the batches of vouchers made by generate_hotspot_vouchers: for each batch the number " +
      "of vouchers, how many were used (the guest signed in at least once) and how many are still " +
      "unused. Use it to see how a batch sells, or before you clear old unused codes with " +
      "remove_voucher_batch. Hotspot users that were added another way are not listed.",
    inputSchema: {},
    async handler(_a, ctx) {
      const rows = parseRecords(
        await executeMikrotikCommand("/ip hotspot user print detail", ctx),
      ).rows.filter((row) => (row.comment ?? "").startsWith(BATCH_TAG));
      if (rows.length === 0) return "No voucher batch is on this router.";
      const batches = new Map<string, { total: number; used: number }>();
      for (const row of rows) {
        const name = row.comment!.slice(BATCH_TAG.length);
        const entry = batches.get(name) ?? { total: 0, used: 0 };
        entry.total += 1;
        // A voucher that was never used has no uptime.
        if (row.uptime && row.uptime !== "0s" && row.uptime !== "00:00:00") entry.used += 1;
        batches.set(name, entry);
      }
      return Array.from(
        batches,
        ([name, b]) => `${name}  total=${b.total}  used=${b.used}  unused=${b.total - b.used}`,
      ).join("\n");
    },
  }),

  defineTool({
    name: "remove_voucher_batch",
    title: "Remove a Hotspot Voucher Batch",
    annotations: DESTRUCTIVE,
    description:
      "Removes the vouchers of one batch made by generate_hotspot_vouchers. By default only the " +
      "UNUSED vouchers go (codes nobody signed in with), so a guest who is using one keeps access; " +
      "`include_used=true` removes every voucher of the batch. DEFAULTS TO A DRY RUN " +
      "(`apply=false`) that counts what would be removed. Use it to retire codes that were printed " +
      "and not sold. A removed code can never sign in again.",
    inputSchema: {
      batch: z.string().regex(BATCH).describe("The batch name"),
      include_used: z.boolean().default(false).describe("Also remove vouchers that were used"),
      apply: z.boolean().default(false).describe("false = count only; true = remove"),
    },
    async handler(a, ctx) {
      const rows = parseRecords(
        await executeMikrotikCommand(
          `/ip hotspot user print detail where comment=${quoted(`${BATCH_TAG}${a.batch}`)}`,
          { ...ctx, risk: "READ" },
        ),
      ).rows;
      if (rows.length === 0) return `No voucher of batch '${a.batch}' is on this router.`;
      const unused = (row: Record<string, string>): boolean =>
        !row.uptime || row.uptime === "0s" || row.uptime === "00:00:00";
      const targets = rows.filter((row) => a.include_used || unused(row)).filter((row) => row.name);
      if (targets.length === 0)
        return `Every voucher of batch '${a.batch}' was used (${rows.length}). Pass include_used=true to remove them.`;
      if (!a.apply)
        return `DRY RUN — would remove ${targets.length} of ${rows.length} voucher(s) of batch '${a.batch}'. Set apply=true to remove.`;
      let removed = 0;
      for (const row of targets) {
        const result = await executeMikrotikCommand(
          `/ip hotspot user remove [find name=${quoted(row.name!)} comment=${quoted(`${BATCH_TAG}${a.batch}`)}]`,
          ctx,
        );
        if (looksLikeError(result))
          return `Removed ${removed} of ${targets.length}, then FAILED at '${row.name}': ${result}`;
        removed += 1;
      }
      return `Removed ${removed} voucher(s) of batch '${a.batch}'. ${rows.length - removed} remain.`;
    },
  }),
];
