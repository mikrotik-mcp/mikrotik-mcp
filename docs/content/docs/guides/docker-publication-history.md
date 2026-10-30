---
title: "Docker publication history"
description: "Archived verification records from previous Docker releases."
---

## 5.20.0 publication record — October 3, 2026

- Application source: release `5.20.0` / `fae15e7` (no application-source edits).
- Published version: `alimaster/mikrotik-mcp:5.20.0`; `latest` promoted to the same index.
- Index digest: `sha256:d2a54dd4e373c075fb6942e577a6bca6f959cd42a7014c7c026818d0c0e3ef60`.
- Registry read-back verified `linux/amd64` and `linux/arm64` manifests.
- Pulled-digest native ARM64 smoke: Bun 1.4.2, application 5.20.0, UID 1000,
  healthcheck, dashboard 9090 with the three new workspaces, MCP initialization
  and all 956 catalog tools; isolated with `--network none` and synthetic JSON.
- Native AMD64 execution was not tested. Cross-building is not a runtime test.
- Repository gate: 2,550 tests, typecheck and lint passed. The stale MCPB manifest
  version was aligned to 5.20.0 and Compose/docs updated separately from application code.
- No running user service was upgraded or restarted by this publication.

## 5.21.0 publication record — October 4, 2026

- Application source: release `5.21.0` / `8d1386c` (no application-source edits).
- Published version: `alimaster/mikrotik-mcp:5.21.0`. `latest` was left unchanged;
  promotion requires a separate operator confirmation.
- Index digest: `sha256:f1926e20c4472681101b45b8abc5a1b8538533195501df424a71a534b526f58c`.
- Registry read-back verified `linux/amd64` and `linux/arm64`, plus build attestations.
- Local-build and pulled-digest native ARM64 checks passed: Bun 1.4.2, application
  5.21.0, UID 1000, CLI version, healthcheck, dashboard on 9090, MCP initialization
  and all 960 catalog tools, including OpenVPN sessions and service-routing traffic.
  Tests used `--network none`, synthetic mounted JSON and no real router credentials.
- Native AMD64 execution was not tested. Cross-building is not a runtime test.
- Native ARM64 image size: 151,527,383 bytes, as reported by Docker image inspect;
  this is the local image size, not compressed registry transfer size.
- Repository gate: 2,755 tests, typecheck and lint passed. All 15 UI assets built;
  the bundled observability dashboard exceeded the 2,000 kB chunk warning threshold.
- MCPB manifest, Compose default and current Docker examples were aligned to 5.21.0.
- No running user service was upgraded or restarted; no router settings were changed.

## 5.22.0 publication record — October 4, 2026

- Application source: release `5.22.0` / `9c298af` (no application-source edits).
- Published version: `alimaster/mikrotik-mcp:5.22.0`. `latest` was left unchanged.
- Index digest: `sha256:98da391f20536105822e3a28db5b2057056e5ab4235e2a8a1cf84521f197c48b`.
- The interactive publisher validated the saved Docker Hub account, rejected
  existing version tags, pushed and verified the registry digest and both
  `linux/amd64` and `linux/arm64` manifests, with build attestations.
- Local-build and pulled-digest native ARM64 checks passed: Bun 1.4.2, application
  5.22.0, UID 1000, CLI version, healthcheck, dashboard on 9090, the user profile
  editor in the dashboard asset, MCP initialization and all 960 unique tools.
  Tests used `--network none`, a writable synthetic JSON bind mount, no published
  host ports and no real router credentials. No device writes were performed.
- Native AMD64 execution was not tested. Cross-building is not a runtime test.
- Native ARM64 image size: 151,533,902 bytes as reported by Docker image inspect;
  this is the local image size, not compressed registry transfer size.
- Repository gate: 2,785 tests, typecheck and lint passed. All 15 UI assets built;
  the observability dashboard still exceeded the 2,000 kB chunk warning threshold.
- MCPB manifest, Compose default and current Docker examples were aligned to 5.22.0.
- No running user service was upgraded or restarted; no router settings were changed.

## 6.0.0 publication record — October 5, 2026

