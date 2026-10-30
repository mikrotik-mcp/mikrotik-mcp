---
title: "SSH Server"
description: "SSH server settings (`/ip ssh`) — TCP forwarding (jump-host/ProxyJump), crypto strength, password-vs-key policy, host-key regenerate/import/export."
---

## Tools

- [Get SSH Server Settings](#get_ssh_settings)
- [Configure SSH Server Settings](#set_ssh_settings)
- [Regenerate SSH Host Key](#regenerate_ssh_host_key)
- [Export SSH Host Public Key](#export_ssh_host_key)
- [Import SSH Host Key](#import_ssh_host_key)

## get_ssh_settings

**Get SSH Server Settings** · Risk: **read**

Show the RouterOS SSH **server** configuration (`/ip ssh print`) — TCP forwarding policy (`forwarding-enabled`), crypto strength (`strong-crypto`, `allow-none-crypto`), password-vs-key policy (`always-allow-password-login`), and the host key (`host-key-type`, `host-key-size`). This is the SSH SERVER's behaviour, separate from `/ip service ssh` (which only sets the SSH port and source-address ACL — see get_ip_service). Use this to check, for example, whether a router can act as an SSH jump host (`forwarding-enabled` must be `local` or `both`).

No tool-specific parameters.

## set_ssh_settings

**Configure SSH Server Settings** · Risk: **write-idempotent**

Update the RouterOS SSH **server** settings (`/ip ssh set`). Covers every option of the `/ip ssh` submenu — pass only what you want to change:
• `forwarding_enabled` — TCP forwarding policy: `no` | `local` | `remote` | `both`. **Set to `local` (or `both`) to let this router act as an SSH jump host / bastion** for ProxyJump (`jumpVia`); `remote` allows reverse forwarding.
• `strong_crypto` — use stronger crypto: prefer 256-bit+ ciphers, bigger DH primes, stronger HMACs, and disable weak/legacy algorithms (recommended for hardening).
• `always_allow_password_login` — allow password auth even when the user has an SSH public key set.
• `allow_none_crypto` — allow connecting with NO encryption (insecure; almost always keep off).
• `host_key_type` — host key algorithm: `rsa` or `ed25519`. Changing it regenerates the host key, so existing clients will see a changed key and must re-trust it.
• `host_key_size` — RSA host-key size in bits (e.g. 2048 or 4096); applies to `rsa` host keys.
Note: this is NOT the SSH port/ACL — for that use set_ip_service on the `ssh` service.

| Parameter                     | Required | Definition                                                                                                                                      |
| ----------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `forwarding_enabled`          | No       | TCP forwarding policy. `local`/`both` are required for this router to be a jump host. `{"type":"string","enum":["no","local","remote","both"]}` |
| `strong_crypto`               | No       | Prefer strong ciphers/MACs/DH and disable weak ones (hardening). `{"type":"boolean"}`                                                           |
| `always_allow_password_login` | No       | Allow password login even when the user has an SSH public key configured. `{"type":"boolean"}`                                                  |
| `allow_none_crypto`           | No       | Allow unencrypted connections (insecure — keep off unless you must). `{"type":"boolean"}`                                                       |
| `host_key_type`               | No       | Host key algorithm. Changing it regenerates the host key (clients must re-trust). `{"type":"string","enum":["rsa","ed25519"]}`                  |
| `host_key_size`               | No       | RSA host-key size in bits (e.g. 2048, 4096). Applies to rsa host keys. `{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991}`     |

## regenerate_ssh_host_key

**Regenerate SSH Host Key** · Risk: **dangerous**

Regenerate the router's SSH host key (`/ip ssh regenerate-host-key`), using the current `host-key-type`/`host-key-size`. WARNING: this changes the server's identity — EVERY existing SSH client will get a host-key-mismatch warning and must re-trust the router (remove its old entry from `~/.ssh/known_hosts`). Do this only when rotating keys or after changing `host_key_type`. It does not drop the current session.

No tool-specific parameters.

## export_ssh_host_key

**Export SSH Host Public Key** · Risk: **write**

Export the router's SSH host public key to file(s) on the device (`/ip ssh export-host-key`), named with the given prefix (e.g. prefix `myrouter` → `myrouter_*` files in `/file`). Useful to pin/distribute the host key. Download the resulting file with download_file.

| Parameter         | Required | Definition                                                                         |
| ----------------- | -------- | ---------------------------------------------------------------------------------- |
| `key_file_prefix` | Yes      | Filename prefix for the exported key file(s), e.g. 'myrouter'. `{"type":"string"}` |

## import_ssh_host_key

**Import SSH Host Key** · Risk: **dangerous**

Import an SSH host key onto the router from key files already on the device (`/ip ssh import-host-key`). Provide the private-key file and its matching public-key file (upload them first with upload_file). WARNING: this replaces the server's host identity — existing clients will see a changed host key and must re-trust the router.

| Parameter          | Required | Definition                                                                                |
| ------------------ | -------- | ----------------------------------------------------------------------------------------- |
| `private_key_file` | Yes      | Private-key filename on the device, e.g. 'host_key'. `{"type":"string"}`                  |
| `public_key_file`  | No       | Public-key filename on the device (e.g. 'host_key.pub'), if required. `{"type":"string"}` |
