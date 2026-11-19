# Changelog

Notable changes to `@usex/mikrotik-mcp`. Releases before 6.14.1 are described in
the GitHub release notes.

## 6.16.0 — unreleased

### Added

- **Alerts on Telegram and by email, and a daily digest.** Two new channels
  (`telegram`, `email` over SMTP) and one message a day that sums up the last
  24 hours. A password is never sent to a mail server over a clear connection.
- **Audit export to syslog or a SIEM.** `audit.syslog` sends every finished tool
  call as one RFC 5424 message, with secrets redacted. It works with the
  dashboard off.
- **Prometheus metrics.** The dashboard answers `GET /metrics`: router health
  and tool-call counters, read from memory only.
- **Git mirror for configuration snapshots.** `gitMirror` writes each snapshot
  as `<device>.rsc`, commits it and can push it. An unchanged router makes no
  commit.
- **Changes confirmed from the router's log.** After a tool that can change a
  router, the result shows what the router itself recorded in
  `/system history`, or that it recorded nothing. `verifyWrites` turns it off.
- **Syntax check before a command runs.** `validate_routeros_command` parses a
  command on the router without running it. `run_routeros_command` does the
  same first and refuses a command the router does not know.
- **Approvals.** With `approvals.enabled`, a risky tool call waits for a person
  on the Access page and runs only after it is approved. An approval is for one
  exact call, is used once, and expires.
- **Find devices that are not managed.** `discover_unmanaged_devices` reads the
  neighbour table of every router and lists what is attached and not in the
  device list.
- **SSH agent, secrets outside the config file, host-key pinning.** `sshAgent`,
  `passwordFrom` / `keyPassphraseFrom` (`env:NAME` or `file:/path`) and
  `hostKeySha256`.
- **Local firmware repository.** Download a RouterOS version once
  (`firmware_repo_fetch`), send the same files to every router over SFTP
  (`firmware_stage_from_repo`), and finish after the reboot
  (`firmware_post_upgrade`): version check, RouterBOOT, your own commands.
- **WireGuard users: free address, QR code, email, expiry.**
  `onboard_wireguard_user` picks a free address, can save a `.conf` and a QR
  PNG, can email the profile, and records an end date.
  `list_wireguard_users` and `expire_wireguard_users` are new.
- **Zone-based firewall.** `design_zone_firewall` builds interface lists and
  filter rules from zones and policies, in Safe Mode. `remove_zone_firewall`
  takes the design out.
- **IPv6 with a changing ISP prefix.** `follow_ipv6_prefix` keeps firewall
  address lists on the prefix the ISP delegates today.
- **Plan the move from `wireless` to `wifi`.**
  `plan_wireless_to_wifi_migration` translates every setting to its new name
  and lists what the new driver cannot do. Read-only.
- **Container lifecycle.** `get_container_logs`, `upgrade_container_image`
  (keeps the data in mounts) and `deploy_container_stack` (several containers
  from one description).
- **Hotspot voucher batches.** Vouchers belong to a batch; `print=true` writes
  a print-ready sheet with optional QR codes and a CSV file.
  `list_voucher_batches` and `remove_voucher_batch` are new.
- **Configuration templates.** Keep a configuration with `{{variable}}` places
  and apply it to a new router or to many with `apply_config_template`. Every
  command is parsed on the router first and written in Safe Mode.
- **Dashboard Files page.** The files of every router, as the Files window of
  WinBox, in dockable panes side by side.
  - Each pane shows one folder of one router, with the storage of the router,
    sorting, a name filter and multi-select.
  - Upload by dropping files from the computer on a pane or on a folder row.
    Download with a double-click or for a whole selection.
  - Copy files from one router to another by dragging them between panes. The
    server relays the copy over SFTP as one stream, so the routers do not need
    to reach each other and neither learns the other's credentials.
  - One transfer queue with progress, speed, time left, stop and try again.
    Three transfers run at the same time.
  - Search every open router at once: file names, or the text inside small text
    files, with an optional regular expression. A result opens its folder in
    the pane of its router.
  - Rename, new folder and delete (with confirmation). A name that already
    exists asks before it is replaced. A stopped or failed upload leaves no
    partial file on the router.
  - On by default, with no token and no loopback bind needed. Anyone who can
    open the dashboard can use it: set a dashboard token, or turn the page off,
    on a network you do not trust. A read-only server lists, searches and
    downloads only. Every operation reaches the audit feed as
    `dashboard_files`.
  - View and edit text files in the browser, with RouterOS colours for `.rsc`,
    and compare two files, also on two routers.
  - Whole folders: drop a folder to upload it, drag a folder to copy it, and
    download a selection as one ZIP archive.
  - Upload to all: one file to the same folder on every open router.
  - Compare folders: what two folders have and do not have, and copy what is
    missing.
  - A `.npk` for another architecture or RouterOS version is reported before
    the upload.
  - Backup now and Export now on the router, and Import of a `.rsc` file with
    a dry run first.
  - Direct copy: the destination router fetches a large file from the source
    by itself, with a fall back to the relayed copy.
  - SHA-256 for every relayed copy, Verify to read the copy back, and copies
    over 8 MiB that continue after a failure. A retried download continues at
    its offset.
  - Recycle bin: files the page deleted or replaced are kept on the server for
    7 days and can be put back.
  - Vault and S3: save router files to the backup vault (and the bucket), and
    send a vault file to a router.
  - Scheduled collection of matching router files into the vault, with a
    number of files to keep.
  - Storage analysis with the largest files and what is usually safe to remove.
  - A right-click menu on rows, folder bookmarks and saved workspaces.
  - Follow (live tail) for a file that grows.
