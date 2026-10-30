---
title: "Security Hardening"
description: "Granular audit+remediate pairs per risk category (firewall default-deny, address-list enforcement, kernel IP hardening, IPv6 baseline, SSH, IP service exposure, connection-tracking helpers, management-plane, account hygiene, certificate CRL, network segmentation, DNS resolver) plus an orchestrator (`run_security_hardening_audit` / `apply_security_hardening_fixes`) — every audit is read-only, every fix defaults to dry-run and snapshots + Safe-Modes before writing."
---

## Tools

- [Audit Firewall Default-Deny](#audit_firewall_default_deny)
- [Audit Address-List Enforcement](#audit_address_list_enforcement)
- [Audit Kernel IP Hardening](#audit_kernel_ip_hardening)
- [Audit IPv6 Firewall Baseline](#audit_ipv6_firewall_baseline)
- [Audit SSH Hardening](#audit_ssh_hardening)
- [Audit IP Service Exposure](#audit_ip_service_exposure)
- [Audit Connection-Tracking Helpers](#audit_connection_tracking_helpers)
- [Audit Management-Plane Exposure](#audit_management_plane_exposure)
- [Audit Account Hygiene](#audit_account_hygiene)
- [Audit Certificate Hygiene (CRL)](#audit_certificate_hygiene)
- [Audit Network Segmentation](#audit_network_segmentation)
- [Audit DNS Resolver Exposure](#audit_dns_resolver_exposure)
- [Add Firewall Default-Deny](#add_firewall_default_deny)
- [Enforce Address-List Blocking](#enforce_address_list_blocking)
- [Harden Kernel IP Settings](#harden_kernel_ip_settings)
- [Bootstrap IPv6 Firewall Baseline](#bootstrap_ipv6_firewall_baseline)
- [Harden SSH Service](#harden_ssh_service)
- [Harden IP Service Exposure](#harden_ip_service_exposure)
- [Harden Connection-Tracking Helpers](#harden_connection_tracking_helpers)
- [Harden Management-Plane Exposure](#harden_management_plane_exposure)
- [Fix Password Policy](#fix_password_policy)
- [Fix Certificate CRL Policy](#fix_certificate_crl_policy)
- [Harden DNS Resolver Exposure](#harden_dns_resolver_exposure)
- [Run Full Security Hardening Audit](#run_security_hardening_audit)
- [Apply Security Hardening Fixes](#apply_security_hardening_fixes)

## audit_firewall_default_deny

**Audit Firewall Default-Deny** · Risk: **read**

Read-only. Walks `/ip firewall filter` input and forward chains and reports whether each chain ends in an ENFORCED default-deny (a final unconditional drop/reject). Separately flags the field trap where an accept is followed by a matching drop that is disabled=yes — the chain looks protected but everything falls through (severity critical, its own finding_id). Remediate with add_firewall_default_deny.

No tool-specific parameters.

## audit_address_list_enforcement

**Audit Address-List Enforcement** · Risk: **read**

Read-only. Cross-references every address-list that is WRITTEN by an add-src/dst-to-address-list rule against every list READ by a drop/reject (or escalation) rule, across `/ip firewall filter` and `/ip firewall raw`. Flags lists that are populated but never blocked (the classic 'we detect scanners/DDoS but never drop them' gap). Correctly does NOT flag staged escalation ladders (stage1→stage2→stage3→blacklist) whose final list is enforced. Folds in a low-severity note when detection lives entirely in filter with nothing in raw. Remediate with enforce_address_list_blocking.

No tool-specific parameters.

## audit_kernel_ip_hardening

**Audit Kernel IP Hardening** · Risk: **read**

Read-only. Checks `/ip settings` (and `/ipv6 settings`) for tcp-syncookies, rp-filter (recommends strict on single-WAN, loose on multi-WAN — detected by counting default routes), accept-source-route, and accept-redirects. Remediate with harden_kernel_ip_settings.

No tool-specific parameters.

## audit_ipv6_firewall_baseline

**Audit IPv6 Firewall Baseline** · Risk: **read**

Read-only. When IPv6 is enabled and/or forwarding with no default-deny in `/ipv6 firewall filter`, surfaces the exposure as TWO mutually-exclusive remediation options (distinct finding_ids): Option A bootstrap a minimal safe IPv6 filter (accept established/related, keep RFC 4890 ICMPv6, default-deny); Option B disable IPv6 forwarding when no IPv6 address is in use. Marks needs_live_verification when zero IPv6 addresses are assigned (latent exposure). Apply exactly one option via bootstrap_ipv6_firewall_baseline.

No tool-specific parameters.

## audit_ssh_hardening

**Audit SSH Hardening** · Risk: **read**

Read-only. Checks `/ip ssh`: strong-crypto (auto-fixable), RSA host-key below 2048 bits and host-key-type (report-only recommendation to migrate to ed25519 — regeneration invalidates known_hosts, so never auto-applied), and always-allow-password-login. Remediate the auto-fixable parts with harden_ssh_service.

No tool-specific parameters.

## audit_ip_service_exposure

**Audit IP Service Exposure** · Risk: **read**

Read-only. For every enabled `/ip service` with address="" (unrestricted), checks whether an input firewall rule already scopes its port to trusted sources — if so it is NOT flagged (avoids the Winbox false positive). Always flags telnet if enabled (cleartext). Flags a 7.15+ reverse-proxy enabled with address="" and warns about multi-WAN reachability. Remediate with harden_ip_service_exposure.

No tool-specific parameters.

## audit_connection_tracking_helpers

**Audit Connection-Tracking Helpers** · Risk: **read**

Read-only. Flags enabled `/ip firewall service-port` helpers (h323, sip, pptp, irc, rtsp, udplite, dccp, sctp, tftp) with no corresponding active service (e.g. pptp helper on with no pptp-server/client). Most are needs_manual_review (static config can't fully prove non-use); pptp with no server/client is auto-fixable. Remediate with harden_connection_tracking_helpers.

No tool-specific parameters.

## audit_management_plane_exposure

**Audit Management-Plane Exposure** · Risk: **read**

Read-only. Bundles the smaller management-plane checks: mac-server / mac-winbox allowed-interface-list=all, bandwidth-server unrestricted, romon enabled, neighbor discovery scope, and default-named SNMP communities with open addresses. Most are report-only (the correct LAN interface-list is site-specific); bandwidth-server disable is auto-fixable. Remediate the auto-fixable parts with harden_management_plane_exposure.

No tool-specific parameters.

## audit_account_hygiene

**Audit Account Hygiene** · Risk: **read**

Read-only, audit-only by design. Checks `/user settings` password policy (minimum-password-length, minimum-categories), flags enabled accounts with obviously-temporary names (test/demo/temp/guest/admin) across /user, /ppp secret and /user-manager, and flags read-tier groups granted broad protocol access. Account deletion and group policy are manual decisions (needs_manual_review). The password-policy settings can be applied with the narrow fix_password_policy tool.

No tool-specific parameters.

## audit_certificate_hygiene

**Audit Certificate Hygiene (CRL)** · Risk: **read**

Read-only. Adds the CRL-policy check that cert_expiry_audit does not cover: flags `/certificate settings` crl-use=no / crl-download=no when certificate-based services (OpenVPN with client/server cert verification, SSTP with a certificate) are in active use. Remediate with fix_certificate_crl_policy.

No tool-specific parameters.

## audit_network_segmentation

**Audit Network Segmentation** · Risk: **read**

Read-only, report-only (no fix — this is architecture, not a bug). Flags a single PHYSICAL interface carrying multiple non-overlapping subnets where one is a DHCP client pool and another hosts server-like (NAT-target) addresses — a proxy for 'servers and clients share one L2 domain with no VLAN isolation'. Reports the topology fact as proven and the isolation-absence claim as needs_live_verification, and includes a concrete suggested VLAN plan. Never auto-applied.

No tool-specific parameters.

## audit_dns_resolver_exposure

**Audit DNS Resolver Exposure** · Risk: **read**

Read-only. Flags `/ip dns allow-remote-requests=yes` when port 53 is not restricted to trusted sources on BOTH TCP and UDP by an input firewall rule (catches the field trap where a rule covers only one transport). Remediate with harden_dns_resolver_exposure.

No tool-specific parameters.

## add_firewall_default_deny

**Add Firewall Default-Deny** · Risk: **dangerous**

Applies default-deny remediations by finding_id from a prior audit_firewall_default_deny run: inserts the canonical safe tail (accept established/related/untracked → drop invalid → final unconditional drop), and/or re-enables a specific disabled catch-all drop (a separate finding_id, since re-enabling a deliberately-disabled rule is a different risk than inserting a new tail). DRY RUN unless confirm=true. Snapshots first and runs inside Safe Mode (auto-revert on lockout). Idempotent: a re-run finds nothing to add.

| Parameter     | Required | Definition                                                                                                                                  |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `finding_ids` | Yes      | Specific finding_id(s) from a prior audit_firewall_default_deny run to remediate. `{"minItems":1,"type":"array","items":{"type":"string"}}` |
| `confirm`     | Yes      | Must be true to write. false (default) returns a dry-run preview and changes nothing. `{"default":false,"type":"boolean"}`                  |

## enforce_address_list_blocking

**Enforce Address-List Blocking** · Risk: **dangerous**

For each unenforced-list finding_id from a prior audit_address_list_enforcement run, inserts a drop rule matching that list (src- or dst- as appropriate) positioned before the chain's default-deny tail. DRY RUN unless confirm=true. Snapshots first and runs inside Safe Mode.

| Parameter     | Required | Definition                                                                                                                                     |
| ------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `finding_ids` | Yes      | Specific finding_id(s) from a prior audit_address_list_enforcement run to remediate. `{"minItems":1,"type":"array","items":{"type":"string"}}` |
| `confirm`     | Yes      | Must be true to write. false (default) returns a dry-run preview and changes nothing. `{"default":false,"type":"boolean"}`                     |

## harden_kernel_ip_settings

**Harden Kernel IP Settings** · Risk: **write-idempotent**

Applies `/ip settings set` (and `/ipv6 settings set`) corrections for the kernel-hardening finding_ids from a prior audit_kernel_ip_hardening run. DRY RUN unless confirm=true. Snapshots first.

| Parameter     | Required | Definition                                                                                                                                |
| ------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `finding_ids` | Yes      | Specific finding_id(s) from a prior audit_kernel_ip_hardening run to remediate. `{"minItems":1,"type":"array","items":{"type":"string"}}` |
| `confirm`     | Yes      | Must be true to write. false (default) returns a dry-run preview and changes nothing. `{"default":false,"type":"boolean"}`                |

## bootstrap_ipv6_firewall_baseline

**Bootstrap IPv6 Firewall Baseline** · Risk: **dangerous**

Applies ONE of the two mutually-exclusive IPv6 baseline finding_ids from a prior audit_ipv6_firewall_baseline run (bootstrap filter, or disable forwarding). Pass exactly one option's finding_id. DRY RUN unless confirm=true. Snapshots first and runs inside Safe Mode.

| Parameter     | Required | Definition                                                                                                                                   |
| ------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `finding_ids` | Yes      | Specific finding_id(s) from a prior audit_ipv6_firewall_baseline run to remediate. `{"minItems":1,"type":"array","items":{"type":"string"}}` |
| `confirm`     | Yes      | Must be true to write. false (default) returns a dry-run preview and changes nothing. `{"default":false,"type":"boolean"}`                   |

## harden_ssh_service

**Harden SSH Service** · Risk: **dangerous**

Applies the auto-fixable SSH finding_ids from a prior audit_ssh_hardening run (currently strong-crypto=yes). Host-key regeneration is NEVER auto-applied (report-only). DRY RUN unless confirm=true. Snapshots first and runs inside Safe Mode.

| Parameter     | Required | Definition                                                                                                                          |
| ------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `finding_ids` | Yes      | Specific finding_id(s) from a prior audit_ssh_hardening run to remediate. `{"minItems":1,"type":"array","items":{"type":"string"}}` |
| `confirm`     | Yes      | Must be true to write. false (default) returns a dry-run preview and changes nothing. `{"default":false,"type":"boolean"}`          |

## harden_ip_service_exposure

**Harden IP Service Exposure** · Risk: **dangerous**

For the service-exposure finding_ids from a prior audit_ip_service_exposure run, restricts the service address or disables it (telnet/reverse-proxy default to disable). DRY RUN unless confirm=true. Snapshots first and runs inside Safe Mode.

| Parameter     | Required | Definition                                                                                                                                |
| ------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `finding_ids` | Yes      | Specific finding_id(s) from a prior audit_ip_service_exposure run to remediate. `{"minItems":1,"type":"array","items":{"type":"string"}}` |
| `confirm`     | Yes      | Must be true to write. false (default) returns a dry-run preview and changes nothing. `{"default":false,"type":"boolean"}`                |

## harden_connection_tracking_helpers

**Harden Connection-Tracking Helpers** · Risk: **write-idempotent**

Disables the auto-fixable helper finding_ids from a prior audit_connection_tracking_helpers run, one at a time. DRY RUN unless confirm=true. Snapshots first.

| Parameter     | Required | Definition                                                                                                                                        |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `finding_ids` | Yes      | Specific finding_id(s) from a prior audit_connection_tracking_helpers run to remediate. `{"minItems":1,"type":"array","items":{"type":"string"}}` |
| `confirm`     | Yes      | Must be true to write. false (default) returns a dry-run preview and changes nothing. `{"default":false,"type":"boolean"}`                        |

## harden_management_plane_exposure

**Harden Management-Plane Exposure** · Risk: **write-idempotent**

Applies the auto-fixable management-plane finding_ids from a prior audit run (e.g. disabling an unused bandwidth-server). Site-specific restrictions remain report-only. DRY RUN unless confirm=true. Snapshots first.

| Parameter     | Required | Definition                                                                                                                                      |
| ------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `finding_ids` | Yes      | Specific finding_id(s) from a prior audit_management_plane_exposure run to remediate. `{"minItems":1,"type":"array","items":{"type":"string"}}` |
| `confirm`     | Yes      | Must be true to write. false (default) returns a dry-run preview and changes nothing. `{"default":false,"type":"boolean"}`                      |

## fix_password_policy

**Fix Password Policy** · Risk: **write-idempotent**

Narrow companion to audit_account_hygiene: applies ONLY the `/user settings` password-policy finding_ids (minimum-password-length, minimum-categories). Touches nothing else — account deletion and group policy are never automated. DRY RUN unless confirm=true. Snapshots first.

| Parameter     | Required | Definition                                                                                                                            |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `finding_ids` | Yes      | Specific finding_id(s) from a prior audit_account_hygiene run to remediate. `{"minItems":1,"type":"array","items":{"type":"string"}}` |
| `confirm`     | Yes      | Must be true to write. false (default) returns a dry-run preview and changes nothing. `{"default":false,"type":"boolean"}`            |

## fix_certificate_crl_policy

**Fix Certificate CRL Policy** · Risk: **write-idempotent**

Sets crl-use=yes / crl-download=yes for the certificate finding_id from a prior audit_certificate_hygiene run. Note: CRL download needs outbound reachability to the CRL distribution point (may need a firewall allowance). DRY RUN unless confirm=true. Snapshots first.

| Parameter     | Required | Definition                                                                                                                                |
| ------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `finding_ids` | Yes      | Specific finding_id(s) from a prior audit_certificate_hygiene run to remediate. `{"minItems":1,"type":"array","items":{"type":"string"}}` |
| `confirm`     | Yes      | Must be true to write. false (default) returns a dry-run preview and changes nothing. `{"default":false,"type":"boolean"}`                |

## harden_dns_resolver_exposure

**Harden DNS Resolver Exposure** · Risk: **dangerous**

For the DNS finding_id from a prior audit_dns_resolver_exposure run, either restricts input port 53 (TCP+UDP) or disables allow-remote-requests (when the resolver only serves the router's own DHCP clients). DRY RUN unless confirm=true. Snapshots first and runs inside Safe Mode.

| Parameter     | Required | Definition                                                                                                                                  |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `finding_ids` | Yes      | Specific finding_id(s) from a prior audit_dns_resolver_exposure run to remediate. `{"minItems":1,"type":"array","items":{"type":"string"}}` |
| `confirm`     | Yes      | Must be true to write. false (default) returns a dry-run preview and changes nothing. `{"default":false,"type":"boolean"}`                  |

## run_security_hardening_audit

**Run Full Security Hardening Audit** · Risk: **read**

Runs EVERY security-hardening category against the device in one pass (firewall default-deny, address-list enforcement, kernel IP hardening, IPv6 baseline, SSH, IP service exposure, connection-tracking helpers, management-plane exposure, account hygiene, certificate CRL policy, network segmentation, DNS resolver exposure) and returns a single severity-ranked report. Every finding carries a stable finding_id, category, severity, confidence (proven vs needs_live_verification) and — where safe — an automated fix. Pure read, no confirm needed. Feed the finding_ids you choose into apply_security_hardening_fixes. Narrow to one category with the audit_* tools; for the broader firewall analysis use firewall_audit, and for the scored compliance grade use run_compliance_audit.

| Parameter    | Required | Definition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `categories` | No       | Narrow to specific categories. Available: firewall_default_deny, address_list_enforcement, kernel_ip_hardening, ipv6_firewall_baseline, ssh_hardening, ip_service_exposure, connection_tracking_helpers, management_plane_exposure, account_hygiene, certificate_hygiene, network_segmentation, dns_resolver_exposure. Omit for all. `{"type":"array","items":{"type":"string","enum":["firewall_default_deny","address_list_enforcement","kernel_ip_hardening","ipv6_firewall_baseline","ssh_hardening","ip_service_exposure","connection_tracking_helpers","management_plane_exposure","account_hygiene","certificate_hygiene","network_segmentation","dns_resolver_exposure"]}}` |

## apply_security_hardening_fixes

**Apply Security Hardening Fixes** · Risk: **dangerous**

Applies specific finding_ids from a prior run_security_hardening_audit, dispatching each to its category's remediation in a SAFE ORDER (firewall default-deny and address-list enforcement before service-exposure before helper/hygiene), all wrapped in ONE Safe-Mode session with ONE pre-change snapshot. Returns a per-finding success/failure result plus the snapshot id (roll back with diff_config_snapshots). DRY RUN unless confirm=true. NEVER accepts a blanket 'fix everything' flag — you must pass explicit finding_ids sourced from an audit.

| Parameter     | Required | Definition                                                                                                                                    |
| ------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `finding_ids` | Yes      | Explicit finding_id(s) from a prior run_security_hardening_audit. No blanket apply. `{"minItems":1,"type":"array","items":{"type":"string"}}` |
| `confirm`     | Yes      | Must be true to write. false (default) returns a dry-run preview and changes nothing. `{"default":false,"type":"boolean"}`                    |
