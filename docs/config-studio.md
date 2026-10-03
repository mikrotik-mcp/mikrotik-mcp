# Config Studio — edit the config from the dashboard

The [observability dashboard](./observability.md) can show the effective config;
**Config Studio** lets you _edit_ it safely from the browser — with syntax
highlighting, schema-driven autocomplete, live validation, per-device connection
tests, a diff preview, and a **safe-apply that auto-reverts if it locks you out**.

Open the **Configuration** panel and click **✎ Edit config**.

## What it does

- **Schema-aware editor** — a dependency-free JSON editor with live syntax
  highlighting and Ctrl-Space autocomplete. Completions (keys, enum values like
  `transport`/`mode`) come from the live JSON Schema (`GET /api/config-schema`,
  computed from the Zod config schema), so the hints can never drift from the
  real validator.
- **Authoritative validation** — edits are validated against the _same_ Zod
  schema the server boots from (`POST /api/config/validate`); errors are listed
  with their exact path.
- **Secret-safe round-trip** — the browser only ever sees redacted secrets
  (`«redacted»`). On save, untouched sentinels are restored from the real config
  server-side, so you can edit freely without exposing or losing a secret. Type a
  new value only to change one.
- **Test connection** — each device entry can be probed (`probeDevice`) against
  the _unsaved_ config before you commit, so bad credentials are caught early.
- **Diff preview** — see a unified diff of current vs. edited config before saving.
- **Safe-apply with auto-rollback** — saving writes the file (with a timestamped
  backup), hot-swaps the in-memory config, and starts a **rollback
  countdown**. You must click **Keep changes** within the window; if you don't
  (you locked yourself out, or the browser lost the server), the change auto-reverts
  to the backup — RouterOS-Safe-Mode-style, for the config file itself.

## Where it writes

Config Studio writes to the `--config` file it was started with, or to
`~/.mikrotik-mcp/config.json` when the config was assembled from env/flags.
The Docker image defaults to `/home/bun/.mikrotik-mcp/devices.json`; a writable
mount retains the complete settings there across container recreation. Normal
files and directory mounts use atomic replacement. A single-file bind mount
uses a flushed backup plus an in-place write when rename returns `EBUSY`; that
fallback is not crash-atomic. See [Docker persistence](./docker.md#persistent-devicesjson).

## Honest constraint

Editing an **existing** device's connection details is fully live (handlers read
the device config per call). But the MCP tool **`device` enum is baked at
tool-registration time**, so **adding or removing a device name** only reaches
the model's tool surface after the MCP client reconnects (HTTP) or the server
restarts (stdio). The panel says so when the device list changes — no fake
promises.

## API (token-gated, like the rest of the dashboard)

```
GET  /api/config-schema           the live JSON Schema (drives autocomplete)
POST /api/config/validate         { ok, errors[] }
POST /api/config/test-device      probe a device entry before saving
POST /api/config/preview          unified diff vs current
POST /api/config                  validate → merge secrets → apply (armed rollback)
POST /api/config/keep             confirm a pending apply
POST /api/config/rollback         revert a pending apply now
```