- `dashboard.files` (`--dashboard-files`, `MIKROTIK_DASHBOARD__FILES`, default
  `true`) turns the page off or on. It is a switch in **Config → Dashboard**,
  and a change applies with no restart.
- **More metrics.** `/metrics` also carries interface counters, the load of
  each CPU core and SFP optical levels. They are read only when something
  scrapes, and a scrape never waits for a router.
- **Find a first router, and add it safely.** `discover_unmanaged_devices` can
  listen for MNDP on the MCP host and scan a subnet from a router.
  `enrol_device` adds a device and accepts only a secret reference, so a
  password never passes through the model.
- **Keyring secrets.** `keyring:service/account` reads the macOS Keychain or the
  Linux Secret Service.
- **Apply the `wireless` to `wifi` plan, and CAPsMAN.** The plan can be saved
  and applied after the package change, with passwords from secret references.
  It now covers a legacy CAPsMAN.
- **Sell a voucher to a billing system.** `POST /api/vouchers/issue` with its
  own token; a payment reference makes it safe to repeat.
  `protect_hotspot_login` rate-limits the hotspot login.
- **WireGuard Users page.** Add a user, scan its QR code, set an end date,
  revoke.

- **Start summary.** `serve` on an interactive terminal now prints, under the
  banner, where the server answers (the MCP endpoint and the dashboard, on
  each address of the machine for a wildcard bind) and a table of the
  routers: address, path (SSH, jump host or MAC-Telnet), online or offline,
  latency, identity, RouterOS version, board and uptime. It shows at any log
  level, and never prints a password or the dashboard token.

### Security

- **RouterOS command injection through tool arguments** (GHSA-63gj-jfjx-xf7g,
  GHSA-r4cq-vhjf-mppv, GHSA-2g58-43c8-4w2m, GHSA-p524-m32j-hf32). A tool
  argument was written into a device command without escaping, at about 800
  places. A value with a `"`, or a space and a `;`, ran as RouterOS commands
  on the router. READ tools did this too, so read-only mode and the READ risk
  ceiling did not hold. Every argument is now written with `quoted()` or
  `quoteValue()`, or checked when the console needs it bare (a duration, a
  menu path). A test calls every tool of the catalog with a hostile value in
  each free-text argument and reads the commands that reach the router.
- **READ tools that changed the router** (GHSA-p524-m32j-hf32).
  `firmware_check` no longer sets the update channel; use `firmware_stage`.
  `create_export`, `export_section`, `export_logs`, `export_dns_config` and
  `export_user_config` write a file on the router and are now WRITE tools, so
  a read-only server does not offer them.
- Log tools accept only a RouterOS time (`30m`, `1h`, `1d12h`) for
  `time_filter`, and a threat feed name must be a plain identifier.
- Dashboard routes send a sanitised, single-line error message.
- Three regular expressions that took quadratic time on hostile input are
  replaced, and two partial escapes are completed.
- Vulnerable packages are updated in the Raycast lockfile and the docs site.

### Changed

- **The Terminal page no longer needs a token or a loopback bind.** Like the
  Files page, it is on by default and is turned off or on with
  `dashboard.terminal`: a switch in **Config → Dashboard** (no restart) or
  `--dashboard-terminal`. Anyone who can open the dashboard can then run any
  command on the routers: set a dashboard token, or turn the page off, on a
  network you do not trust.
- **The default log level is `error`** (it was `info`). The server no longer
  writes its informational lines unless you ask for them. Set the level with
  `logLevel` in the config file, **Config → General → Log level** (applies at
  once), `--log-level` or `MIKROTIK_LOG_LEVEL`.
- The shared service and `docker-compose.yml` no longer set
  `MIKROTIK_LOG_LEVEL`, so the setting in the config is the one in use.

### Fixed

- `revoke_wireguard_user` quoted the user label twice, so a label with a space
  was never found.
- **Terminal:** an idle Shell pane closed after about one minute. The SSH
  library sent keepalive requests that RouterOS does not answer, and then
  closed the session. The shell now uses no SSH keepalive; its own 30-minute
  idle limit stays.

## 6.15.0

### Added

