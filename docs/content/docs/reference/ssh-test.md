---
title: "SSH Connectivity Tests"
description: "Test SSH from the MCP host to a configured device or any host, and outbound SSH from a device (`test_ssh_to_device` / `test_ssh_to_host` / `test_ssh_from_device`)."
---

## Tools

- [Test SSH to a Configured Device (from the MCP host)](#test_ssh_to_device)
- [Test SSH to Any Host (from the MCP host)](#test_ssh_to_host)
- [Test SSH Outbound From a RouterOS Device](#test_ssh_from_device)

## test_ssh_to_device

**Test SSH to a Configured Device (from the MCP host)** · Risk: **read**

Tests the SSH connection FROM THE MACHINE RUNNING THIS MCP SERVER to a CONFIGURED device, using that device's stored host/port/credentials. Use this to diagnose why a saved device is not responding — it confirms whether the MCP host can reach the device's SSH port AND authenticate, and reports the connect latency and identity. Targets the selected/default device (the `device` selector). NOTE: this opens a real SSH connection from the MCP host, not through the usual command channel, and is SSH-only (a MAC-Telnet device has no SSH). To test an UNSAVED host with ad-hoc credentials use test_ssh_to_host; to test SSH OUTBOUND from a router use test_ssh_from_device. Returns OK/failed with the reason.

No tool-specific parameters.

## test_ssh_to_host

**Test SSH to Any Host (from the MCP host)** · Risk: **read**

Tests an SSH connection FROM THE MACHINE RUNNING THIS MCP SERVER to an ARBITRARY host:port with the supplied credentials — a pre-flight check BEFORE adding a device to the config, or to verify reachability/credentials for any SSH host. Confirms TCP reachability AND authentication and reports the connect latency. Provide a `password` and/or a private-key path (`key_path`). NOTE: this opens a real SSH connection from the MCP host. For a device that is ALREADY configured use test_ssh_to_device; to test SSH outbound FROM a router use test_ssh_from_device. Returns OK/failed with the reason.

| Parameter        | Required | Definition                                                                                                                 |
| ---------------- | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| `host`           | Yes      | Target IP or hostname `{"type":"string"}`                                                                                  |
| `port`           | Yes      | `{"default":22,"type":"integer","minimum":1,"maximum":65535}`                                                              |
| `username`       | Yes      | `{"type":"string"}`                                                                                                        |
| `password`       | No       | Password auth (omit if using a key) `{"type":"string"}`                                                                    |
| `key_path`       | No       | Path (on the MCP host) to a private key file `{"type":"string"}`                                                           |
| `key_passphrase` | No       | `{"type":"string"}`                                                                                                        |
| `command`        | Yes      | Command to run once connected (a harmless RouterOS read by default) `{"default":"/system identity print","type":"string"}` |

## test_ssh_from_device

**Test SSH Outbound From a RouterOS Device** · Risk: **write**

Tests SSH OUTBOUND FROM a RouterOS device to a remote host using the device's OWN SSH client (`/system ssh-exec`) — i.e. the connection is made BY the router, not by the MCP host. Use this to check whether a router can reach and log into another host over SSH (e.g. a jump path or another router). The router's user must be able to authenticate to the target NON-interactively (a stored key on the router) — a password-only target will prompt and time out. Runs the test `command` on the remote and returns its output. To test the MCP HOST's connection to a device instead, use test_ssh_to_device (configured) or test_ssh_to_host (ad-hoc). Returns the remote command output or the device's error.

| Parameter | Required | Definition                                                                                                        |
| --------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `host`    | Yes      | Remote host the ROUTER should SSH to `{"type":"string"}`                                                          |
| `port`    | Yes      | `{"default":22,"type":"integer","minimum":1,"maximum":65535}`                                                     |
| `user`    | Yes      | Username on the remote host `{"type":"string"}`                                                                   |
| `command` | Yes      | Command to run on the remote host as the connectivity test `{"default":"/system identity print","type":"string"}` |
