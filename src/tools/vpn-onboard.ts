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
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { Cmd, looksLikeError, quoted, quoteValue } from "../core/routeros";

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
      "tunnel. SSH devices only. Returns the client config.",
    inputSchema: {
      interface: z.string().describe("Existing WireGuard SERVER interface, e.g. 'wg-server'"),
      user: z.string().describe("User/device label, e.g. 'alice-laptop'"),
      address: z.string().describe("Tunnel IP to assign the client, e.g. '10.20.0.50'"),
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
      const clientAddr = a.address.includes("/") ? a.address : `${a.address}/32`;
      const { privateKey, publicKey } = generateWireGuardKeypair();

      // Add the client as a peer on the server.
      const add = await executeMikrotikCommand(
        new Cmd("/interface wireguard peers add")
          .set("interface", a.interface)
          .set("public-key", publicKey)
          .set("allowed-address", clientAddr)
          .set("comment", `vpn-user: ${a.user}`)
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

      return `WireGuard user '${a.user}' onboarded (peer added to ${a.interface}, IP ${clientAddr}).\nImport this into the WireGuard app, or paste it into a QR generator to scan:\n\n${config}`;
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
    inputSchema: { user: z.string().describe("The user label used at onboarding") },
    async handler(a, ctx) {
      const count = await executeMikrotikCommand(
        `/interface wireguard peers print count-only where comment=${quoted(`vpn-user: ${quoteValue(a.user)}`)}`,
        ctx,
      );
      if (count.trim() === "0") return `No WireGuard peer found for user '${a.user}'.`;
      const r = await executeMikrotikCommand(
        `/interface wireguard peers remove [find comment=${quoted(`vpn-user: ${quoteValue(a.user)}`)}]`,
        ctx,
      );
      if (looksLikeError(r)) return `Failed to revoke '${a.user}': ${r}`;
      return `WireGuard user '${a.user}' revoked — peer removed, access cut.`;
    },
  }),
];
