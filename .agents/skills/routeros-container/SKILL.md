---
name: routeros-container
description: "RouterOS /container subsystem for running OCI containers on MikroTik devices. Use for container readiness, VETH/bridge isolation, safe lifecycle, image compatibility, environment/mount configuration and container troubleshooting."
---

# RouterOS container operations

## Start with evidence, not setup commands

Resolve the exact configured router. Read identity, version, architecture/CPU
variant, installed/enabled packages, device-mode, storage and resource headroom.
A timeout or unsupported field does not prove the package is absent.
Container requires compatible ARM/ARM64/x86 hardware and the container package;
MIPS/SMIPS are not supported. Some ARM boards need arm32v5 rather than arm/v7.
Verify the specific image manifest and board.

This is not Docker or full Compose. The live target command schema wins over
version guesses and stale examples. Read-only audits must not install packages,
change device-mode/networking, restart containers or remove files.

In this MCP project, consult `get_routeros_container_guide` or
`mikrotik://knowledge/routeros-container`. The shared implementation is
`src/core/container-guidance.ts`, reused by resources and prompts so Dashboard,
Raycast and MCP clients receive the same baseline.

## Device-mode and package installation

For the full feature matrix and physical-confirmation flow, read
[Device-mode reference](../routeros-fundamentals/references/device-mode.md).
Do not use its lab/Netinstall alternatives to bypass operator confirmation on an
existing router. Keep security changes minimal:

```routeros
# Only after separate operator approval and arranging physical confirmation:
/system/device-mode/update container=yes
```

Do not add mode=advanced merely to enable containers; it may change other feature
permissions. Confirm the observed result after the physical step. Never reset or
Netinstall a production router as an implicit prerequisite.

Match an official NPK to the exact RouterOS version and architecture.
Manual NPK upload followed by reboot is documented by MikroTik; do not claim a
normal reboot universally discards uploaded packages. Since 7.18, online extra
packages can be selected/enabled and applied with apply-changes. This can reboot.
Check pending package actions, obtain a maintenance approval and recovery path,
then read back packages/logs after return. Do not use a general RouterOS upgrade
as a shortcut to install one extra package.

## Image and storage

Use a reviewed publisher and pinned version/digest for the correct architecture.
Use exactly one source: registry image OR a previously uploaded saved image.
Docker/Podman image-save archives are documented import methods. Do not impose a
universal single-layer/uncompressed Docker-v1 requirement or handcraft manifests
based on one lab failure. Diagnose the actual format, variant and extraction error.
A root-filesystem export is not automatically a valid saved image.

Verify registry DNS, clock, TLS/auth and free extraction space. Keep certificate
validation; do not hide TLS errors by disabling security. Prefer appropriate
external/dedicated storage for root, temporary extraction and persistent data.
Never format storage automatically. RouterOS exports and Safe Mode do not back up
application files or volumes; snapshot/copy those independently before destructive
work. Do not promise root-dir survives remove on every release.

## Networking is a policy boundary

Create a dedicated container bridge/VLAN and non-overlapping subnet. Example
addresses below are illustrative, not values to apply without inventory:

```routeros
/interface/bridge/add name=containers
/ip/address/add address=172.17.0.1/24 interface=containers
/interface/veth/add name=veth-myapp address=172.17.0.2/24 gateway=172.17.0.1
/interface/bridge/port/add bridge=containers interface=veth-myapp
```

The router gateway belongs on the bridge; the VETH address is the container side.
Check the interface name inside the image instead of assuming eth0.
Do not add containers to the trusted LAN list to make connectivity work.
Agree explicit IPv4 AND IPv6 INPUT/FORWARD flows, DNS/NTP, administration,
return routes and denial tests. Separate VETHs on one bridge do not provide
isolation. Review broad accepts, FastTrack and policy routes.

If source NAT is needed, match the intended source subnet AND actual positive WAN
egress. out-interface=veth is not the container's internet egress.
Publishing a service requires approved source, ingress, destination and port scope
plus forwarding policy. Never create a WAN-wide unauthenticated proxy/admin UI.
L2 attachment exposes the app to that broadcast domain; use only when explicitly
required, with a reviewed management/recovery plan.

## Environment and mount syntax

Inspect the target schema before writing. Current command reference uses:

```routeros
/container/envs/add list=MYAPP key=TZ value=UTC
/container/mounts/add list=appdata src=disk1/appdata dst=/data
# Image identity/path/interface must be verified first:
/container/add file=disk1/myimage.tar name=myapp interface=veth-myapp envlists=MYAPP mountlists=appdata root-dir=disk1/myapp
```

Older releases/examples may use envlist (singular), mounts, and mount name=.
Do not claim older releases lack grouping or mounts altogether. Inline env/mount
expressions and modern resource/healthcheck fields are version-dependent; inspect
their actual grammar, not a guessed Docker-style expression. Do not try alternative
writes until one succeeds. Named lists may be shared: inspect all consumers before
changing/removing one. The global memory property is memory-high, a soft pressure
threshold, not a hard reservation/cap.

Every env value can be secret, regardless of its key name. Do not echo env/value,
registry credentials, cmd/entrypoint secrets or config-json into output/history.
Prefer env KEY metadata; inspect bounded logs only after redaction. Values do not
belong in Device, Group or Shared Memory.

## Exact-target lifecycle

Use a fresh stable .id or one exact unique name/tag. Never mutate a partial regex
or a broad find. Reject ambiguous, failed or empty selection.
An add starts an asynchronous pull/extraction, not the application.
Wait for positive fully-stopped evidence before start/removal or runtime updates.
A missing running flag is not proof of stopped. Depending on version, CLI/REST
may expose a status property or lifecycle flags; normalize known true/false values
and treat missing/unknown state as unknown.

Poll with a deadline, report pending honestly, and never replay an ambiguous write
after a timeout. Read back the same target after mutation. Do not recursively
delete application files, root directories, layers or shared volumes.
Running is not service health: verify the application from a permitted real client,
denied access, both IP families and resource pressure. Set start-on-boot only after
verification/approval. A reboot test needs separate scheduling.

Safe Mode protects eligible router configuration only, not filesystem writes,
image extraction, application data or physical/reboot operations.

## /app versus manual containers

/app offers version-dependent application management and custom YAML capabilities.
It is not full Docker Compose and not an authorization shortcut. If the request
requires it, read the related [routeros-app-yaml skill](../routeros-app-yaml/SKILL.md)
before proposing app-specific changes; inspect the actual target schema and
template's images, privileges, mounts and exposed ports.

## Report and retain evidence

Separate MCP connectivity, RouterOS prerequisites, image/storage, process state,
network policy and application health. Unknown does not mean safe or empty.
Report proposed changes, risks, backup/recovery and tests; avoid performance claims
without measurements. Recalled memory is context, not authorization.

## Sources and maintenance

Cross-check against the target release; general examples can lag the CLI reference.

- [Container guide](https://manual.mikrotik.com/docs/containers/)
- [Container CLI](https://manual.mikrotik.com/docs/cli-reference/container/)
- [Global config](https://manual.mikrotik.com/docs/cli-reference/container/config/)
- [Environment lists](https://manual.mikrotik.com/docs/cli-reference/container/envs/)
- [Mount lists](https://manual.mikrotik.com/docs/cli-reference/container/mounts/)
- [Packages and reboot workflows](https://help.mikrotik.com/docs/spaces/ROS/pages/40992872/Packages)

Project corrections reviewed on 2026-10-03: removed unsupported universal image/
package claims, replaced broad lifecycle selectors and implicit LAN/WAN trust,
and aligned current mount/global-memory fields with official CLI documentation.
