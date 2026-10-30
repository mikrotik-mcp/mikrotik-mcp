---
title: "Vulnerabilities"
description: "Published CVEs matched to this version, ranked by real exposure"
---

## Match RouterOS versions to known advisories

Open **Security → Vulnerabilities** (`#vulns`). The page reads version/service information and compares it with the bundled advisory dataset; it does not exploit a vulnerability or install updates.

- **whole fleet** switches from the default device to all configured devices.
- **show mitigated** includes findings whose affected service is considered mitigated; these are hidden initially.
- **Refresh** reruns the read.

Each device summary lists the readable RouterOS version, board and enabled/unrestricted service counts. Findings show advisory ID, severity/CVSS where available, risk score, affected service, fixed version, remediation, references and any manual check needed.

Exposure is inferred from service settings, including source restrictions. It is not a test from the public internet and does not account for every upstream firewall or path.

### Interpret an empty result

Unreadable devices are **not audited**. No matching advisories only means this dataset and these filters found no match. Check the displayed dataset review date/size and current vendor notices before deciding a router is safe.

See [security hardening](/docs/guides/security-hardening) for complementary checks.

## Screen preview

![Full-page dashboard preview with IP addresses and snapshot/backup names blurred](/screenshots/vulns.jpg)

IP addresses, snapshot/backup names and AAA/OpenVPN usernames are blurred in this full-page capture.
