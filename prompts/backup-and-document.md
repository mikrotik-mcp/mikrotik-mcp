---
name: backup-and-document
title: Back up and document the configuration
description: Create a safe restore point and produce a human-readable inventory of the router's configuration.
arguments: []
---

Create a restore point for this MikroTik device and then write up a clear,
human-readable summary of how it's configured. This is read-mostly: the only
change is creating a backup/export.

1. **Local snapshot (zero device footprint)** — `capture_config_snapshot` first.
   This stores a text `/export` in the MCP host's local database — no file is
   written on the router's flash. Give it a descriptive `label` (e.g. `pre-audit`).
2. **Device restore point** — `create_backup` (binary, for full restore) and
   `create_export` (text `.rsc`, for review/diff). List them with `list_backups`.
3. **The write-up** — call `explain_device`. It analyses the configuration on the
   MCP host and returns a finished architecture document: inferred role with the
   signals behind it, topology with a Mermaid diagram, addressing and DHCP
   scopes, the internet path, what each firewall chain does, what is exposed to
   the internet, tunnels, management services, and an explicit list of anything
   it did not recognise.

   Do **not** pull `/export` into the conversation to write this by hand. The
   tool's output is a fraction of the size, already analysed, and identical
   across runs — which is what lets `diff_explanations` compare two dates later.
   Use `explain_section` when the user asks about one area rather than the whole
   router.

4. **Fill the gaps `explain_device` deliberately leaves.** A configuration export
   describes what is _defined_, never what is _running_, so add the live facts it
   cannot know:
   - `get_system_resources`, `get_routerboard`, `get_installed_packages` — uptime,
     hardware, what is actually installed.
   - `list_certificates` — flag anything expiring within 30 days.
   - `get_wireguard_status`, `list_ipsec_active_peers` — which tunnels are up
     right now, as opposed to merely configured.
   - `list_schedulers`, `list_scripts` — scheduled automation.
5. **Things worth reviewing** — run `firewall_audit` and
   `run_security_hardening_audit` and summarise their findings rather than
   re-deriving them by eye. Read the narrative's "what this document does not
   cover" section aloud to the user: that is the part nobody understood, and it
   is where the surprises live.

Present the narrative first, then the live facts, then the review section.
Reference the snapshot id and backup/export filenames you created so the user
knows their restore points.
