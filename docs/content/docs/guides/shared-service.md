---
title: Shared service deployment
description: Install once, share one server, and upgrade with one command on Windows, macOS and Linux.
---

Run one Bun server for Codex, Claude and your other MCP clients. Connection pools, schedules and history stay in one place. **No Docker, manual service files, or administrator password is needed.**

## Quick setup

Install [Bun 1.4.4 or newer](https://bun.sh/docs/installation), then run these commands in Terminal or Windows PowerShell:

```sh
bun add --global @usex/mikrotik-mcp@latest
mikrotik-mcp-service install
```

Open **[the dashboard](http://127.0.0.1:9090)** → **Devices**, edit the disabled example router with your address and credentials, then enable it and test the connection. You can also add more routers. The installer creates `~/.mikrotik-mcp/devices.json` only if it does not exist. The example stays disabled until you configure it; existing settings are preserved.

Already have a config? Use it directly:

```sh
mikrotik-mcp-service install --config "path/to/devices.json"
```

Relative paths are resolved before the service is registered. The service uses that file directly; it does not copy your credentials into a second config.

> The service commands are new source changes after 6.11.0. Until a package containing them is published, run `bun scripts/service.ts install` from this checkout. It installs the two commands into Bun's global bin directory and copies the manager outside the checkout. You can then use the commands normally, even after moving the checkout. The application itself uses the installed global package.

## Connect your AI apps once

Use **`http://127.0.0.1:8000/mcp`** as the Streamable HTTP MCP endpoint. The dashboard runs separately on **`http://127.0.0.1:9090`**.

Follow [Connecting clients](/docs/guides/connecting-clients) for your app. Select the HTTP setup rather than a configuration that launches another stdio server. The installer does not rewrite Codex or Claude settings.

Both listeners are local-only on a fresh installation. Remote access requires a deliberate authenticated, TLS-protected deployment; see [Security](/docs/guides/security).

## Upgrade in one command

```sh
mikrotik-mcp-upgrade
```

This installs the npm `latest` release with the service's Bun installation, validates the CLI, restarts the native service and checks that the running MCP reports the installed version. Config, SSH keys, history and client URLs stay unchanged. It does not upgrade Bun itself.

There is a brief connection interruption. You do not need to close Codex or Claude. If an app does not automatically renew its MCP session, use its **Reconnect** action.

Failed downloads or CLI validation do not trigger a restart. Readiness failure exits with an error rather than claiming success; there is no automatic package rollback. Concurrent service operations are blocked by a local lock.

## Everyday commands

| Command                          | Result                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------- |
| `mikrotik-mcp-service install`   | Install and start the service; reuse an existing managed installation.        |
| `mikrotik-mcp-upgrade`           | Install `latest`, restart and verify readiness.                               |
| `mikrotik-mcp-service restart`   | Restart without updating the package.                                         |
| `mikrotik-mcp-service status`    | Show native service status, config path and log location.                     |
| `mikrotik-mcp-service uninstall` | Remove automatic startup and stop the service; keep config, keys and history. |

To change an installed service's config or ports, uninstall its registration and install again with the new options. Your data is retained.

## What happens on each operating system

| System  | Managed registration                                                  | Startup behavior                                                                              |
| ------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| macOS   | `~/Library/LaunchAgents/dev.usestrict.mikrotik-mcp.plist`             | Starts at login; launchd restarts a stopped process.                                          |
| Linux   | User unit `mikrotik-mcp.service` in the systemd user config directory | Enabled for the current user's systemd session; restarts after process exit.                  |
| Windows | Task Scheduler task **MikroTik MCP**                                  | Starts at login as the current user, with limited privileges and restart-on-failure settings. |

These are **per-user services**, not machine-wide services. Windows requires an interactive login and the ScheduledTasks PowerShell module; organizational policy may prohibit task registration. Linux requires a working `systemctl --user` session. Non-systemd distributions and bare containers are not supported by this installer. To keep a Linux user service running after logout or before login, an administrator can separately enable systemd lingering; the installer does not change that policy.

An existing compatible macOS LaunchAgent with the same label is adopted without replacing its arguments, environment or log paths. Unmanaged Linux units and existing Windows tasks are not overwritten.

The service manager stores its own metadata in `~/.mikrotik-mcp/service/`. Do not delete that directory while the service is installed. Uninstall intentionally keeps the command launchers so reinstalling remains easy.

## Troubleshooting

### Command not found

Run `bun pm --global bin` and ensure the printed directory is on your PATH. Open a new terminal after installing Bun. From a checkout, `bun scripts/service.ts install` also works directly.

### Port already in use

Choose different ports during installation:

```sh
mikrotik-mcp-service install --mcp-port 8081 --dashboard-port 9091
```

Use the new MCP URL in your AI clients. The installer does not stop an unrelated process to reclaim a port.

### Service did not become ready

Run `mikrotik-mcp-service status`. On macOS, inspect the LaunchAgent's `StandardErrorPath` and `StandardOutPath` (new installations use `~/.mikrotik-mcp/service.stderr.log` and `service.stdout.log`). On Linux, use `journalctl --user -u mikrotik-mcp.service`. On Windows, inspect **Task Scheduler → MikroTik MCP → Last Run Result**, then run the displayed config with `mikrotik-mcp serve --config "path/to/devices.json"` in a terminal after stopping the task to see startup errors.

An interrupted installation can be retried with `install`; it reuses the saved service metadata. If the manager was forcibly killed, first make sure no other service operation is running, then remove the empty `~/.mikrotik-mcp/service/operation.lock` directory and retry.

## Service-manager references

The generated registrations follow [systemd service semantics](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html) and Microsoft's [current-user ScheduledTask principals](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtaskprincipal). Router commands still run through the MCP connector; these host commands only manage the MCP process.