- **Dashboard Terminal page.** RouterOS consoles in dockable panes: split,
  resize, move, stack as tabs, float and maximise, with several panes per router
  and the layout restored after a reload.
  - Each command is a block with live output, a Stop button, copy output, copy
    command, run again, watch (run again every 5 s and mark changed lines) and
    add to favourites.
  - Each pane shows its connection state, the router identity, the transport,
    the round-trip latency with a sparkline, and command counts. A lost
    connection is retried with a growing delay.
  - Syntax highlighting with Shiki and a RouterOS TextMate grammar. The router
    also checks the input (`/console/inspect request=highlight`) and marks what
    it does not accept before the command runs. Tab completes from the router.
  - Completion opens while you type, and an earlier command that starts with
    the input is suggested inline (`→` accepts it).
  - Find bar (`Ctrl+F`): search one terminal or all terminals, with match case,
    whole words, regular expressions, a result counter, next/previous and a
    filter that hides blocks without a match.
  - Per-pane command time limit (30 s, 2 min, 10 min) and watch interval.
  - A pane keeps its last 40 blocks across a reload.
  - Interactive shell panes: a real RouterOS console over one SSH PTY
    (xterm.js), for menus, prompts and live monitors. Keys are not recorded.
  - Safe Mode from a pane: enable, commit, roll back.
  - Optional config snapshot before every command that is not a read, with a
    "what changed?" diff. A failed snapshot stops the command.
  - Snippets with `{{name}}` / `{{name=default}}` placeholders.
  - Table view of a `print` output; comparison of two outputs.
  - Script runner with a syntax check that runs nothing.
  - Inline help and completion descriptions from the router.
  - Broadcast groups with a result summary; named workspaces.
  - Alerts on a watched command; export of a pane or a block.
  - Right-click a pane tab to rename the pane or give it a colour.
  - Right-click a block for its actions. A new command scrolls to the end, and
    a button returns to the end after you scroll up.
  - Command palette (`Ctrl+Shift+P`), with `?` to ask in words (word matching
    over earlier commands, favourites and MCP tools; no language model).
  - Pipes on an output (`| grep`, `| count`, `| sort`, `| uniq`, `| head`,
    `| tail`); clickable IPv4 and MAC addresses.
  - Pinned blocks; a chart of a number of a watched command.
  - Undo for `enable`/`disable`, `disabled=yes/no` and a plain `add`.
  - Scheduled read commands, run by the server.
  - Shared read-only view of a router's commands.
  - Recording, playback and search of interactive shell sessions (output only).
  - Command history and favourites are saved on the server
    (`~/.mikrotik-mcp/terminal.db`). Any entry can be run again on any router.
  - Broadcast runs one command in every open pane.
  - Destructive commands (`remove`, `reboot`, `reset-configuration`, …) ask for
    confirmation. A read-only server runs only `print`, `export` and
    diagnostic commands.
  - Auto-retry sends a command again only when the router was not reached or
    the command only reads. A change that may already have run is not repeated.
  - Every command is written to the audit feed as `dashboard_terminal`.
- `dashboard.terminal` (`--dashboard-terminal`, `MIKROTIK_DASHBOARD__TERMINAL`,
  default `true`). The terminal is served only when the dashboard has a token or
  listens on loopback, because it runs any command on a router.

## 6.14.1 — 2026-11-17

### Fixed

- **Streamable HTTP: clients now recover after the server loses their session.**
  A request with an `Mcp-Session-Id` the server did not know (after a service
  restart, or after the session was closed) created a new, uninitialized
  transport and was answered with HTTP 400 `Server not initialized`. MCP clients
  such as `mcp-remote` initialize again only on HTTP 404, so the connector stayed
  broken until the host application was restarted. The server now answers
  HTTP 404 with JSON-RPC error `-32001` `Session not found`, and the client
  initializes again by itself.
- **Streamable HTTP: no server instance is leaked per stray request.** Each such
  request also built a full server instance that was never closed. A transport
  and server are now created only for an `initialize` POST without a session id.
  Any other request without a session id gets HTTP 400. A failed `initialize`,
  a closed transport and `DELETE /mcp` each close both the transport and its
  server.
- **Streamable HTTP: a localhost bind works without `--mcp-allowed-hosts`.** The
  built-in allow-list used `127.0.0.1:*`, but the Host header is compared
  exactly, so every request got HTTP 403 `Invalid Host header`. The allow-list
  now holds the real port.
- **SSH: no `MaxListenersExceededWarning` on a busy pooled connection.** Each
  command in flight added its own `error`, `end` and `close` listeners to the
  shared connection, so eight concurrent commands passed Node's limit of ten.
  All commands on a connection now share one set of listeners.

### Added

- `mcp.sessionIdleTimeout` (`--mcp-session-idle-timeout`,
  `MIKROTIK_MCP__SESSION_IDLE_TIMEOUT`): an HTTP session with no request for this
  many milliseconds is closed. Default: 24 hours. Every request resets it.
- One `INFO` log line for each session that is created, evicted or expired, with
  the session id and the reason.
