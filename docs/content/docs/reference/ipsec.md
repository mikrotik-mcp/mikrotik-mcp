---
title: "IPsec"
description: "IPsec IKEv1/IKEv2: profiles, peers, identities, proposals, policies, SAs (`/ip ipsec`)."
---

## Tools

- [Create IPsec Phase-1 Profile](#create_ipsec_profile)
- [List IPsec Phase-1 Profiles](#list_ipsec_profiles)
- [Get IPsec Phase-1 Profile Details](#get_ipsec_profile)
- [Update IPsec Phase-1 Profile](#update_ipsec_profile)
- [Remove IPsec Phase-1 Profile](#remove_ipsec_profile)
- [Create IPsec Peer Endpoint](#create_ipsec_peer)
- [List IPsec Peer Endpoints](#list_ipsec_peers)
- [Get IPsec Peer Endpoint Details](#get_ipsec_peer)
- [Update IPsec Peer Endpoint](#update_ipsec_peer)
- [Remove IPsec Peer Endpoint](#remove_ipsec_peer)
- [Create IPsec Identity (Auth Binding)](#create_ipsec_identity)
- [List IPsec Identity (Auth) Bindings](#list_ipsec_identities)
- [Remove IPsec Identity (Auth Binding)](#remove_ipsec_identity)
- [Create IPsec Phase-2 Proposal](#create_ipsec_proposal)
- [List IPsec Phase-2 Proposals](#list_ipsec_proposals)
- [Get IPsec Phase-2 Proposal Details](#get_ipsec_proposal)
- [Update IPsec Phase-2 Proposal](#update_ipsec_proposal)
- [Remove IPsec Phase-2 Proposal](#remove_ipsec_proposal)
- [Create IPsec Traffic Policy](#create_ipsec_policy)
- [List IPsec Traffic Policies](#list_ipsec_policies)
- [Remove IPsec Traffic Policy](#remove_ipsec_policy)
- [Get IPsec Active Peers (Live Sessions)](#get_ipsec_active_peers)
- [Get IPsec Installed Security Associations](#get_ipsec_installed_sa)
- [Flush All IPsec Installed SAs (Force Rekey)](#flush_ipsec_installed_sa)
- [Get IPsec Subsystem Statistics](#get_ipsec_statistics)

## create_ipsec_profile

**Create IPsec Phase-1 Profile** · Risk: **write**

Creates an IPsec phase-1 profile (`/ip ipsec profile add`) — the IKE algorithm set (DH group, encryption, hash, lifetime, NAT-T, DPD) shared by one or more peers. A profile governs IKE negotiation only; for the ESP/AH parameters negotiated inside the tunnel use create_ipsec_proposal, for the remote endpoint use create_ipsec_peer, and for the authentication credentials use create_ipsec_identity. Returns the newly created profile's detail print including its name.

| Parameter              | Required | Definition                                                                                               |
| ---------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `name`                 | Yes      | Name for the new IPsec profile `{"type":"string"}`                                                       |
| `dh_group`             | Yes      | Diffie-Hellman group, e.g. 'modp2048' `{"default":"modp2048","type":"string"}`                           |
| `enc_algorithm`        | No       | Encryption algorithm, e.g. 'aes-256' `{"type":"string"}`                                                 |
| `hash_algorithm`       | Yes      | Hash algorithm, e.g. 'sha256' `{"default":"sha256","type":"string"}`                                     |
| `prf_algorithm`        | No       | PRF algorithm, e.g. 'auto' or 'sha256' `{"type":"string"}`                                               |
| `lifetime`             | No       | Phase-1 lifetime, e.g. '1d' `{"type":"string"}`                                                          |
| `nat_traversal`        | No       | Enable NAT-T `{"type":"boolean"}`                                                                        |
| `dpd_interval`         | No       | Dead peer detection interval, e.g. '2m' `{"type":"string"}`                                              |
| `dpd_maximum_failures` | No       | DPD max failures before drop `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |

## list_ipsec_profiles

**List IPsec Phase-1 Profiles** · Risk: **read**

Lists IPsec phase-1 profiles (`/ip ipsec profile print`) — the named IKE algorithm sets configured on the device. Use to discover profile names before referencing one in create_ipsec_peer or update_ipsec_peer. For phase-2 algorithm sets use list_ipsec_proposals; for remote endpoints use list_ipsec_peers; for auth credentials use list_ipsec_identities; for traffic selectors use list_ipsec_policies. Returns a table of all matching profiles or 'No IPsec profiles found.' if none exist. Optionally filter by partial name match via name_filter.

| Parameter     | Required | Definition                             |
| ------------- | -------- | -------------------------------------- |
| `name_filter` | No       | Partial name match `{"type":"string"}` |

## get_ipsec_profile

**Get IPsec Phase-1 Profile Details** · Risk: **read**

Fetches full detail for a single IPsec phase-1 profile (`/ip ipsec profile print detail`) by exact name — use when you need the full algorithm and DPD configuration of one entry. For all profiles use list_ipsec_profiles; for phase-2 details use get_ipsec_proposal. Returns the full detail block or a not-found message.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## update_ipsec_profile

**Update IPsec Phase-1 Profile** · Risk: **write-idempotent**

Updates an existing IPsec phase-1 profile (`/ip ipsec profile set`) by name — changes IKE algorithm, lifetime, NAT-T, or DPD settings without recreating the profile. For phase-2 algorithm changes use update_ipsec_proposal; for peer endpoint changes use update_ipsec_peer. Supply only the fields to change; unchanged fields are left as-is. Returns the updated profile detail on success.

| Parameter              | Required | Definition                                                                  |
| ---------------------- | -------- | --------------------------------------------------------------------------- |
| `name`                 | Yes      | Current name of the IPsec profile to update `{"type":"string"}`             |
| `new_name`             | No       | `{"type":"string"}`                                                         |
| `dh_group`             | No       | `{"type":"string"}`                                                         |
| `enc_algorithm`        | No       | `{"type":"string"}`                                                         |
| `hash_algorithm`       | No       | `{"type":"string"}`                                                         |
| `prf_algorithm`        | No       | `{"type":"string"}`                                                         |
| `lifetime`             | No       | `{"type":"string"}`                                                         |
| `nat_traversal`        | No       | `{"type":"boolean"}`                                                        |
| `dpd_interval`         | No       | `{"type":"string"}`                                                         |
| `dpd_maximum_failures` | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |

## remove_ipsec_profile

**Remove IPsec Phase-1 Profile** · Risk: **destructive**

Removes an IPsec phase-1 profile (`/ip ipsec profile remove`) by exact name. Existence-checked before deletion — returns a not-found message if the profile does not exist rather than erroring. Removing a profile that is still referenced by active peers will cause those peers to lose their IKE algorithm configuration. For peers use remove_ipsec_peer; for proposals use remove_ipsec_proposal.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## create_ipsec_peer

**Create IPsec Peer Endpoint** · Risk: **write**

Creates an IPsec peer (`/ip ipsec peer add`) — the named remote-gateway entry that controls IKE exchange mode, remote address, and local source address. Use to define the far-end of a site-to-site VPN or a road-warrior responder (set address='0.0.0.0/0' and passive=true for responder-only). A peer defines WHO and HOW to reach; for the authentication credentials use create_ipsec_identity, for the IKE algorithm set use create_ipsec_profile, and for the traffic selector use create_ipsec_policy. exchange_mode accepts 'main', 'aggressive', or 'ike2' (default 'ike2'). Returns the newly created peer's full detail.

| Parameter              | Required | Definition                                                                                                             |
| ---------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `name`                 | Yes      | Name for the new IPsec peer `{"type":"string"}`                                                                        |
| `address`              | No       | Remote address, e.g. '203.0.113.1' or '0.0.0.0/0' for responder `{"type":"string"}`                                    |
| `profile`              | No       | Phase-1 profile name `{"type":"string"}`                                                                               |
| `exchange_mode`        | Yes      | IKE exchange mode `{"default":"ike2","type":"string","enum":["main","aggressive","ike2"]}`                             |
| `local_address`        | No       | `{"type":"string"}`                                                                                                    |
| `port`                 | No       | UDP port for IKE negotiation (default 500) `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `passive`              | No       | Passive (responder only) `{"type":"boolean"}`                                                                          |
| `send_initial_contact` | No       | `{"type":"boolean"}`                                                                                                   |
| `comment`              | No       | `{"type":"string"}`                                                                                                    |
| `disabled`             | Yes      | `{"default":false,"type":"boolean"}`                                                                                   |

## list_ipsec_peers

**List IPsec Peer Endpoints** · Risk: **read**

Lists configured IPsec peer entries (`/ip ipsec peer print`) — the static remote-gateway definitions, not live sessions. Use to find peer names before passing them to create_ipsec_identity, update_ipsec_peer, or remove_ipsec_peer. For live established IKE sessions use get_ipsec_active_peers instead. For phase-1 algorithm sets use list_ipsec_profiles; for auth bindings use list_ipsec_identities. Optionally filter by partial name via name_filter. Returns a table of matching peers or 'No IPsec peers found.' if none exist.

| Parameter     | Required | Definition                             |
| ------------- | -------- | -------------------------------------- |
| `name_filter` | No       | Partial name match `{"type":"string"}` |

## get_ipsec_peer

**Get IPsec Peer Endpoint Details** · Risk: **read**

Fetches full detail for a single configured IPsec peer (`/ip ipsec peer print detail`) by exact name. Use to inspect exchange mode, address, profile binding, and flags for one peer entry. For all peers use list_ipsec_peers; for live session status use get_ipsec_active_peers. Returns the full detail block or a not-found message.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## update_ipsec_peer

**Update IPsec Peer Endpoint** · Risk: **write-idempotent**

Updates an existing IPsec peer entry (`/ip ipsec peer set`) by name — changes remote address, exchange mode, profile, local address, or passive flag without removing and recreating the peer. For IKE algorithm changes use update_ipsec_profile; for auth credential changes use create_ipsec_identity or remove_ipsec_identity (identities have no update tool). Supply only the fields to change; unchanged fields are left as-is. Returns the updated peer detail on success.

| Parameter       | Required | Definition                                                                  |
| --------------- | -------- | --------------------------------------------------------------------------- |
| `name`          | Yes      | Current name of the IPsec peer to update `{"type":"string"}`                |
| `new_name`      | No       | `{"type":"string"}`                                                         |
| `address`       | No       | `{"type":"string"}`                                                         |
| `profile`       | No       | `{"type":"string"}`                                                         |
| `exchange_mode` | No       | `{"type":"string","enum":["main","aggressive","ike2"]}`                     |
| `local_address` | No       | `{"type":"string"}`                                                         |
| `port`          | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `passive`       | No       | `{"type":"boolean"}`                                                        |
| `comment`       | No       | `{"type":"string"}`                                                         |
| `disabled`      | No       | `{"type":"boolean"}`                                                        |

## remove_ipsec_peer

**Remove IPsec Peer Endpoint** · Risk: **destructive**

Removes an IPsec peer entry (`/ip ipsec peer remove`) by exact name. Existence-checked before deletion — returns a not-found message if the peer does not exist rather than erroring. Removing a peer tears down any active IKE session associated with it; associated identities and policies remain and should be cleaned up separately via remove_ipsec_identity and remove_ipsec_policy.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## create_ipsec_identity

**Create IPsec Identity (Auth Binding)** · Risk: **write**

Creates an IPsec identity (`/ip ipsec identity add`) — the authentication binding that ties a peer to its credentials (pre-shared key, RSA certificate, or EAP). An identity is mandatory alongside every peer before IKE negotiation can succeed. The peer field must match an existing peer name from list_ipsec_peers. auth_method accepts 'pre-shared-key' (default), 'rsa-signature', 'digital-signature', 'eap', or 'eap-radius'; supply secret for PSK, certificate for RSA/digital-signature. generate_policy ('port-override'/'port-strict') and mode_config enable dynamic policy creation for road-warrior/IKEv2 EAP clients. For the remote endpoint use create_ipsec_peer; for traffic selectors use create_ipsec_policy. Returns the identity detail for the peer on success.

| Parameter               | Required | Definition                                                                                                                                            |
| ----------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `peer`                  | Yes      | Peer name this identity authenticates `{"type":"string"}`                                                                                             |
| `auth_method`           | Yes      | Authentication method `{"default":"pre-shared-key","type":"string","enum":["pre-shared-key","rsa-signature","digital-signature","eap","eap-radius"]}` |
| `secret`                | No       | Pre-shared key secret `{"type":"string"}`                                                                                                             |
| `my_id`                 | No       | `{"type":"string"}`                                                                                                                                   |
| `remote_id`             | No       | `{"type":"string"}`                                                                                                                                   |
| `match_by`              | No       | How the remote peer is matched to this identity `{"type":"string","enum":["remote-id","certificate"]}`                                                |
| `generate_policy`       | No       | `{"type":"string","enum":["no","port-override","port-strict"]}`                                                                                       |
| `mode_config`           | No       | `{"type":"string"}`                                                                                                                                   |
| `policy_template_group` | No       | `{"type":"string"}`                                                                                                                                   |
| `certificate`           | No       | `{"type":"string"}`                                                                                                                                   |
| `remote_certificate`    | No       | Remote peer's certificate name (rsa/digital-signature auth) `{"type":"string"}`                                                                       |
| `eap_methods`           | No       | EAP method(s), e.g. 'eap-tls' (eap auth) `{"type":"string"}`                                                                                          |
| `notrack_chain`         | No       | Raw firewall chain to bypass connection tracking for matched traffic `{"type":"string"}`                                                              |
| `comment`               | No       | `{"type":"string"}`                                                                                                                                   |
| `disabled`              | Yes      | `{"default":false,"type":"boolean"}`                                                                                                                  |

## list_ipsec_identities

**List IPsec Identity (Auth) Bindings** · Risk: **read**

Lists IPsec identity entries (`/ip ipsec identity print`) — the authentication bindings that map peers to their credentials (PSK, certificate, EAP). Use to find the internal `.id` needed by remove_ipsec_identity, or to audit which auth method and secret each peer uses. For peer endpoint configuration use list_ipsec_peers; for phase-1 algorithm sets use list_ipsec_profiles. Optionally filter by partial peer name via peer_filter. Returns a table of matching identities or 'No IPsec identities found.' if none exist.

| Parameter     | Required | Definition                                  |
| ------------- | -------- | ------------------------------------------- |
| `peer_filter` | No       | Partial peer name match `{"type":"string"}` |

## remove_ipsec_identity

**Remove IPsec Identity (Auth Binding)** · Risk: **destructive**

Removes an IPsec identity entry (`/ip ipsec identity remove`) by its internal `.id` (e.g. '*1') obtained from list_ipsec_identities. Existence-checked before deletion — returns a not-found message if the ID is absent. Removing an identity leaves the peer entry intact but IKE negotiation will fail without credentials; remove the peer afterwards with remove_ipsec_peer if needed. Identities have no update tool — to change credentials, remove and recreate via create_ipsec_identity.

| Parameter     | Required | Definition                                                   |
| ------------- | -------- | ------------------------------------------------------------ |
| `identity_id` | Yes      | Internal .id from list output, e.g. '*1' `{"type":"string"}` |

## create_ipsec_proposal

**Create IPsec Phase-2 Proposal** · Risk: **write**

Creates an IPsec phase-2 proposal (`/ip ipsec proposal add`) — the named ESP/AH algorithm set (auth, encryption, PFS group, SA lifetime) used by IPsec policies. A proposal defines WHAT transforms protect the data inside the tunnel; for IKE algorithm settings (phase-1) use create_ipsec_profile instead. auth_algorithms e.g. 'sha256'; enc_algorithms e.g. 'aes-256-cbc'; pfs_group e.g. 'modp2048'; lifetime e.g. '30m'. Reference the proposal name in create_ipsec_policy via the proposal field. Returns the newly created proposal's detail on success.

| Parameter         | Required | Definition                                                                            |
| ----------------- | -------- | ------------------------------------------------------------------------------------- |
| `name`            | Yes      | Name for the new IPsec proposal `{"type":"string"}`                                   |
| `auth_algorithms` | Yes      | Authentication algorithms, e.g. 'sha256' `{"default":"sha256","type":"string"}`       |
| `enc_algorithms`  | Yes      | Encryption algorithms, e.g. 'aes-256-cbc' `{"default":"aes-256-cbc","type":"string"}` |
| `pfs_group`       | Yes      | PFS group, e.g. 'modp2048' `{"default":"modp2048","type":"string"}`                   |
| `lifetime`        | No       | Phase-2 lifetime, e.g. '30m' `{"type":"string"}`                                      |
| `disabled`        | Yes      | `{"default":false,"type":"boolean"}`                                                  |

## list_ipsec_proposals

**List IPsec Phase-2 Proposals** · Risk: **read**

Lists IPsec phase-2 proposal entries (`/ip ipsec proposal print`) — the named ESP/AH algorithm sets available for use by policies. Use to discover proposal names before referencing one in create_ipsec_policy. For IKE/phase-1 algorithm sets use list_ipsec_profiles; for traffic selectors use list_ipsec_policies. Optionally filter by partial name via name_filter. Returns a table of matching proposals or 'No IPsec proposals found.' if none exist.

| Parameter     | Required | Definition                             |
| ------------- | -------- | -------------------------------------- |
| `name_filter` | No       | Partial name match `{"type":"string"}` |

## get_ipsec_proposal

**Get IPsec Phase-2 Proposal Details** · Risk: **read**

Fetches full detail for a single IPsec phase-2 proposal (`/ip ipsec proposal print detail`) by exact name. Use when you need the complete algorithm configuration of one proposal. For all proposals use list_ipsec_proposals; for phase-1 IKE profile detail use get_ipsec_profile. Returns the full detail block or a not-found message.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## update_ipsec_proposal

**Update IPsec Phase-2 Proposal** · Risk: **write-idempotent**

Updates an existing IPsec phase-2 proposal (`/ip ipsec proposal set`) by name — changes ESP/AH auth algorithms, encryption algorithms, PFS group, or SA lifetime without recreating the proposal. For IKE/phase-1 algorithm changes use update_ipsec_profile. Supply only the fields to change; unchanged fields are left as-is. Returns the updated proposal detail on success.

| Parameter         | Required | Definition                                                       |
| ----------------- | -------- | ---------------------------------------------------------------- |
| `name`            | Yes      | Current name of the IPsec proposal to update `{"type":"string"}` |
| `new_name`        | No       | `{"type":"string"}`                                              |
| `auth_algorithms` | No       | `{"type":"string"}`                                              |
| `enc_algorithms`  | No       | `{"type":"string"}`                                              |
| `pfs_group`       | No       | `{"type":"string"}`                                              |
| `lifetime`        | No       | `{"type":"string"}`                                              |
| `disabled`        | No       | `{"type":"boolean"}`                                             |

## remove_ipsec_proposal

**Remove IPsec Phase-2 Proposal** · Risk: **destructive**

Removes an IPsec phase-2 proposal (`/ip ipsec proposal remove`) by exact name. Existence-checked before deletion — returns a not-found message if the proposal does not exist rather than erroring. Removing a proposal referenced by active policies will cause those policies to lose their SA parameters. For phase-1 profiles use remove_ipsec_profile; for peers use remove_ipsec_peer.

| Parameter | Required | Definition          |
| --------- | -------- | ------------------- |
| `name`    | Yes      | `{"type":"string"}` |

## create_ipsec_policy

**Create IPsec Traffic Policy** · Risk: **write**

Creates an IPsec policy (`/ip ipsec policy add`) — the traffic selector that decides which source/destination subnet pairs are encrypted, discarded, or passed through, and how (tunnel vs transport mode, which peer and proposal to use). A policy is the glue between traffic and a configured peer+proposal; for the peer endpoint use create_ipsec_peer, for ESP/AH algorithms use create_ipsec_proposal. action accepts 'encrypt' (default), 'discard', or 'none'; tunnel=true enables tunnel mode (site-to-site VPN); set template=true for a policy template used with generate_policy on the identity (road-warrior / dynamic-IP clients). src_address and dst_address are CIDR subnets, e.g. '10.0.0.0/24'. Returns the full policy table detail after creation.

| Parameter        | Required | Definition                                                                                                      |
| ---------------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| `peer`           | No       | Peer name this policy applies to `{"type":"string"}`                                                            |
| `src_address`    | No       | Source subnet, e.g. '10.0.0.0/24' `{"type":"string"}`                                                           |
| `src_port`       | No       | Source port to match (0 = any) `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`      |
| `dst_address`    | No       | Destination subnet, e.g. '10.0.1.0/24' `{"type":"string"}`                                                      |
| `dst_port`       | No       | Destination port to match (0 = any) `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `protocol`       | No       | `{"type":"string"}`                                                                                             |
| `action`         | Yes      | `{"default":"encrypt","type":"string","enum":["encrypt","discard","none"]}`                                     |
| `level`          | No       | `{"type":"string","enum":["require","unique","use"]}`                                                           |
| `proposal`       | No       | Phase-2 proposal name `{"type":"string"}`                                                                       |
| `tunnel`         | Yes      | Tunnel mode (vs transport) `{"default":true,"type":"boolean"}`                                                  |
| `sa_src_address` | No       | `{"type":"string"}`                                                                                             |
| `sa_dst_address` | No       | `{"type":"string"}`                                                                                             |
| `priority`       | No       | Policy ordering priority `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}`            |
| `template`       | No       | Policy template (for dynamic policies) `{"type":"boolean"}`                                                     |
| `group`          | No       | Policy template group (when template=true) `{"type":"string"}`                                                  |
| `comment`        | No       | `{"type":"string"}`                                                                                             |
| `disabled`       | Yes      | `{"default":false,"type":"boolean"}`                                                                            |

## list_ipsec_policies

**List IPsec Traffic Policies** · Risk: **read**

Lists all IPsec traffic policies (`/ip ipsec policy print`) — the traffic selectors that control which subnet pairs are encrypted or discarded and via which peer/proposal. Use to find the internal `.id` needed by remove_ipsec_policy, or to audit which traffic is encrypted. For peer endpoint entries use list_ipsec_peers; for phase-2 algorithm sets use list_ipsec_proposals; for live SA state use get_ipsec_installed_sa. Returns a table of all policies or 'No IPsec policies found.' if none exist.

No tool-specific parameters.

## remove_ipsec_policy

**Remove IPsec Traffic Policy** · Risk: **destructive**

Removes an IPsec traffic policy (`/ip ipsec policy remove`) by its internal `.id` (e.g. '*1') obtained from list_ipsec_policies. Existence-checked before deletion — returns a not-found message if the ID is absent. Removing a policy stops encrypting or discarding the matched traffic immediately; the corresponding peer and proposal entries remain and can be removed separately via remove_ipsec_peer and remove_ipsec_proposal.

| Parameter   | Required | Definition                                                   |
| ----------- | -------- | ------------------------------------------------------------ |
| `policy_id` | Yes      | Internal .id from list output, e.g. '*1' `{"type":"string"}` |

## get_ipsec_active_peers

**Get IPsec Active Peers (Live Sessions)** · Risk: **read**

Returns the live runtime table of established IKE sessions (`/ip ipsec active-peers print`) — which peers are currently up, their uptime, local/remote addresses, and SA counts. Use to diagnose tunnel health or confirm a peer came up after configuration changes. This is read-only runtime state; for the static peer configuration use list_ipsec_peers. For the installed ESP/AH SAs (data-plane) use get_ipsec_installed_sa. Returns the active-peers table or 'No active IPsec peers.' if no tunnels are up.

No tool-specific parameters.

## get_ipsec_installed_sa

**Get IPsec Installed Security Associations** · Risk: **read**

Returns the live table of installed IPsec SAs (`/ip ipsec installed-sa print`) — the kernel-level ESP/AH entries currently protecting data-plane traffic, including SPI, cipher, lifetime remaining, and byte/packet counters. Use to confirm tunnel data-plane is active or to see which SAs will expire soon. For IKE control-plane sessions use get_ipsec_active_peers; for aggregate counters use get_ipsec_statistics. To force renegotiation use flush_ipsec_installed_sa. Returns the installed-SA table or 'No installed IPsec SAs.' if none are present.

No tool-specific parameters.

## flush_ipsec_installed_sa

**Flush All IPsec Installed SAs (Force Rekey)** · Risk: **destructive**

Flushes all installed IPsec SAs (`/ip ipsec installed-sa flush`) — removes every kernel-level ESP/AH entry, forcing all active tunnels to immediately renegotiate via IKE. Use to recover from stale or mismatched SAs after a proposal change, or to trigger fresh key material without rebooting. This is disruptive — all tunnels drop momentarily until IKE re-establishes them. To inspect SAs before flushing use get_ipsec_installed_sa. To see if peers come back up afterwards use get_ipsec_active_peers.

No tool-specific parameters.

## get_ipsec_statistics

**Get IPsec Subsystem Statistics** · Risk: **read**

Returns aggregate IPsec subsystem counters (`/ip ipsec statistics print`) — encrypted/decrypted packet and byte totals, error counts, and policy-match statistics. Use to spot packet-loss, replay errors, or policy mismatches at a global level. For per-SA byte/packet counters use get_ipsec_installed_sa; for live session state use get_ipsec_active_peers. Returns the statistics block or 'No IPsec statistics available.' if the router reports none.

No tool-specific parameters.
