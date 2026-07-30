# Attack Detection

Every other security feature in this repo answers _"is this box configured
well?"_. This one answers **"is someone attacking it right now, and what did
they do?"** — the question you have when it is happening.

It is not hypothetical. The first log this feature was pointed at, on a live
router, had an attack in progress: one source hammering the API service about
once a second for hours, and a second walking usernames over SSH. The box was
doing exactly what it was configured to do — logging each failure and moving on.
Nobody was going to read those logs.

Seven tools, in the **Attack Detection** module (Security):

| Tool                        | Risk        | What it does                                    |
| --------------------------- | ----------- | ----------------------------------------------- |
| `scan_for_attacks`          | READ        | Detect across the fleet now; changes nothing    |
| `list_attack_incidents`     | READ        | Recorded incidents, worst first                 |
| `get_attack_incident`       | READ        | One incident with all of its evidence           |
| `block_attacker`            | WRITE       | Block a source; dry run unless `confirm: true`  |
| `unblock_attacker`          | DESTRUCTIVE | Lift a block, keeping the record of why         |
| `list_attack_responses`     | READ        | Every block: what, why, when it expires         |
| `configure_attack_response` | READ        | The policy, and why an address would be refused |

## What this is NOT

- **Not an IDS.** No packet inspection, no payload signatures, no rule database
  to keep current. It reasons over what RouterOS already writes down.
- **Not DDoS mitigation.** A volumetric flood is stopped by the router's own
  rate limiting (`harden_firewall`) or upstream — not by a host that finds out
  thirty seconds later.
- **Not a replacement for hardening.** Detecting a brute force against a Winbox
  port open to the internet is worth less than closing it. Every incident links
  to the tool that would have prevented it.

## Detection is free; response is not

Auto-blocking is the most dangerous thing this repo can do. Three failure modes,
each of which has taken down a real network somewhere:

1. **Locking the operator out.** An admin's VPN reconnect loop and an attacker's
   retry loop look similar from a log line.
2. **Blocking a forged source.** A flood with spoofed addresses turns any
   auto-blocker into a weapon aimed at whoever the attacker names — your
   upstream gateway, your resolver, a customer.
3. **Blocking the monitoring.** This server's own health probe logs a successful
   SSH login every few seconds. A naive "unusual login" detector alerts on
   itself, forever.

So the guards below are enforced **in code** and cannot be configured away:

| Guard                      | What it does                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Detect-only default        | `mode: "detect"` ships as the default. Nothing on a device changes.                                                                   |
| Spoofable evidence refused | A detector whose source can be forged never triggers a response — not even a manual one with `confirm: true`.                         |
| Never-block set            | Seeded from your deployment: every configured device, this server's own management path, and the private ranges.                      |
| Timed by default           | A block expires on its own. Permanent needs an explicit empty timeout **and** `confirm: true`.                                        |
| Rate cap                   | 6 blocks per device per hour. Hitting it refuses **loudly** and says what was not blocked — silence there would be the worst outcome. |
| One rule per device        | Blocking is an address-list insert behind a single raw drop rule. Never a firewall rule per attacker.                                 |
| Breach escalates           | A confirmed breach pages a human instead of blocking. The attacker is already in; blocking the source does not undo that.             |

Every refusal says which rule stopped it. Ask directly:

```
configure_attack_response check_address=203.0.113.7
```

## The detectors

| Detector                | Fires on                                         | Default    | Spoofable |
| ----------------------- | ------------------------------------------------ | ---------- | :-------: |
| `brute-force`           | failed logins from one source                    | 10 / 5 min |    no     |
| `credential-spray`      | one source trying several usernames              | 3 / 10 min |    no     |
| `successful-after-fail` | a login that **succeeded** after failures        | any        |    no     |
| `new-admin-source`      | first successful login from an unknown public IP | first      |    no     |
| `port-scan`             | the device's own `detect-portscan` list          | membership |    no     |
| `firewall-drop-storm`   | logged firewall hits from one source             | 100 / 5min |  **yes**  |
| `service-exposure-hit`  | a management port reached from the internet      | any        |    no     |
| `post-compromise`       | unexplained change to a security-relevant menu   | any        |    no     |

`successful-after-fail` is the one to wake up for, and it never auto-responds.

### When a detector cannot run, it says so

A detector that quietly finds nothing because logging was never enabled reports
a calm network — the most dangerous output this feature could produce. So each
reports itself `unavailable` with the single thing that would fix it:

```
Detectors that could not run:
  · firewall-drop-storm — no firewall rule on this device logs its hits
      fix: set `log=yes log-prefix=drop` on the rules you want visibility into
  · post-compromise — no configuration-change source
      fix: set a Drift Guard baseline with config_set_baseline
```

Two of these are worth knowing about up front:

- **RouterOS does not audit configuration changes to the log at all.** Verified
  against a live device. So `post-compromise` reads from **Drift Guard**
  (`config_set_baseline` + `config_check_drift`), which already computes exactly
  that against your golden config.
- **`firewall-drop-storm` and `service-exposure-hit` need `log=yes`** on the
  rules you care about. Turning that on is a config change this feature will not
  make for you.

### The learning window

`new-admin-source` is worthless on day one and dangerous if trusted then. The
engine builds a 7-day baseline of which sources normally administer each device
and reports the detector as `learning` until it has the data.

## Incidents, not findings

Signals group into an incident keyed by source, **across devices**. One source
hitting three routers is one incident with three affected devices — the pattern
no single router can see, and the whole argument for running this on the host.

Each incident carries a stage — `recon` → `attempt` → `breach` → `persistence` —
inferred from which detectors fired. That is what turns a list into a sentence:

> 203.0.113.7 across 2 devices (edge, core): tagged by the device's own port-scan
> signatures; then 240 failed logins within 5 min; then logged in as admin after
> 12 failed attempts — treat this device as compromised until proven otherwise.

Confidence is `low` / `medium` / `high` / `confirmed`. **`confirmed` requires
evidence that something actually happened** — a success after failures, or a
config change nobody can account for. Volume never confirms anything, however
much of it there is.

A stage only ever escalates. An attacker who got in yesterday did not un-get-in
because today's sweep saw only scanning.

## Turning it on

```json
{
  "attacks": {
    "enabled": true,
    "mode": "detect"
  }
}
```

Watch it for a week. Read what it finds. Then, if you want it to act:

```json
{
  "attacks": {
    "enabled": true,
    "mode": "respond",
    "minConfidence": "high",
    "autoRespondTo": ["brute-force", "credential-spray"],
    "blockTimeout": "1h",
    "maxBlocksPerHour": 6,
    "neverBlock": ["198.51.100.0/24"]
  }
}
```

Full block:

| Key                | Default                              | What it does                        |
| ------------------ | ------------------------------------ | ----------------------------------- |
| `enabled`          | `false`                              | Master switch                       |
| `mode`             | `"detect"`                           | `detect` or `respond`               |
| `pollSeconds`      | `120`                                | Sweep interval                      |
| `windowMinutes`    | `10`                                 | How far back each sweep reads       |
| `concurrency`      | `4`                                  | Devices swept at once               |
| `minConfidence`    | `"high"`                             | Floor for an automatic response     |
| `blockTimeout`     | `"1h"`                               | How long a block lasts              |
| `maxBlocksPerHour` | `6`                                  | Per-device response cap             |
| `neverBlock`       | `[]`                                 | Your additions to the protected set |
| `autoRespondTo`    | `["brute-force","credential-spray"]` | Detectors allowed to act            |
| `learningDays`     | `7`                                  | Baseline window                     |
| `readScanList`     | `true`                               | Read the on-device port-scan list   |
| `retainDays`       | `90`                                 | Incident retention                  |

The sweep window is deliberately longer than the poll interval: `/log` is a ring
buffer with **no cursor**, so non-overlapping windows would silently drop
everything in between. The overlap re-delivers lines, and every event is
de-duplicated on `(device, time, message)`.

## Where the alerts go

Incidents are emitted into the existing [alerting](./alerting.md) bus as `attack`
events, so they reach whatever channels you already configured:

```yaml
alerts:
  rules:
    - id: attack-confirmed
      when: { event: attack, isError: true }
      channels: [slack]
```

## What it builds on

Nothing here re-implements what the router already does well:

| Existing feature                | How this uses it                                                             |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `add_port_scan_detection_rules` | Reads its address list. The router sees every packet; the host sees none.    |
| `harden_firewall`               | Recommended from any volumetric incident — the right place for that defence. |
| `subscribe_threat_feed`         | An attacker already on a feed is higher confidence.                          |
| Drift Guard                     | The input to `post-compromise`.                                              |
| Alerting                        | The delivery path.                                                           |
| `block_device`, address lists   | The blocking primitives. No new mechanism.                                   |
