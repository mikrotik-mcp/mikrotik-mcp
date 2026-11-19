---
title: "SSH keys and authentication"
description: "Select, generate and import a public identity for RouterOS access."
---

## Select an existing key

Open **Devices → Add device / Edit → Authentication → SSH key**. The public identity picker lists keys found on the MCP host, with algorithm, fingerprint and companion private-key path. Refresh the list after creating/importing a key outside MCP. Selecting a key saves its path in the device draft; it does not import the public key into RouterOS.

## Create a key

1. Choose **Create key** and enter a unique name (letters/digits, `_` and `-`, up to 64 characters; start with a letter/digit).
2. Choose **Generate & select key**. MCP creates an RSA-3072 pair in its host user's `.ssh` directory. Existing files are never overwritten; private-file permissions are owner-only.
3. Copy the generated public-key value into a `.pub` file. Import that public file in RouterOS under **System → Users → SSH Keys**, for the exact login user.
4. Return to the draft and **Test connection**. Save and keep the configuration after a successful read-only connection test.

The key is unencrypted for unattended service use. It remains on the MCP host if the editor is cancelled. Never import the private key into RouterOS or paste it into a public issue. Importing an SSH key can affect password SSH login for that RouterOS user; keep a verified recovery login during setup.

## Other authentication paths

The editor also supports a private-key file path, inline PEM/OpenSSH key, optional passphrase and RouterOS password. A filesystem path belongs to the host/container running MCP, not the browser's machine. In Docker, mount the required key read-only and select the mounted path.

See [connection configuration](/docs/guides/configuration) for precedence, REST and jump-host settings.

## Additional screens

### SSH identity picker

![SSH identity picker; full-page capture with IPs and snapshot/backup names blurred](/screenshots/devices-authentication.jpg)

### Key creation form

![Key creation form; full-page capture with IPs and snapshot/backup names blurred](/screenshots/devices-create-key.jpg)

## Keeping secrets out of the configuration file

Three options let a device entry hold no secret at all.

### A password from the environment or a file

```json
{ "edge": { "host": "10.0.0.1", "username": "mcp", "passwordFrom": "env:EDGE_PASSWORD" } }
```

| Reference    | Reads                                                                             |
| ------------ | --------------------------------------------------------------------------------- |
| `env:NAME`   | The environment variable `NAME`.                                                  |
| `file:/path` | The file, without one trailing newline. Works with Docker and Kubernetes secrets. |

`passwordFrom` wins over `password`, and `keyPassphraseFrom` does the same for
the passphrase of a private key. The reference is read each time a connection
opens, so a rotated secret is used without a restart. Only the reference is in
the configuration, its backups and the dashboard's editor.

### The SSH agent

```json
{ "edge": { "host": "10.0.0.1", "username": "mcp", "sshAgent": true } }
```

The server asks the agent of the host (`SSH_AUTH_SOCK`) to sign. The private
key stays in the agent and is never read by the server. This is also how a
hardware key is used: a YubiKey, or a key in the Secure Enclave or a password
manager, sits behind an agent. The agent must run for the user that runs the
server; a service started by `launchd` or `systemd` needs `SSH_AUTH_SOCK` in
its environment.

### Pinning the router's host key

Without a pin, the server accepts whatever host key a router shows. With one, a
router that shows another key is refused before anything is sent:

```json
{
  "edge": {
    "host": "10.0.0.1",
    "hostKeySha256": "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU"
  }
}
```

Get the fingerprint from a network you trust:

```bash
ssh-keyscan -p 22 10.0.0.1 | ssh-keygen -lf -
```

When the key does not match, the error shows the fingerprint the router
presented. Update the pin only if you know why it changed (the router was
replaced or reset, or its host key was regenerated).

Limits to know:

- There is no operating-system keyring support. Use `file:` with a file your
  password manager or secret store writes, or the SSH agent.
- A pin covers SSH. The REST transport checks the router's TLS certificate
  instead (`apiInsecureTls`), and MAC-Telnet has no host key.
- An inline `jumpHost` does not take these options. Use `jumpVia` with a
  configured device, which does.
