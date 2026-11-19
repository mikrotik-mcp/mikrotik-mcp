/**
 * Road-Warrior VPN Onboarding — generate a ready-to-use WireGuard remote-access
 * profile per user in one step. Creates the client keypair, adds the peer to the
 * server interface, reads the server's public key, and returns a complete client
 * config the user pastes into the WireGuard app (or a QR generator) — plus a
 * revoke action when they leave.
 *
 * The client keypair is generated with node:crypto's X25519 (the curve
 * WireGuard uses) — no external dependency. `generateWireGuardKeypair` is tested.
 */
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { sendMail } from "../alerts/smtp";
import { executeMikrotikCommand } from "../core/connector";
import { DESTRUCTIVE, READ, WRITE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { Cmd, looksLikeError, quoted } from "../core/routeros";
import { parseRecords } from "../core/routeros-parse";
import { getConfig } from "../core/runtime";
import {
  isDate,
  isExpired,
  nextFreeAddress,
  qrPng,
  readUserComment,
  userComment,
  userCommentPattern,
} from "../core/wireguard-portal";

/** Where saved client profiles go: `MIKROTIK_WIREGUARD_DIR`, or `~/.mikrotik-mcp/wireguard`. */
export function wireguardDir(): string {
  return process.env.MIKROTIK_WIREGUARD_DIR || join(homedir(), ".mikrotik-mcp", "wireguard");
}

/** A user label that is also safe as a file name and inside a peer comment. */
const USER = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._@-]{0,62}$/,
    "Use letters, digits, '.', '_', '@' and '-' (63 characters at most).",
  );
const today = (): string => new Date().toISOString().slice(0, 10);

/** Generate a WireGuard (Curve25519/X25519) keypair as base64 strings. */
export function generateWireGuardKeypair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const priv = privateKey.export({ type: "pkcs8", format: "der" });
  const pub = publicKey.export({ type: "spki", format: "der" });
  // A WireGuard key is the raw 32-byte scalar = the last 32 bytes of the DER.
  return {
    privateKey: priv.subarray(priv.length - 32).toString("base64"),
    publicKey: pub.subarray(pub.length - 32).toString("base64"),
  };
}

