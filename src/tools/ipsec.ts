/**
 * IPsec (IKEv1 + IKEv2) — `/ip ipsec`.
 *
 * Covers the full IPsec stack: profiles (phase 1), peers (endpoints), identities
 * (auth), proposals (phase 2), and policies, each with CRUD, plus monitoring
 * (active-peers, installed-sa, flush, statistics).
 */
import { unsetProperties } from "../core/schema";
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, looksLikeError, isEmpty, Cmd, quoted, quoteValue } from "../core/routeros";

export const ipsecTools: ToolModule = [
  // ── Profile (phase 1) — /ip ipsec profile ─────────────────────────────────
  defineTool({
    name: "create_ipsec_profile",
    title: "Create IPsec Phase-1 Profile",
    annotations: WRITE,
    description:
      "Creates an IPsec phase-1 profile (`/ip ipsec profile add`) — the IKE algorithm set" +
      " (DH group, encryption, hash, lifetime, NAT-T, DPD) shared by one or more peers." +
      " A profile governs IKE negotiation only; for the ESP/AH parameters negotiated inside" +
      " the tunnel use create_ipsec_proposal, for the remote endpoint use create_ipsec_peer," +
      " and for the authentication credentials use create_ipsec_identity." +
      " Returns the newly created profile's detail print including its name.",
    inputSchema: {
      name: z.string().describe("Name for the new IPsec profile"),
      dh_group: z.string().default("modp2048").describe("Diffie-Hellman group, e.g. 'modp2048'"),
      enc_algorithm: z.string().optional().describe("Encryption algorithm, e.g. 'aes-256'"),
      hash_algorithm: z.string().default("sha256").describe("Hash algorithm, e.g. 'sha256'"),
      prf_algorithm: z.string().optional().describe("PRF algorithm, e.g. 'auto' or 'sha256'"),
      lifetime: z.string().optional().describe("Phase-1 lifetime, e.g. '1d'"),
      nat_traversal: z.boolean().optional().describe("Enable NAT-T"),
      dpd_interval: z.string().optional().describe("Dead peer detection interval, e.g. '2m'"),
      dpd_maximum_failures: z.number().int().optional().describe("DPD max failures before drop"),
    },
    async handler(a, ctx) {
      ctx.info(`Creating IPsec profile: name=${a.name}`);
      const cmd = new Cmd("/ip ipsec profile add")
        .set("name", a.name)
        .opt("dh-group", a.dh_group)
        .opt("enc-algorithm", a.enc_algorithm)
        .opt("hash-algorithm", a.hash_algorithm)
        .opt("prf-algorithm", a.prf_algorithm)
        .opt("lifetime", a.lifetime)
        .bool("nat-traversal", a.nat_traversal)
        .opt("dpd-interval", a.dpd_interval)
        .opt("dpd-maximum-failures", a.dpd_maximum_failures)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to create IPsec profile: ${result}`;

      const details = await executeMikrotikCommand(
        `/ip ipsec profile print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return details.trim()
        ? `IPsec profile created successfully:\n\n${details}`
        : "IPsec profile created successfully.";
    },
  }),

  defineTool({
    name: "list_ipsec_profiles",
    title: "List IPsec Phase-1 Profiles",
    annotations: READ,
    description:
      "Lists IPsec phase-1 profiles (`/ip ipsec profile print`) — the named IKE algorithm" +
      " sets configured on the device. Use to discover profile names before referencing one in" +
      " create_ipsec_peer or update_ipsec_peer. For phase-2 algorithm sets use list_ipsec_proposals;" +
      " for remote endpoints use list_ipsec_peers; for auth credentials use list_ipsec_identities;" +
      " for traffic selectors use list_ipsec_policies." +
      " Returns a table of all matching profiles or 'No IPsec profiles found.' if none exist." +
      " Optionally filter by partial name match via name_filter.",
    inputSchema: {
      name_filter: z.string().optional().describe("Partial name match"),
    },
    async handler(a, ctx) {
      ctx.info("Listing IPsec profiles");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~${quoted(a.name_filter)}`);

      const result = await executeMikrotikCommand(
        `/ip ipsec profile print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result) ? "No IPsec profiles found." : `IPSEC PROFILES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_ipsec_profile",
    title: "Get IPsec Phase-1 Profile Details",
    annotations: READ,
    description:
      "Fetches full detail for a single IPsec phase-1 profile (`/ip ipsec profile print detail`)" +
      " by exact name — use when you need the full algorithm and DPD configuration of one entry." +
      " For all profiles use list_ipsec_profiles; for phase-2 details use get_ipsec_proposal." +
      " Returns the full detail block or a not-found message.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Getting IPsec profile details: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/ip ipsec profile print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return isEmpty(result)
        ? `IPsec profile '${a.name}' not found.`
        : `IPSEC PROFILE DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_ipsec_profile",
    title: "Update IPsec Phase-1 Profile",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Updates an existing IPsec phase-1 profile (`/ip ipsec profile set`) by name —" +
      " changes IKE algorithm, lifetime, NAT-T, or DPD settings without recreating the profile." +
      " For phase-2 algorithm changes use update_ipsec_proposal; for peer endpoint changes use" +
      " update_ipsec_peer. Supply only the fields to change; unchanged fields are left as-is." +
      " Returns the updated profile detail on success.",
    inputSchema: {
      unset: unsetProperties,
      name: z.string().describe("Current name of the IPsec profile to update"),
      new_name: z.string().optional(),
      dh_group: z.string().optional(),
      enc_algorithm: z.string().optional(),
      hash_algorithm: z.string().optional(),
      prf_algorithm: z.string().optional(),
      lifetime: z.string().optional(),
      nat_traversal: z.boolean().optional(),
      dpd_interval: z.string().optional(),
      dpd_maximum_failures: z.number().int().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Updating IPsec profile: name=${a.name}`);
      const base = `/ip ipsec profile set [find name=${quoted(a.name)}]`;
      const cmd = new Cmd(base)
        .opt("name", a.new_name)
        .opt("dh-group", a.dh_group)
        .opt("enc-algorithm", a.enc_algorithm)
        .opt("hash-algorithm", a.hash_algorithm)
        .opt("prf-algorithm", a.prf_algorithm)
        .opt("lifetime", a.lifetime)
        .bool("nat-traversal", a.nat_traversal)
        .opt("dpd-interval", a.dpd_interval)
        .opt("dpd-maximum-failures", a.dpd_maximum_failures)
        .unset(a.unset)
        .build();

      if (cmd === base) return "No updates specified.";

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to update IPsec profile: ${result}`;

      const target = a.new_name ?? a.name;
      const details = await executeMikrotikCommand(
        `/ip ipsec profile print detail where name=${quoted(target)}`,
        ctx,
      );
      return `IPsec profile updated successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "remove_ipsec_profile",
    title: "Remove IPsec Phase-1 Profile",
    annotations: DESTRUCTIVE,
    description:
      "Removes an IPsec phase-1 profile (`/ip ipsec profile remove`) by exact name." +
      " Existence-checked before deletion — returns a not-found message if the profile" +
      " does not exist rather than erroring. Removing a profile that is still referenced by" +
      " active peers will cause those peers to lose their IKE algorithm configuration." +
      " For peers use remove_ipsec_peer; for proposals use remove_ipsec_proposal.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing IPsec profile: name=${a.name}`);
      const count = await executeMikrotikCommand(
        `/ip ipsec profile print count-only where name=${quoted(a.name)}`,
        ctx,
      );
      if (count.trim() === "0") return `IPsec profile '${a.name}' not found.`;

      const result = await executeMikrotikCommand(
        `/ip ipsec profile remove [find name=${quoted(a.name)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove IPsec profile: ${result}`;
      return `IPsec profile '${a.name}' removed successfully.`;
    },
  }),

  // ── Peer (phase 1 endpoint) — /ip ipsec peer ──────────────────────────────
  defineTool({
    name: "create_ipsec_peer",
    title: "Create IPsec Peer Endpoint",
    annotations: WRITE,
    description:
      "Creates an IPsec peer (`/ip ipsec peer add`) — the named remote-gateway entry" +
      " that controls IKE exchange mode, remote address, and local source address." +
      " Use to define the far-end of a site-to-site VPN or a road-warrior responder" +
      " (set address='0.0.0.0/0' and passive=true for responder-only)." +
      " A peer defines WHO and HOW to reach; for the authentication credentials use" +
      " create_ipsec_identity, for the IKE algorithm set use create_ipsec_profile, and for" +
      " the traffic selector use create_ipsec_policy." +
      " exchange_mode accepts 'main', 'aggressive', or 'ike2' (default 'ike2')." +
      " Returns the newly created peer's full detail.",
    inputSchema: {
      name: z.string().describe("Name for the new IPsec peer"),
      address: z
        .string()
        .optional()
        .describe("Remote address, e.g. '203.0.113.1' or '0.0.0.0/0' for responder"),
      profile: z.string().optional().describe("Phase-1 profile name"),
      exchange_mode: z
        .enum(["main", "aggressive", "ike2"])
        .default("ike2")
        .describe("IKE exchange mode"),
      local_address: z.string().optional(),
      port: z.number().int().optional().describe("UDP port for IKE negotiation (default 500)"),
      passive: z.boolean().optional().describe("Passive (responder only)"),
      send_initial_contact: z.boolean().optional(),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Creating IPsec peer: name=${a.name}`);
      const cmd = new Cmd("/ip ipsec peer add")
        .set("name", a.name)
        .opt("address", a.address)
        .opt("profile", a.profile)
        .opt("exchange-mode", a.exchange_mode)
        .opt("local-address", a.local_address)
        .opt("port", a.port)
        .bool("passive", a.passive)
        .bool("send-initial-contact", a.send_initial_contact)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to create IPsec peer: ${result}`;

      const details = await executeMikrotikCommand(
        `/ip ipsec peer print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return details.trim()
        ? `IPsec peer created successfully:\n\n${details}`
        : "IPsec peer created successfully.";
    },
  }),

  defineTool({
    name: "list_ipsec_peers",
    title: "List IPsec Peer Endpoints",
    annotations: READ,
    description:
      "Lists configured IPsec peer entries (`/ip ipsec peer print`) — the static remote-gateway" +
      " definitions, not live sessions. Use to find peer names before passing them to" +
      " create_ipsec_identity, update_ipsec_peer, or remove_ipsec_peer." +
      " For live established IKE sessions use get_ipsec_active_peers instead." +
      " For phase-1 algorithm sets use list_ipsec_profiles; for auth bindings use" +
      " list_ipsec_identities. Optionally filter by partial name via name_filter." +
      " Returns a table of matching peers or 'No IPsec peers found.' if none exist.",
    inputSchema: {
      name_filter: z.string().optional().describe("Partial name match"),
    },
    async handler(a, ctx) {
      ctx.info("Listing IPsec peers");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~${quoted(a.name_filter)}`);

      const result = await executeMikrotikCommand(
        `/ip ipsec peer print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result) ? "No IPsec peers found." : `IPSEC PEERS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_ipsec_peer",
    title: "Get IPsec Peer Endpoint Details",
    annotations: READ,
    description:
      "Fetches full detail for a single configured IPsec peer (`/ip ipsec peer print detail`)" +
      " by exact name. Use to inspect exchange mode, address, profile binding, and flags for" +
      " one peer entry. For all peers use list_ipsec_peers; for live session status use" +
      " get_ipsec_active_peers. Returns the full detail block or a not-found message.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Getting IPsec peer details: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/ip ipsec peer print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return isEmpty(result)
        ? `IPsec peer '${a.name}' not found.`
        : `IPSEC PEER DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_ipsec_peer",
    title: "Update IPsec Peer Endpoint",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Updates an existing IPsec peer entry (`/ip ipsec peer set`) by name — changes" +
      " remote address, exchange mode, profile, local address, or passive flag without" +
      " removing and recreating the peer." +
      " For IKE algorithm changes use update_ipsec_profile; for auth credential changes" +
      " use create_ipsec_identity or remove_ipsec_identity (identities have no update tool)." +
      " Supply only the fields to change; unchanged fields are left as-is." +
      " Returns the updated peer detail on success.",
    inputSchema: {
      unset: unsetProperties,
      name: z.string().describe("Current name of the IPsec peer to update"),
      new_name: z.string().optional(),
      address: z.string().optional(),
      profile: z.string().optional(),
      exchange_mode: z.enum(["main", "aggressive", "ike2"]).optional(),
      local_address: z.string().optional(),
      port: z.number().int().optional(),
      passive: z.boolean().optional(),
      comment: z.string().optional(),
      disabled: z.boolean().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Updating IPsec peer: name=${a.name}`);
      const base = `/ip ipsec peer set [find name=${quoted(a.name)}]`;
      const cmd = new Cmd(base)
        .opt("name", a.new_name)
        .opt("address", a.address)
        .opt("profile", a.profile)
        .opt("exchange-mode", a.exchange_mode)
        .opt("local-address", a.local_address)
        .opt("port", a.port)
        .bool("passive", a.passive)
        .opt("comment", a.comment)
        .bool("disabled", a.disabled)
        .unset(a.unset)
        .build();

      if (cmd === base) return "No updates specified.";

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to update IPsec peer: ${result}`;

      const target = a.new_name ?? a.name;
      const details = await executeMikrotikCommand(
        `/ip ipsec peer print detail where name=${quoted(target)}`,
        ctx,
      );
      return `IPsec peer updated successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "remove_ipsec_peer",
    title: "Remove IPsec Peer Endpoint",
    annotations: DESTRUCTIVE,
    description:
      "Removes an IPsec peer entry (`/ip ipsec peer remove`) by exact name." +
      " Existence-checked before deletion — returns a not-found message if the peer" +
      " does not exist rather than erroring. Removing a peer tears down any active IKE" +
      " session associated with it; associated identities and policies remain and should" +
      " be cleaned up separately via remove_ipsec_identity and remove_ipsec_policy.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing IPsec peer: name=${a.name}`);
      const count = await executeMikrotikCommand(
        `/ip ipsec peer print count-only where name=${quoted(a.name)}`,
        ctx,
      );
      if (count.trim() === "0") return `IPsec peer '${a.name}' not found.`;

      const result = await executeMikrotikCommand(
        `/ip ipsec peer remove [find name=${quoted(a.name)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove IPsec peer: ${result}`;
      return `IPsec peer '${a.name}' removed successfully.`;
    },
  }),

  // ── Identity (auth) — /ip ipsec identity ──────────────────────────────────
  defineTool({
    name: "create_ipsec_identity",
    title: "Create IPsec Identity (Auth Binding)",
    annotations: WRITE,
    description:
      "Creates an IPsec identity (`/ip ipsec identity add`) — the authentication binding" +
      " that ties a peer to its credentials (pre-shared key, RSA certificate, or EAP)." +
      " An identity is mandatory alongside every peer before IKE negotiation can succeed." +
      " The peer field must match an existing peer name from list_ipsec_peers." +
      " auth_method accepts 'pre-shared-key' (default), 'rsa-signature'," +
      " 'digital-signature', 'eap', or 'eap-radius'; supply secret for PSK," +
      " certificate for RSA/digital-signature." +
      " generate_policy ('port-override'/'port-strict') and mode_config enable dynamic" +
      " policy creation for road-warrior/IKEv2 EAP clients." +
      " For the remote endpoint use create_ipsec_peer; for traffic selectors use" +
      " create_ipsec_policy. Returns the identity detail for the peer on success.",
    inputSchema: {
      peer: z.string().describe("Peer name this identity authenticates"),
      auth_method: z
        .enum(["pre-shared-key", "rsa-signature", "digital-signature", "eap", "eap-radius"])
        .default("pre-shared-key")
        .describe("Authentication method"),
      secret: z.string().optional().describe("Pre-shared key secret"),
      my_id: z.string().optional(),
      remote_id: z.string().optional(),
      match_by: z
        .enum(["remote-id", "certificate"])
        .optional()
        .describe("How the remote peer is matched to this identity"),
      generate_policy: z.enum(["no", "port-override", "port-strict"]).optional(),
      mode_config: z.string().optional(),
      policy_template_group: z.string().optional(),
      certificate: z.string().optional(),
      remote_certificate: z
        .string()
        .optional()
        .describe("Remote peer's certificate name (rsa/digital-signature auth)"),
      eap_methods: z.string().optional().describe("EAP method(s), e.g. 'eap-tls' (eap auth)"),
      notrack_chain: z
        .string()
        .optional()
        .describe("Raw firewall chain to bypass connection tracking for matched traffic"),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Creating IPsec identity: peer=${a.peer}`);
      const cmd = new Cmd("/ip ipsec identity add")
        .set("peer", a.peer)
        .opt("auth-method", a.auth_method)
        .opt("secret", a.secret)
        .opt("my-id", a.my_id)
        .opt("remote-id", a.remote_id)
        .opt("match-by", a.match_by)
        .opt("generate-policy", a.generate_policy)
        .opt("mode-config", a.mode_config)
        .opt("policy-template-group", a.policy_template_group)
        .opt("certificate", a.certificate)
        .opt("remote-certificate", a.remote_certificate)
        .opt("eap-methods", a.eap_methods)
        .opt("notrack-chain", a.notrack_chain)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to create IPsec identity: ${result}`;

      const details = await executeMikrotikCommand(
        `/ip ipsec identity print detail where peer=${quoted(a.peer)}`,
        ctx,
      );
      return details.trim()
        ? `IPsec identity created successfully:\n\n${details}`
        : "IPsec identity created successfully.";
    },
  }),

  defineTool({
    name: "list_ipsec_identities",
    title: "List IPsec Identity (Auth) Bindings",
    annotations: READ,
    description:
      "Lists IPsec identity entries (`/ip ipsec identity print`) — the authentication" +
      " bindings that map peers to their credentials (PSK, certificate, EAP)." +
      " Use to find the internal `.id` needed by remove_ipsec_identity, or to audit which" +
      " auth method and secret each peer uses." +
      " For peer endpoint configuration use list_ipsec_peers; for phase-1 algorithm sets" +
      " use list_ipsec_profiles. Optionally filter by partial peer name via peer_filter." +
      " Returns a table of matching identities or 'No IPsec identities found.' if none exist.",
    inputSchema: {
      peer_filter: z.string().optional().describe("Partial peer name match"),
    },
    async handler(a, ctx) {
      ctx.info("Listing IPsec identities");
      const filters: string[] = [];
      if (a.peer_filter) filters.push(`peer~${quoted(a.peer_filter)}`);

      const result = await executeMikrotikCommand(
        `/ip ipsec identity print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result) ? "No IPsec identities found." : `IPSEC IDENTITIES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "remove_ipsec_identity",
    title: "Remove IPsec Identity (Auth Binding)",
    annotations: DESTRUCTIVE,
    description:
      "Removes an IPsec identity entry (`/ip ipsec identity remove`) by its internal `.id`" +
      " (e.g. '*1') obtained from list_ipsec_identities." +
      " Existence-checked before deletion — returns a not-found message if the ID is absent." +
      " Removing an identity leaves the peer entry intact but IKE negotiation will fail" +
      " without credentials; remove the peer afterwards with remove_ipsec_peer if needed." +
      " Identities have no update tool — to change credentials, remove and recreate via" +
      " create_ipsec_identity.",
    inputSchema: {
      identity_id: z.string().describe("Internal .id from list output, e.g. '*1'"),
    },
    async handler(a, ctx) {
      ctx.info(`Removing IPsec identity: identity_id=${a.identity_id}`);
      const count = await executeMikrotikCommand(
        `/ip ipsec identity print count-only where .id=${quoteValue(a.identity_id)}`,
        ctx,
      );
      if (count.trim() === "0") return `IPsec identity with ID '${a.identity_id}' not found.`;

      const result = await executeMikrotikCommand(
        `/ip ipsec identity remove [find .id=${quoteValue(a.identity_id)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove IPsec identity: ${result}`;
      return `IPsec identity '${a.identity_id}' removed successfully.`;
    },
  }),

  // ── Proposal (phase 2) — /ip ipsec proposal ───────────────────────────────
  defineTool({
    name: "create_ipsec_proposal",
    title: "Create IPsec Phase-2 Proposal",
    annotations: WRITE,
    description:
      "Creates an IPsec phase-2 proposal (`/ip ipsec proposal add`) — the named ESP/AH" +
      " algorithm set (auth, encryption, PFS group, SA lifetime) used by IPsec policies." +
      " A proposal defines WHAT transforms protect the data inside the tunnel; for IKE" +
      " algorithm settings (phase-1) use create_ipsec_profile instead." +
      " auth_algorithms e.g. 'sha256'; enc_algorithms e.g. 'aes-256-cbc'; pfs_group e.g." +
      " 'modp2048'; lifetime e.g. '30m'." +
      " Reference the proposal name in create_ipsec_policy via the proposal field." +
      " Returns the newly created proposal's detail on success.",
    inputSchema: {
      name: z.string().describe("Name for the new IPsec proposal"),
      auth_algorithms: z
        .string()
        .default("sha256")
        .describe("Authentication algorithms, e.g. 'sha256'"),
      enc_algorithms: z
        .string()
        .default("aes-256-cbc")
        .describe("Encryption algorithms, e.g. 'aes-256-cbc'"),
      pfs_group: z.string().default("modp2048").describe("PFS group, e.g. 'modp2048'"),
      lifetime: z.string().optional().describe("Phase-2 lifetime, e.g. '30m'"),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Creating IPsec proposal: name=${a.name}`);
      const cmd = new Cmd("/ip ipsec proposal add")
        .set("name", a.name)
        .opt("auth-algorithms", a.auth_algorithms)
        .opt("enc-algorithms", a.enc_algorithms)
        .opt("pfs-group", a.pfs_group)
        .opt("lifetime", a.lifetime)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to create IPsec proposal: ${result}`;

      const details = await executeMikrotikCommand(
        `/ip ipsec proposal print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return details.trim()
        ? `IPsec proposal created successfully:\n\n${details}`
        : "IPsec proposal created successfully.";
    },
  }),

  defineTool({
    name: "list_ipsec_proposals",
    title: "List IPsec Phase-2 Proposals",
    annotations: READ,
    description:
      "Lists IPsec phase-2 proposal entries (`/ip ipsec proposal print`) — the named ESP/AH" +
      " algorithm sets available for use by policies." +
      " Use to discover proposal names before referencing one in create_ipsec_policy." +
      " For IKE/phase-1 algorithm sets use list_ipsec_profiles; for traffic selectors" +
      " use list_ipsec_policies. Optionally filter by partial name via name_filter." +
      " Returns a table of matching proposals or 'No IPsec proposals found.' if none exist.",
    inputSchema: {
      name_filter: z.string().optional().describe("Partial name match"),
    },
    async handler(a, ctx) {
      ctx.info("Listing IPsec proposals");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~${quoted(a.name_filter)}`);

      const result = await executeMikrotikCommand(
        `/ip ipsec proposal print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result) ? "No IPsec proposals found." : `IPSEC PROPOSALS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_ipsec_proposal",
    title: "Get IPsec Phase-2 Proposal Details",
    annotations: READ,
    description:
      "Fetches full detail for a single IPsec phase-2 proposal (`/ip ipsec proposal print detail`)" +
      " by exact name. Use when you need the complete algorithm configuration of one proposal." +
      " For all proposals use list_ipsec_proposals; for phase-1 IKE profile detail use" +
      " get_ipsec_profile. Returns the full detail block or a not-found message.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Getting IPsec proposal details: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/ip ipsec proposal print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return isEmpty(result)
        ? `IPsec proposal '${a.name}' not found.`
        : `IPSEC PROPOSAL DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_ipsec_proposal",
    title: "Update IPsec Phase-2 Proposal",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Updates an existing IPsec phase-2 proposal (`/ip ipsec proposal set`) by name —" +
      " changes ESP/AH auth algorithms, encryption algorithms, PFS group, or SA lifetime" +
      " without recreating the proposal." +
      " For IKE/phase-1 algorithm changes use update_ipsec_profile." +
      " Supply only the fields to change; unchanged fields are left as-is." +
      " Returns the updated proposal detail on success.",
    inputSchema: {
      unset: unsetProperties,
      name: z.string().describe("Current name of the IPsec proposal to update"),
      new_name: z.string().optional(),
      auth_algorithms: z.string().optional(),
      enc_algorithms: z.string().optional(),
      pfs_group: z.string().optional(),
      lifetime: z.string().optional(),
      disabled: z.boolean().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Updating IPsec proposal: name=${a.name}`);
      const base = `/ip ipsec proposal set [find name=${quoted(a.name)}]`;
      const cmd = new Cmd(base)
        .opt("name", a.new_name)
        .opt("auth-algorithms", a.auth_algorithms)
        .opt("enc-algorithms", a.enc_algorithms)
        .opt("pfs-group", a.pfs_group)
        .opt("lifetime", a.lifetime)
        .bool("disabled", a.disabled)
        .unset(a.unset)
        .build();

      if (cmd === base) return "No updates specified.";

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to update IPsec proposal: ${result}`;

      const target = a.new_name ?? a.name;
      const details = await executeMikrotikCommand(
        `/ip ipsec proposal print detail where name=${quoted(target)}`,
        ctx,
      );
      return `IPsec proposal updated successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "remove_ipsec_proposal",
    title: "Remove IPsec Phase-2 Proposal",
    annotations: DESTRUCTIVE,
    description:
      "Removes an IPsec phase-2 proposal (`/ip ipsec proposal remove`) by exact name." +
      " Existence-checked before deletion — returns a not-found message if the proposal" +
      " does not exist rather than erroring. Removing a proposal referenced by active" +
      " policies will cause those policies to lose their SA parameters." +
      " For phase-1 profiles use remove_ipsec_profile; for peers use remove_ipsec_peer.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing IPsec proposal: name=${a.name}`);
      const count = await executeMikrotikCommand(
        `/ip ipsec proposal print count-only where name=${quoted(a.name)}`,
        ctx,
      );
      if (count.trim() === "0") return `IPsec proposal '${a.name}' not found.`;

      const result = await executeMikrotikCommand(
        `/ip ipsec proposal remove [find name=${quoted(a.name)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove IPsec proposal: ${result}`;
      return `IPsec proposal '${a.name}' removed successfully.`;
    },
  }),

  // ── Policy — /ip ipsec policy ─────────────────────────────────────────────
  defineTool({
    name: "create_ipsec_policy",
    title: "Create IPsec Traffic Policy",
    annotations: WRITE,
    description:
      "Creates an IPsec policy (`/ip ipsec policy add`) — the traffic selector that decides" +
      " which source/destination subnet pairs are encrypted, discarded, or passed through," +
      " and how (tunnel vs transport mode, which peer and proposal to use)." +
      " A policy is the glue between traffic and a configured peer+proposal; for the peer" +
      " endpoint use create_ipsec_peer, for ESP/AH algorithms use create_ipsec_proposal." +
      " action accepts 'encrypt' (default), 'discard', or 'none'; tunnel=true enables tunnel" +
      " mode (site-to-site VPN); set template=true for a policy template used with" +
      " generate_policy on the identity (road-warrior / dynamic-IP clients)." +
      " src_address and dst_address are CIDR subnets, e.g. '10.0.0.0/24'." +
      " Returns the full policy table detail after creation.",
    inputSchema: {
      peer: z.string().optional().describe("Peer name this policy applies to"),
      src_address: z.string().optional().describe("Source subnet, e.g. '10.0.0.0/24'"),
      src_port: z.number().int().optional().describe("Source port to match (0 = any)"),
      dst_address: z.string().optional().describe("Destination subnet, e.g. '10.0.1.0/24'"),
      dst_port: z.number().int().optional().describe("Destination port to match (0 = any)"),
      protocol: z.string().optional(),
      action: z.enum(["encrypt", "discard", "none"]).default("encrypt"),
      level: z.enum(["require", "unique", "use"]).optional(),
      proposal: z.string().optional().describe("Phase-2 proposal name"),
      tunnel: z.boolean().default(true).describe("Tunnel mode (vs transport)"),
      sa_src_address: z.string().optional(),
      sa_dst_address: z.string().optional(),
      priority: z.number().int().optional().describe("Policy ordering priority"),
      template: z.boolean().optional().describe("Policy template (for dynamic policies)"),
      group: z.string().optional().describe("Policy template group (when template=true)"),
      comment: z.string().optional(),
      disabled: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Creating IPsec policy: peer=${a.peer ?? "(none)"}`);
      const cmd = new Cmd("/ip ipsec policy add")
        .opt("peer", a.peer)
        .opt("src-address", a.src_address)
        .opt("src-port", a.src_port)
        .opt("dst-address", a.dst_address)
        .opt("dst-port", a.dst_port)
        .opt("protocol", a.protocol)
        .opt("action", a.action)
        .opt("level", a.level)
        .opt("proposal", a.proposal)
        .bool("tunnel", a.tunnel)
        .opt("sa-src-address", a.sa_src_address)
        .opt("sa-dst-address", a.sa_dst_address)
        .opt("priority", a.priority)
        .bool("template", a.template)
        .opt("group", a.group)
        .opt("comment", a.comment)
        .flag("disabled", a.disabled)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to create IPsec policy: ${result}`;

      const details = await executeMikrotikCommand("/ip ipsec policy print detail", ctx);
      return details.trim()
        ? `IPsec policy created successfully:\n\n${details}`
        : "IPsec policy created successfully.";
    },
  }),

  defineTool({
    name: "list_ipsec_policies",
    title: "List IPsec Traffic Policies",
    annotations: READ,
    description:
      "Lists all IPsec traffic policies (`/ip ipsec policy print`) — the traffic selectors" +
      " that control which subnet pairs are encrypted or discarded and via which peer/proposal." +
      " Use to find the internal `.id` needed by remove_ipsec_policy, or to audit which" +
      " traffic is encrypted. For peer endpoint entries use list_ipsec_peers; for phase-2" +
      " algorithm sets use list_ipsec_proposals; for live SA state use get_ipsec_installed_sa." +
      " Returns a table of all policies or 'No IPsec policies found.' if none exist.",
    async handler(_a, ctx) {
      ctx.info("Listing IPsec policies");
      const result = await executeMikrotikCommand("/ip ipsec policy print", ctx);
      return isEmpty(result) ? "No IPsec policies found." : `IPSEC POLICIES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "remove_ipsec_policy",
    title: "Remove IPsec Traffic Policy",
    annotations: DESTRUCTIVE,
    description:
      "Removes an IPsec traffic policy (`/ip ipsec policy remove`) by its internal `.id`" +
      " (e.g. '*1') obtained from list_ipsec_policies." +
      " Existence-checked before deletion — returns a not-found message if the ID is absent." +
      " Removing a policy stops encrypting or discarding the matched traffic immediately;" +
      " the corresponding peer and proposal entries remain and can be removed separately" +
      " via remove_ipsec_peer and remove_ipsec_proposal.",
    inputSchema: {
      policy_id: z.string().describe("Internal .id from list output, e.g. '*1'"),
    },
    async handler(a, ctx) {
      ctx.info(`Removing IPsec policy: policy_id=${a.policy_id}`);
      const count = await executeMikrotikCommand(
        `/ip ipsec policy print count-only where .id=${quoteValue(a.policy_id)}`,
        ctx,
      );
      if (count.trim() === "0") return `IPsec policy with ID '${a.policy_id}' not found.`;

      const result = await executeMikrotikCommand(
        `/ip ipsec policy remove [find .id=${quoteValue(a.policy_id)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove IPsec policy: ${result}`;
      return `IPsec policy '${a.policy_id}' removed successfully.`;
    },
  }),

  // ── Monitoring ────────────────────────────────────────────────────────────
  defineTool({
    name: "get_ipsec_active_peers",
    title: "Get IPsec Active Peers (Live Sessions)",
    annotations: READ,
    description:
      "Returns the live runtime table of established IKE sessions (`/ip ipsec active-peers print`)" +
      " — which peers are currently up, their uptime, local/remote addresses, and SA counts." +
      " Use to diagnose tunnel health or confirm a peer came up after configuration changes." +
      " This is read-only runtime state; for the static peer configuration use list_ipsec_peers." +
      " For the installed ESP/AH SAs (data-plane) use get_ipsec_installed_sa." +
      " Returns the active-peers table or 'No active IPsec peers.' if no tunnels are up.",
    async handler(_a, ctx) {
      ctx.info("Getting IPsec active peers");
      const result = await executeMikrotikCommand("/ip ipsec active-peers print", ctx);
      return isEmpty(result) ? "No active IPsec peers." : `IPSEC ACTIVE PEERS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_ipsec_installed_sa",
    title: "Get IPsec Installed Security Associations",
    annotations: READ,
    description:
      "Returns the live table of installed IPsec SAs (`/ip ipsec installed-sa print`) —" +
      " the kernel-level ESP/AH entries currently protecting data-plane traffic, including" +
      " SPI, cipher, lifetime remaining, and byte/packet counters." +
      " Use to confirm tunnel data-plane is active or to see which SAs will expire soon." +
      " For IKE control-plane sessions use get_ipsec_active_peers; for aggregate counters" +
      " use get_ipsec_statistics. To force renegotiation use flush_ipsec_installed_sa." +
      " Returns the installed-SA table or 'No installed IPsec SAs.' if none are present.",
    async handler(_a, ctx) {
      ctx.info("Getting IPsec installed SAs");
      const result = await executeMikrotikCommand("/ip ipsec installed-sa print", ctx);
      return isEmpty(result) ? "No installed IPsec SAs." : `IPSEC INSTALLED SAs:\n\n${result}`;
    },
  }),

  defineTool({
    name: "flush_ipsec_installed_sa",
    title: "Flush All IPsec Installed SAs (Force Rekey)",
    annotations: DESTRUCTIVE,
    description:
      "Flushes all installed IPsec SAs (`/ip ipsec installed-sa flush`) — removes every" +
      " kernel-level ESP/AH entry, forcing all active tunnels to immediately renegotiate" +
      " via IKE. Use to recover from stale or mismatched SAs after a proposal change, or" +
      " to trigger fresh key material without rebooting." +
      " This is disruptive — all tunnels drop momentarily until IKE re-establishes them." +
      " To inspect SAs before flushing use get_ipsec_installed_sa. To see if peers come" +
      " back up afterwards use get_ipsec_active_peers.",
    async handler(_a, ctx) {
      ctx.info("Flushing IPsec installed SAs");
      const result = await executeMikrotikCommand("/ip ipsec installed-sa flush", ctx);
      if (looksLikeError(result)) return `Failed to flush IPsec SAs: ${result}`;
      return "IPsec security associations flushed (tunnels will rekey).";
    },
  }),

  defineTool({
    name: "get_ipsec_statistics",
    title: "Get IPsec Subsystem Statistics",
    annotations: READ,
    description:
      "Returns aggregate IPsec subsystem counters (`/ip ipsec statistics print`) —" +
      " encrypted/decrypted packet and byte totals, error counts, and policy-match statistics." +
      " Use to spot packet-loss, replay errors, or policy mismatches at a global level." +
      " For per-SA byte/packet counters use get_ipsec_installed_sa; for live session" +
      " state use get_ipsec_active_peers." +
      " Returns the statistics block or 'No IPsec statistics available.' if the router" +
      " reports none.",
    async handler(_a, ctx) {
      ctx.info("Getting IPsec statistics");
      const result = await executeMikrotikCommand("/ip ipsec statistics print", ctx);
      return isEmpty(result) ? "No IPsec statistics available." : `IPSEC STATISTICS:\n\n${result}`;
    },
  }),
];
