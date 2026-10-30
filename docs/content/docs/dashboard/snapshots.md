---
title: "Snapshots"
description: "Config history & time-travel diff"
---

## Inspect saved configurations

Open **Backup & recovery → Snapshots** (`#snapshots`). This page lists saved configuration exports with capture time, router, label, RouterOS version, line count and size.

Capture a new export through the [capture_config_snapshot tool](/docs/reference/config-snapshot), then choose **Refresh**. Opening the page does not capture automatically.

Select a row to read its saved export. **Close** hides the export panel without deleting the snapshot.

## Compare two captures

Choose **diff from…** and **to…**, then **Diff →**. The summary reports added and removed lines, or identical content. The unified diff describes those saved versions, not necessarily the router's present configuration.

Snapshots also supply evidence for [Drift Guard](/docs/dashboard/drift), [Simulator](/docs/dashboard/simulator), [Round-trip Lab](/docs/dashboard/round-trip) and [Recovery Lab](/docs/dashboard/recovery-lab).

A text export is not a complete binary backup and does not preserve every secret or external database. Use the [backup workflow](/docs/dashboard/backups) for the appropriate restore artifact.

See [snapshot storage and comparison](/docs/guides/config-snapshots).

## Screen preview

![Full-page dashboard preview with IP addresses and snapshot/backup names blurred](/screenshots/snapshots.jpg)

IP addresses, snapshot/backup names and AAA/OpenVPN usernames are blurred in this full-page capture.