- Application source: release `6.0.0` / `2057183` (no application-source edits).
- Published version: `alimaster/mikrotik-mcp:6.0.0`. `latest` was left unchanged.
- Index digest: `sha256:4359880161ed29702439a0e3fbaaca239ad1d536681f604ba108e51e40f2bc4c`.
- The interactive publisher validated the saved Docker Hub account, checked that
  the version tag was absent, pushed and read back the matching digest and both
  `linux/amd64` and `linux/arm64` manifests, with build attestations.
- Local-build and pulled-digest native ARM64 checks passed: Bun 1.4.2, application
  6.0.0, UID 1000, CLI version, health, dashboard on 9090, MCP initialization and
  all 961 unique tools. The IP Intelligence dashboard route was present.
  Checks used `--network none`, a writable synthetic JSON mount, no published
  host ports and no real router credentials.
- Native AMD64 execution was not tested. Cross-building is not a runtime test.
- Native ARM64 local image size: 151,750,557 bytes, not compressed transfer size.
- Repository gate: 2,932 tests, typecheck and lint passed. All 15 UI assets built;
  the observability dashboard exceeded the 2,000 kB chunk warning threshold.
- Aligned the previously stale MCPB manifest, Compose default and current Docker
  examples to 6.0.0.
- Removed only this publication's disposable smoke containers and verification
  image tag. The pulled release image and build cache were retained.
- No running user service was upgraded or restarted; no router settings changed.

## 6.1.0 publication record — October 5, 2026

- Application source: release `6.1.0` / `f1fc0dd` (no application-source edits).
- Published version: `alimaster/mikrotik-mcp:6.1.0`. `latest` was left unchanged.
- Index digest: `sha256:3513a4f6eec5369da44f6875e2f6d6f2961060e124dd4cb7a2cb15fa0b6599d4`.
- The interactive publisher validated the saved Docker Hub account, checked that
  the version tag was absent, pushed and read back the matching digest and both
  `linux/amd64` and `linux/arm64` manifests, with build attestations.
- Local-build and pulled-digest native ARM64 checks passed: Bun 1.4.2, application
  6.1.0, UID 1000, CLI version, health, dashboard on 9090, MCP initialization and
  all 963 unique tools. The packaged catalog includes RouterOS v7 Wi-Fi status,
  channel scanning and security-profile inspection tools.
  Checks used `--network none`, a writable synthetic JSON mount, no published
  host ports and no real router credentials.
- Native AMD64 execution was not tested. Cross-building is not a runtime test.
- Native ARM64 local image size: 151,769,261 bytes, not compressed transfer size.
- Repository gate: 2,968 tests, typecheck and lint passed. One repeated gate hit
  an existing wall-clock-sensitive assertion (`refreshAfterMs` was 29,999 rather
  than 30,000); its focused suite and the full gate subsequently passed without
  source changes. Publication used that verified source.
- All 15 UI assets built; the observability dashboard still exceeded the
  2,000 kB chunk warning threshold.
- Aligned the previously stale MCPB manifest, Compose default and current Docker
  examples to 6.1.0 separately from application code.
- Removed only this publication's disposable smoke containers and verification
  image tag. The pulled release image and build cache were retained.
- No running user service was upgraded or restarted; no router settings changed.

## 6.3.0 publication record — October 7, 2026

- Application source: `fbbbdcc`, with manifest and Compose version alignment to 6.3.0.
- Published `alimaster/mikrotik-mcp:6.3.0`; `latest` was left unchanged.
- Index digest: `sha256:dcd0cd691c25b55e4a4308c160b6790d59b45263fe6f334f9780493a8140bde1`.
- Registry read-back verified both `linux/amd64` and `linux/arm64` manifests.
- Pulled-digest ARM64 checks passed: Bun 1.4.2, version 6.3.0, UID 1000,
  CLI, health, dashboard, writable synthetic JSON, MCP initialization and 964 tools.
  Acceptance ran without networking, host ports or real router credentials.
- Native AMD64 execution was not tested; cross-build is not a runtime test.
- Native ARM64 image size: 151,847,694 bytes (not compressed transfer size).
- Type checks, all 2,986 offline tests across 226 files, and lint passed.
- No MCP service was upgraded or restarted and no router settings changed.
  Docker Desktop itself required a restart before publication.

## 6.2.0 publication record — October 6, 2026

