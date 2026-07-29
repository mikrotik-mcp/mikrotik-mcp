# Alerting

The dashboard shows you what happened — if you are looking at it. Alerting is the
part that reaches out.

Every tool call already flows through one choke point. Alerting hangs rules off
that, plus device health and config drift, and delivers to Slack, Discord, ntfy,
a generic webhook, or the MCP client itself.

Off unless an `alerts` block exists in your config.

## A minimal setup

```jsonc
{
  "alerts": {
    "channels": {
      "slack": { "url": "https://hooks.slack.com/services/T00/B00/xxxx" },
    },
    "rules": [
      {
        "id": "destructive-on-core",
        "description": "Destructive change on the core router",
        "when": {
          "event": "tool_call",
          "risk": ["destructive", "dangerous"],
          "device": ["core-rtr"],
        },
        "severity": "high",
        "channels": ["slack"],
      },
    ],
  },
}
```

## Triggers

Exactly three kinds. The set is closed on purpose — a rule language you can read
at a glance is worth more than one that can express anything.

**`metric`** — a threshold over a rolling window.

```jsonc
{ "metric": "error_rate", "window": "5m", "above": 0.15, "minCalls": 20 }
```

`metric` is one of `error_rate`, `calls`, `avg_duration_ms`, `p95_duration_ms`.
Bound it with `above`, `below`, or both. Each rule is evaluated against **its own
`window`** — a `5m` rule and a `1h` rule see different numbers — on a 30-second
tick. **`minCalls` matters more than it
looks**: one failure on an idle server is a 100% error rate, and paging on that
is the fastest way to get an alerting system muted.

**`event`** — an occurrence or a state change.

```jsonc
{ "event": "tool_call", "risk": ["destructive"], "device": ["core-rtr"] }
{ "event": "device_state", "to": "offline" }
{ "event": "drift", "to": "detected" }
```

Every matcher is ANDed; an absent matcher matches anything. Risk names are
case-insensitive.

**`absence`** — something expected did not happen.

```jsonc
{ "absence": "snapshot", "within": "24h" }
{ "absence": "tool_call", "within": "1h", "device": ["core-rtr"] }
{ "absence": "device_seen", "within": "10m" }
```

`absence` is one of `tool_call` (nothing in the event log), `snapshot` (no config
snapshot taken) or `device_seen` (no _successful_ health probe — a failing probe
is exactly what this watches for). Evaluated on the same 30-second tick as
`metric` rules.

Last-seen is read from durable storage — the event log, the snapshot database,
the live health cache — never from an in-memory tally. That matters: a tally
seeded empty would report everything as absent the instant the server restarts,
and every absence rule would fire at once on boot.

## Timing: `for` and `cooldown`

These are not polish. An alerting system that fires 400 times for one flapping
link is worse than no alerting at all, because people mute it and then miss the
real one.

- **`for`** — the condition must hold this long before firing. Default `0`.
  A link that drops for two seconds should not page anyone; `"for": "2m"` says so.
- **`cooldown`** — no re-fire within this long of the last fire. Default `15m`.

A **resolve** notification is sent when a firing condition clears, styled
distinctly from an alarm. Without it every alert becomes permanent noise.

Flap behaviour is specific and deliberate: once a rule fires it enters cooldown,
and a condition re-met inside that window is _suppressed_ — which emits nothing
on the way in **or** the way out. A link bouncing ten times inside the cooldown
produces exactly one alert and one resolve.

## Channels

| Channel   | Config                                             |
| --------- | -------------------------------------------------- |
| `slack`   | `{ "url": "https://hooks.slack.com/…" }`           |
| `discord` | `{ "url": "https://discord.com/api/…" }`           |
| `ntfy`    | `{ "url": "https://ntfy.sh/topic", "token": "…" }` |
| `webhook` | `{ "url": "…", "method": "POST", "headers": {} }`  |
| `mcp`     | `{}` — pushes to the connected MCP client          |

Prove one works before relying on it:

```
test_alert_channel channel=slack
```

Delivery gets a **5-second timeout**, at most **two retries** with backoff, and a
16 KB payload cap. A `4xx` is not retried — a revoked webhook will not become
valid on the third attempt.

### The `mcp` channel and transports

The `mcp` channel lets the assistant raise "site-b just went offline" mid-
conversation, unprompted. It is wired on the **stdio** transport only. On
`streamable-http` and `sse` there is no unprompted push path wired, so an alert
routed to `mcp` there reports a delivery failure with a clear reason rather than
vanishing silently. Pair `mcp` with a second channel if you use an HTTP
transport.

## Security

**A webhook URL is a credential.** For Slack, Discord and ntfy the secret _is_
the path — anyone who reads it off a screenshot, a log line or an API response
can post as you. So URLs are masked to scheme and host (`https://hooks.slack.com/…`)
everywhere they could surface: logs, the alert history, the config API, and every
tool in this module. Nothing in `list_alert_rules` output will ever contain a
full URL.

**No SSRF protection is claimed.** These endpoints are configured deliberately by
the operator, and pretending to validate them would imply a protection that isn't
there. Do not accept an alerting config from an untrusted source.

## Isolation

The engine sits on the tool-call path, so it is built so it cannot affect one:
evaluation is in-memory and synchronous, delivery is queued to a microtask, and
every failure — a hung endpoint, a bad URL, a bug in an adapter — is returned as
data rather than thrown. A channel that always throws cannot fail, slow, or error
a tool call. That is asserted directly in `tests/alerts/isolation.spec.ts`.

## Tools

| Tool                 | Purpose                                             |
| -------------------- | --------------------------------------------------- |
| `list_alert_rules`   | Rules, live state, and configured channels (masked) |
| `get_alert_history`  | What fired and resolved, with delivery outcomes     |
| `test_alert_channel` | Prove a channel works                               |
| `add_alert_rule`     | Add a rule at runtime                               |
| `update_alert_rule`  | Retune one in place                                 |
| `remove_alert_rule`  | Delete one                                          |
| `mute_alert_rule`    | Silence for a duration                              |

Rules added at runtime live in the running engine — persist them in the config
file to survive a restart.

**Muting is the humane feature.** A muted rule keeps tracking its condition but
says nothing, and un-muting does _not_ replay what resolved while it was quiet.
Reach for it during planned maintenance instead of deleting a rule you will
forget to add back.