export const vpnOnboardTools: ToolModule = [
  defineTool({
    name: "onboard_wireguard_user",
    title: "Onboard WireGuard Remote User",
    annotations: WRITE,
    description:
      "Generates a ready-to-use WireGuard remote-access profile for one user: creates a client " +
      "keypair, adds the peer to the server `interface` (allowed-address = the client's tunnel IP), " +
      "reads the server's public key, and returns a complete client .conf to paste into the WireGuard " +
      "app or a QR generator. The peer is tagged `vpn-user: <user>` so revoke_wireguard_user can remove " +
      "it. NOTE: the returned config contains the client PRIVATE key (required to connect) — handle it " +
      "securely. `endpoint` is the server's public host:port; `allowed_ips` controls split vs full " +
      "tunnel. Leave `address` out and the tool picks the lowest free address in the interface's " +
      "own subnet, so two users never get the same one. `expires` (YYYY-MM-DD) records an end " +
      "date on the peer; `expire_wireguard_users` then disables or removes peers past their date. " +
      "`save=true` writes `<user>.conf` and a `<user>.png` QR code (scan it in the WireGuard phone " +
      "app) to a private folder on the MCP host and returns the paths. `email_to` sends the profile " +
      "by email through the alert email channel; the message carries the private key, so use it " +
      "only for a mailbox you trust. SSH devices only. Returns the client config.",
    inputSchema: {
      interface: z.string().describe("Existing WireGuard SERVER interface, e.g. 'wg-server'"),
      user: USER.describe("User/device label, e.g. 'alice-laptop'"),
      address: z
        .string()
        .optional()
        .describe("Tunnel IP for the client, e.g. '10.20.0.50'. Omit to take the lowest free one."),
      expires: z
        .string()
        .refine(isDate, "Use a date as YYYY-MM-DD")
        .optional()
        .describe("Last day the user may connect, e.g. '2026-12-31'"),
      save: z
        .boolean()
        .default(false)
        .describe("Write <user>.conf and a <user>.png QR code on the MCP host"),
      email_to: z
        .string()
        .regex(/^[^\s<>@,;]+@[^\s<>@,;]+$/)
        .optional()
        .describe("Email the profile to this address (needs the alert email channel)"),
      endpoint: z
        .string()
        .describe("Server public endpoint host:port, e.g. 'vpn.example.com:13231'"),
      dns: z.string().optional().describe("DNS for the client, e.g. '10.20.0.1'"),
      allowed_ips: z
        .string()
        .default("0.0.0.0/0")
        .describe("Client AllowedIPs: '0.0.0.0/0' full-tunnel, or a LAN subnet for split-tunnel"),
      keepalive: z.string().default("25").describe("PersistentKeepalive seconds"),
    },
    async handler(a, ctx) {
      ctx.info(`Onboarding WireGuard user '${a.user}' on ${a.interface}`);
      const read = { ...ctx, risk: "READ" as const };
      const peers = parseRecords(
        await executeMikrotikCommand(
          `/interface wireguard peers print detail where interface=${quoted(a.interface)}`,
          read,
        ),
      ).rows;
      if (peers.some((peer) => readUserComment(peer.comment ?? "")?.user === a.user))
        return `A WireGuard user named '${a.user}' already exists on ${a.interface}. Revoke it first, or pick another label.`;

      let address = a.address;
      if (!address) {
        const own = parseRecords(
          await executeMikrotikCommand(
            `/ip address print detail where interface=${quoted(a.interface)}`,
            read,
          ),
        ).rows.find((row) => row.address?.includes("."));
        if (!own?.address)
          return `Cannot pick an address: ${a.interface} has no IPv4 address. Pass 'address', or add an address to the interface.`;
        const free = nextFreeAddress(
          own.address,
          peers.map((peer) => peer["allowed-address"] ?? ""),
        );
        if (!free) return `Cannot pick an address: the subnet ${own.address} is full.`;
        address = free;
      }
      const clientAddr = address.includes("/") ? address : `${address}/32`;
      const { privateKey, publicKey } = generateWireGuardKeypair();

      // Add the client as a peer on the server.
      const add = await executeMikrotikCommand(
        new Cmd("/interface wireguard peers add")
          .set("interface", a.interface)
          .set("public-key", publicKey)
          .set("allowed-address", clientAddr)
          .set("comment", userComment(a.user, a.expires))
          .build(),
        ctx,
      );
      if (looksLikeError(add)) return `Failed to add peer for '${a.user}': ${add}`;

      // Read the server's public key for the client config.
      const detail = await executeMikrotikCommand(
        `/interface wireguard print detail where name=${quoted(a.interface)}`,
        ctx,
      );
      const serverPub = detail.match(/public-key="?([A-Za-z0-9+/]{42,44}=)"?/)?.[1];
      if (!serverPub) {
        return `Added the peer, but could not read the server public key from '${a.interface}'. Add it to the config manually.`;
      }

      const config = [
        "[Interface]",
        `PrivateKey = ${privateKey}`,
        `Address = ${clientAddr}`,
        ...(a.dns ? [`DNS = ${a.dns}`] : []),
        "",
        "[Peer]",
        `PublicKey = ${serverPub}`,
        `Endpoint = ${a.endpoint}`,
        `AllowedIPs = ${a.allowed_ips}`,
        `PersistentKeepalive = ${a.keepalive}`,
      ].join("\n");

      const notes: string[] = [];
      if (a.save) {
        try {
          const dir = wireguardDir();
          // Private keys: the folder and the files are for the owner only.
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          const conf = join(dir, `${a.user}.conf`);
          const png = join(dir, `${a.user}.png`);
          writeFileSync(conf, `${config}\n`, { mode: 0o600 });
          writeFileSync(png, qrPng(config), { mode: 0o600 });
          chmodSync(conf, 0o600);
          chmodSync(png, 0o600);
          notes.push(`Saved: ${conf}`, `QR code: ${png} (scan it in the WireGuard phone app)`);
        } catch (error) {
          notes.push(`NOT saved: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (a.email_to) {
        const smtp = getConfig().alerts?.channels?.email;
        if (!smtp) notes.push("NOT emailed: the alert email channel is not configured.");
        else
          try {
            await sendMail(
              { ...smtp, to: a.email_to },
              `Your WireGuard profile: ${a.user}`,
              `Import this file into the WireGuard app. It holds your private key: do not forward it.\n\n${config}\n`,
            );
            notes.push(`Emailed to ${a.email_to}.`);
          } catch (error) {
            notes.push(`NOT emailed: ${error instanceof Error ? error.message : String(error)}`);
          }
      }

      return [
        `WireGuard user '${a.user}' onboarded (peer added to ${a.interface}, IP ${clientAddr}` +
          `${a.expires ? `, expires ${a.expires}` : ""}).`,
        ...notes,
        "Import this into the WireGuard app:",
        "",
        config,
      ].join("\n");
    },
  }),

  defineTool({
    name: "revoke_wireguard_user",
    title: "Revoke WireGuard Remote User",
    annotations: DESTRUCTIVE,
    description:
      "Revokes a remote-access user created by onboard_wireguard_user: removes the WireGuard peer " +
      "tagged `vpn-user: <user>` from the server, immediately cutting their access. Returns whether a " +
      "peer was removed.",
    inputSchema: { user: z.string().min(1).describe("The user label used at onboarding") },
    async handler(a, ctx) {
      // A regular expression, so a peer with an expiry in its comment matches too.
      const where = `comment~${quoted(userCommentPattern(a.user))}`;
      const count = await executeMikrotikCommand(
        `/interface wireguard peers print count-only where ${where}`,
        ctx,
      );
      if (count.trim() === "0") return `No WireGuard peer found for user '${a.user}'.`;
      const r = await executeMikrotikCommand(
        `/interface wireguard peers remove [find ${where}]`,
        ctx,
      );
      if (looksLikeError(r)) return `Failed to revoke '${a.user}': ${r}`;
      return `WireGuard user '${a.user}' revoked — peer removed, access cut.`;
    },
  }),

  defineTool({
    name: "list_wireguard_users",
    title: "List WireGuard Remote Users",
    annotations: READ,
    description:
      "Lists the remote-access users created by onboard_wireguard_user (peers tagged " +
      "`vpn-user: <user>`): the label, interface, tunnel address, expiry date and whether it has " +
      "passed, whether the peer is disabled, and the last handshake. Use it to see who has VPN " +
      "access, who has not connected for a long time, and whose access has expired. Peers that " +
      "were added another way are not listed; use list_wireguard_peers for all of them.",
    inputSchema: {
      interface: z.string().optional().describe("Only users of this WireGuard interface"),
    },
    async handler(a, ctx) {
      const rows = parseRecords(
        await executeMikrotikCommand("/interface wireguard peers print detail", ctx),
      ).rows;
      const now = today();
      const users = rows
        .map((row) => ({ row, tag: readUserComment(row.comment ?? "") }))
        .filter(({ row, tag }) => tag && (!a.interface || row.interface === a.interface));
      if (users.length === 0) return "No WireGuard remote users found.";
      return users
        .map(({ row, tag }) =>
          [
            tag!.user,
            `interface=${row.interface ?? "?"}`,
            `address=${row["allowed-address"] ?? "?"}`,
            `expires=${tag!.expires ?? "never"}${isExpired(tag!.expires, now) ? " (EXPIRED)" : ""}`,
            `disabled=${row.disabled === "yes" || row.disabled === "true" ? "yes" : "no"}`,
            `last-handshake=${row["last-handshake"] || "never"}`,
          ].join("  "),
        )
        .join("\n");
    },
  }),

  defineTool({
    name: "expire_wireguard_users",
    title: "Disable or Remove Expired WireGuard Users",
    annotations: DESTRUCTIVE,
    description:
      "Acts on the remote-access users whose `expires` date (set at onboard_wireguard_user) has " +
      "passed. `action=disable` (the default) disables the peer, so access stops and the peer can " +
      "be enabled again; `action=remove` deletes it. DEFAULTS TO A DRY RUN (`apply=false`) that " +
      "lists who would be affected. Users without an expiry date are never touched. Run it on a " +
      "schedule to make expiry dates take effect: a date alone does not stop a connection.",
    inputSchema: {
      action: z.enum(["disable", "remove"]).default("disable"),
      apply: z.boolean().default(false).describe("false = list only (default); true = act"),
    },
    async handler(a, ctx) {
      const rows = parseRecords(
        await executeMikrotikCommand("/interface wireguard peers print detail", {
          ...ctx,
          risk: "READ",
        }),
      ).rows;
      const now = today();
      const due = rows
        .map((row) => ({ row, tag: readUserComment(row.comment ?? "") }))
        .filter(({ row, tag }) => {
          if (!tag || !isExpired(tag.expires, now)) return false;
          // A peer that is already disabled needs no second disable.
          return a.action === "remove" || (row.disabled !== "yes" && row.disabled !== "true");
        });
      if (due.length === 0) return `No WireGuard user is past its expiry date (today is ${now}).`;
      const names = due.map(({ tag }) => `${tag!.user} (expired ${tag!.expires})`);
      if (!a.apply)
        return `DRY RUN: would ${a.action} ${due.length} user(s): ${names.join(", ")}. Set apply=true to do it.`;
      const done: string[] = [];
      for (const { tag } of due) {
        const result = await executeMikrotikCommand(
          `/interface wireguard peers ${a.action} [find comment~${quoted(userCommentPattern(tag!.user))}]`,
          ctx,
        );
        if (looksLikeError(result))
          return `Did ${done.length} of ${due.length}, then FAILED at '${tag!.user}': ${result}`;
        done.push(tag!.user);
      }
      return `${a.action === "remove" ? "Removed" : "Disabled"} ${done.length} expired user(s): ${names.join(", ")}.`;
    },
  }),
];