- Application source: release `6.2.0` / `03d336f` (no application-source edits).
- Published version: `alimaster/mikrotik-mcp:6.2.0`. `latest` was left unchanged.
- Index digest: `sha256:37968b1925f5eb47aa7fb7c1a77add9d637d9b858e67c32fad0582e15f05c7a4`.
- The interactive publisher validated the saved Docker Hub account, checked that
  the version tag was absent, pushed and read back the matching digest and both
  `linux/amd64` and `linux/arm64` manifests, with build attestations. A layer
  upload timed out once; Docker retried successfully before publishing the index.
- Local-build and pulled-digest native ARM64 checks passed: Bun 1.4.2, application
  6.2.0, UID 1000, health, dashboard on 9090, writable JSON, MCP initialization and
  all 963 unique tools. The 588-entry Iranian ASN directory is bundled in the CLI.
  Checks used `--network none`, a writable synthetic JSON mount, no published
  host ports and no real router credentials.
- Native AMD64 execution was not tested. Cross-building is not a runtime test.
- Native ARM64 local image size: 151,829,125 bytes, not compressed transfer size.
- Repository gate: 2,971 tests across 226 files, typecheck and lint passed.
  All 15 UI assets built; the observability dashboard still exceeded the
  2,000 kB chunk warning threshold.
- Aligned the previously stale MCPB manifest, Compose default and current Docker
  examples to 6.2.0 separately from application code.
- No running user service was upgraded or restarted; no router settings changed.
- Removed only this publication's disposable smoke containers, verification image
  tag and synthetic fixture. The pulled release image and build cache were retained.

## 6.4.0 publication record — October 7, 2026

- Application source: release `6.4.0` / `dc087f2`; packaging version alignment only.
- Published `alimaster/mikrotik-mcp:6.4.0`; `latest` left unchanged.
- Verified index digest: `sha256:72ca622e5ae361a1fd846cafd9a1946198b625a371e414d726c6130f85c4d9fe`.
- Registry read-back confirmed `linux/amd64` and `linux/arm64`, with attestations.
- Pulled-digest native ARM64 acceptance passed: Bun 1.4.2, MCP 6.4.0, UID 1000,
  health, dashboard on 9090, writable synthetic JSON, initialization and 964 tools.
  The OpenVPN history SQLite table and new dashboard asset were also verified.
  Checks used `--network none`, no published ports and no router credentials.
- Native AMD64 execution was not tested; a successful cross-build is not a runtime test.
- Typecheck, lint, 2,990 Vitest tests and six native SQLite history tests passed.
  All 15 UI assets built; the existing 2,000 kB dashboard chunk warning remains.
- Aligned Compose, MCPB manifest and current Docker examples to 6.4.0.
- Removed the isolated release builder and its approximately 1.844 GB build cache,
  the downloaded release image, temporary BuildKit image and smoke container.
  No global prune, production-volume removal, service restart or router changes.

## 6.6.0 publication record — October 21, 2026

- Application source: release `6.6.0` / `1e9ee80`; MCPB manifest aligned to 6.6.0.
- Published `alimaster/mikrotik-mcp:6.6.0` and promoted the verified digest to `latest`.
- Both tags read back as `sha256:7e0d582a7ab1ceac14da9b0f66e9a488fc66e19296cba47c71d3af45aad417a6`.
- Registry read-back confirmed `linux/amd64` and `linux/arm64`, with attestations.
- BuildKit registry export stalled; the cached multi-platform build was exported
  as OCI, loaded into Docker's containerd image store and published successfully
  through Docker Engine. No application-source workaround was needed.
- Pulled-digest native ARM64 acceptance passed: Bun 1.4.3, MCP 6.6.0, UID 1000,
  health, dashboard on 9090, writable synthetic JSON, initialization and 972 tools.
  Checks used `--network none`, no published ports and no router credentials.
- Native AMD64 and ARM64 runtime jobs passed for the same source commit in
  [Docker CI run 39591572327](https://github.com/mikrotik-mcp/mikrotik-mcp/actions/runs/39591572327).
  The published AMD64 image was not executed locally.
- Typecheck, lint, 3,091 Vitest tests across 236 files, and the native SQLite
  observability test (eight assertions) passed. Container UI builds also passed.
- Removed the isolated release builder and its 1.906 GB cache, smoke container,
  local release and temporary BuildKit images, and 94 MiB OCI archive/fixtures.
  Unrelated caches, images, services and data volumes were preserved.
- No running MCP service was upgraded or restarted; no router settings changed.
