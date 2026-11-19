---
title: "Firmware Repository"
description: "RouterOS packages kept on the MCP host: download a version once with its checksum, send the same files to every router over SFTP (routers need no internet), then finish the upgrade after the reboot — version check, RouterBOOT, and your own commands."
---

## Tools

- [List the Local Firmware Repository](#firmware_repo_list)
- [Download RouterOS Packages to the Local Repository](#firmware_repo_fetch)
- [Stage an Upgrade From the Local Repository](#firmware_stage_from_repo)
- [Finish an Upgrade After the Reboot](#firmware_post_upgrade)

## firmware_repo_list

**List the Local Firmware Repository** · Risk: **read**

Lists the RouterOS package files (`.npk`) kept on the MCP host, with size and SHA-256. These are the files `firmware_stage_from_repo` uploads to routers. Use it to see which versions and architectures are ready, or to compare a checksum. It contacts no router. Fill the repository with `firmware_repo_fetch`. Returns the directory and one line per file.

No tool-specific parameters.

## firmware_repo_fetch

**Download RouterOS Packages to the Local Repository** · Risk: **write**

Downloads RouterOS packages for one version and architecture from MikroTik (download.mikrotik.com, HTTPS only) into the firmware repository on the MCP host, and records their SHA-256. It changes no router. Use it once for each version, then `firmware_stage_from_repo` sends the same files to every router, so routers need no internet and all get identical packages. `packages` defaults to the main `routeros` package; add the extra packages your routers use (for example `wireless`, `container`, `user-manager`). A file that is already in the repository is kept, not downloaded again. Returns each file with its size and checksum, or the reason a download failed.

| Parameter      | Required | Definition                                                                                                                                                                                           |
| -------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`      | Yes      | RouterOS version, for example '7.25.1' `{"type":"string","pattern":"^\\d+\\.\\d+(?:\\.\\d+)?(?:(?:beta\|rc)\\d+)?$"}`                                                                                |
| `architecture` | Yes      | Package architecture. Use x86 for CHR and x86_64 routers. `{"type":"string","enum":["arm","arm64","mipsbe","mmips","smips","ppc","tile","x86"]}`                                                     |
| `packages`     | Yes      | Package names without version, for example ['routeros','wireless'] `{"default":["routeros"],"minItems":1,"maxItems":20,"type":"array","items":{"type":"string","pattern":"^[a-z][a-z0-9-]{0,40}$"}}` |

## firmware_stage_from_repo

**Stage an Upgrade From the Local Repository** · Risk: **write**

Uploads the RouterOS packages of one version from the firmware repository on the MCP host to a router, ready to install at its next reboot. The router needs no internet. The tool reads the router's architecture and its installed packages, picks the matching files, checks free storage, uploads over SFTP and verifies each file arrived. It does NOT reboot: the router keeps running its current version until you reboot it (`reboot_system`), and RouterOS installs the packages during that reboot. DEFAULTS TO A DRY RUN (`apply=false`) that shows what would be uploaded and what is missing from the repository. Every installed package must be staged at the same version, so a missing file stops the upload; get it with `firmware_repo_fetch`. After the reboot, run `firmware_post_upgrade`. Not available for a MAC-Telnet device (no file transfer).

| Parameter | Required | Definition                                                                                                                |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `version` | Yes      | The version to stage, for example '7.25.1' `{"type":"string","pattern":"^\\d+\\.\\d+(?:\\.\\d+)?(?:(?:beta\|rc)\\d+)?$"}` |
| `apply`   | Yes      | false = show the plan (default); true = upload `{"default":false,"type":"boolean"}`                                       |

## firmware_post_upgrade

**Finish an Upgrade After the Reboot** · Risk: **write**

The step after a RouterOS upgrade reboot. It (1) checks that the router now runs the expected version, (2) compares the RouterBOOT (bootloader) version with the one the NEW RouterOS carries and, with `upgrade_routerboard=true`, queues the bootloader upgrade, and (3) runs the commands you give, in order. RouterBOOT must be upgraded AFTER RouterOS: the new bootloader comes inside the new RouterOS, so upgrading it before the reboot installs the old one. A queued bootloader takes effect at one more reboot, which this tool does NOT do. Each command is first parsed on the router; if one is not valid, none runs. Running stops at the first command that fails. Use it after `firmware_upgrade` or after a reboot that followed `firmware_stage_from_repo`. Returns what was checked, queued and run.

| Parameter             | Required | Definition                                                                                                                                          |
| --------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `expected_version`    | No       | Stop when the router does not run this version, for example '7.25.1' `{"type":"string","pattern":"^\\d+\\.\\d+(?:\\.\\d+)?(?:(?:beta\|rc)\\d+)?$"}` |
| `upgrade_routerboard` | Yes      | Queue the RouterBOOT upgrade when its version differs `{"default":false,"type":"boolean"}`                                                          |
| `commands`            | Yes      | RouterOS commands to run after the checks, in order `{"default":[],"maxItems":50,"type":"array","items":{"type":"string","minLength":1}}`           |
