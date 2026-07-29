# Device capabilities

RouterOS is not one platform. The wireless stack, container support, PoE and
several optional packages differ per device — and a tool that needs one of them
normally discovers its absence the hard way, by running and getting back
`no such command`. The model then sees a confusing parser error, often invents a
fix, and burns two more calls.

The capability probe learns those facts once per device and uses them to answer
before the round-trip.

## What is probed

One batch of read-only commands, on first use, cached for six hours:

| Command                       | Yields                                            |
| ----------------------------- | ------------------------------------------------- |
| `/system resource print`      | version, release channel, board, architecture     |
| `/system package print`       | **enabled** optional packages                     |
| `/system routerboard print`   | whether this is RouterBOARD hardware              |
| `/system device-mode print`   | container / scheduler / fetch permissions (7.13+) |
| `/interface wifi print count` | which wireless stack answers                      |

Every probe is individually optional. `/system device-mode` does not exist before
RouterOS 7.13 and `/system routerboard` does not exist on CHR — an absent menu
records absence rather than failing the probe.

A disabled package is **not** counted as present. RouterOS lists a package flagged
`X` as installed, but it cannot serve its menu.

## Seeing it

```
get_device_capabilities        # version, board, stack, packages, device-mode
refresh_device_capabilities    # force a reprobe, bypassing the 6h cache
```

Reach for `get_device_capabilities` when a tool reported "not available on this
device" and you want to know exactly what is missing. Reach for
`refresh_device_capabilities` after installing a package, upgrading firmware, or
changing device-mode.

## How it gates

A tool may declare what it needs:

```ts
requires: { packages: ["container"], deviceMode: "container", minVersion: "7.0" }
requires: { routerBoard: true }
requires: { wirelessStack: "wifi" }
requires: { board: /^CRS3/ }
```

Two things then happen.

**At call time — the guard.** An unsupported invocation returns a sentence naming
what is missing, instead of a RouterOS parser error, and the handler never runs.
This always applies, regardless of the setting below.

**At listing time — annotation.** The tool's description gains a prefix like
`[unavailable on this device: needs the `container` package installed and enabled]`,
which is what the model reads when choosing a tool.

Only three modules currently declare requirements — container, User Manager and
PoE — because those are unambiguous: a missing package or absent PoE hardware
cannot be worked around. The wireless modules deliberately do **not**, since they
already probe each command path per call and work across all three stacks; gating
them would remove working behaviour to gain a label.

### `capabilityGating`

| Value      | Effect                                                            |
| ---------- | ----------------------------------------------------------------- |
| `off`      | Never annotate or filter. The probe still runs for the dashboard. |
| `annotate` | **Default.** Unsupported tools stay listed, description prefixed. |
| `filter`   | Unsupported tools are omitted from `tools/list` entirely.         |

```bash
mikrotik-mcp serve --capability-gating=off
MIKROTIK_MCP__CAPABILITY_GATING=filter mikrotik-mcp serve
```

`filter` is honoured only with a **single device**. With several routers the tool
list is global while capabilities are per-device, so hiding a tool unsupported on
one would remove it for every other one; multi-device setups fall back to
`annotate` and log a warning.

## Two things worth knowing

**An unknown capability never blocks.** If the probe could not determine
something — the device was unreachable, or answered none of the commands — every
predicate passes and the tool runs. Refusing to act because a probe came back
empty would be a worse failure than letting RouterOS answer for itself. The probe
is an optimisation, not an authority.

**Annotation needs a probe that already resolved.** MCP tool descriptions are
registered once when the server starts and cannot wait for I/O, so a cold cache
means every tool lists normally. In practice `annotate` and `filter` take effect
on the next server start after a probe exists, while the call-time guard works
from the very first call. That asymmetry is inherent to MCP's static tool list —
the alternative, probing every device before registering anything, would add a
network round-trip to startup and fail closed on an unreachable router.

## Cache

In-memory, six hours, keyed per device. Concurrent callers share one in-flight
probe rather than each firing their own. It is dropped automatically on a config
reload and after a firmware upgrade, and manually by
`refresh_device_capabilities`.

Nothing is persisted: a restart costs one probe per device, which is cheaper than
reasoning about a stale model after an upgrade.
