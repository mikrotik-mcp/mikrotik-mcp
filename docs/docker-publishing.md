# Publishing to Docker Hub

Repository: **`alimaster/mikrotik-mcp`**. Publish a versioned multi-platform image,
verify what the registry serves, then move `latest` to that exact digest. A Git
release, local build or successful login alone is not a Docker publication.

## Interactive publisher (recommended)

```sh
bun run docker:publish
# Safe interactive preview: no auth access, login, network, build or push
bun run docker:publish --dry-run
bun run docker:publish --help
```

The Bun CLI in `scripts/publish-docker.ts` guides you through:

1. Docker Engine/Buildx preflight and account discovery from `DOCKER_CONFIG/config.json`
   (default `~/.docker/config.json`). The Hub-specific `credHelpers` entry wins over
   `credsStore`; Docker Desktop/native keychain and inline `auths` are supported.
2. Online credential validation against Docker Hub. Missing/expired credentials
   trigger **`docker login` in your terminal**; the script waits for its browser/device-code
   flow to finish and re-reads the saved account. Browser approval/2FA remains yours.
3. Choose the account/organization repository, existing Buildx builder, and AMD64,
   ARM64 or both (default). Your detected username is the default namespace; no
   personal username or password is hardcoded. Version comes from `package.json`.
4. Review the plan and any dirty checkout; run types/tests/lint (default), then
   explicitly confirm publication. A tag that already exists is rejected; an auth
   or network error is **not** interpreted as a missing tag. Enable immutable
   version tags on Docker Hub to also prevent races with concurrent publishers.
5. Push the version, verify the registry digest against Buildx metadata and verify
   requested architectures. Pull that digest and run network-isolated native
   Bun/version/UID/CLI checks. These are **not** full HTTP/dashboard/MCP acceptance
   tests; perform those below before confirming the separate `latest` promotion.
   When no native architecture is selected, `latest` promotion is skipped.
6. Optionally promote the same digest to `latest`, then read back both tags.
   Publication never restarts services, changes Compose or contacts your routers.

Passwords/tokens are read only in memory, never printed, written by the script,
or passed in command arguments. Credential-helper errors and auth response bodies
are deliberately hidden. Only Docker owns credential persistence. HTTPS auth
requests use a fixed Docker endpoint, reject redirects, and have a timeout.
A locked/missing helper fails safely instead of falling back to stale credentials.
Legacy `<token>`/identity-token-only entries have no reliable username and are
renewed through `docker login`; if still unresolved, use `docker login --username
YOUR_DOCKER_ID`. Unset `DOCKER_AUTH_CONFIG` before running: version-dependent
environment overrides could otherwise make Docker use a different account.

An interactive terminal is required; there is no unattended `--yes`. `Ctrl+C`
cancels and `NO_COLOR=1` or `--no-color` disables ANSI colors. Help is safe in CI.
An interrupted push may already exist remotely: inspect its tag before retrying.
Temporary Buildx metadata is cleaned up, but pulled images/build cache are retained;
there is no global image/volume prune. The existing builder/context is never changed.

The manual procedure below remains available for detailed release acceptance.

## 1. Prepare the release

Run from the repository root with Docker Desktop/Engine, Buildx and the pinned Bun
version installed. Use a reviewed release checkout; do not build from unrelated
uncommitted application changes. Update the default image version in
`docker-compose.yml`, keep `manifest.json` aligned with `package.json`, and update
the examples in `README.md` and `docs/docker.md` when
publishing a new release. The packaging test checks Compose against `package.json`.

```sh
git status --short
git log -1 --oneline
bun --no-env-file -p 'require("./package.json").version'
docker version
docker buildx ls
docker login

bun install --frozen-lockfile
bun run test:types && bun run test && bun run lint

RELEASE_VERSION=$(bun --no-env-file -p 'require("./package.json").version')
RELEASE_IMAGE=alimaster/mikrotik-mcp
docker buildx imagetools inspect "$RELEASE_IMAGE:$RELEASE_VERSION"
```

On the first publication of a version, the last command should report **not found**.
An authentication/network error is not proof that the tag is absent. If the tag
already exists, inspect it and stop; use a new release version instead of silently
overwriting a published version. Never paste access tokens into command arguments
or commit credentials. Use Docker's credential store/login flow.

Docker Desktop's default builder supports multi-platform images. On other hosts,
select a suitable existing builder or create one deliberately:

```sh
docker buildx create --name mikrotik-publisher --driver docker-container --bootstrap
# If created, add --builder mikrotik-publisher to the build commands below.
```

## 2. Build and smoke-test natively

Select the Linux engine's native architecture, not a hardcoded ARM default.
Ubuntu/x86 and Windows Docker Desktop on Intel/AMD use `linux/amd64`; Apple
Silicon and ARM Linux use `linux/arm64`.

```sh
case "$(docker info --format '{{.Architecture}}')" in
  x86_64|amd64) RELEASE_PLATFORM=linux/amd64 ;;
  aarch64|arm64) RELEASE_PLATFORM=linux/arm64 ;;
  *) echo "Unsupported Docker engine architecture"; exit 1 ;;
esac
docker buildx build --pull --platform "$RELEASE_PLATFORM" --load \
  --tag "$RELEASE_IMAGE:$RELEASE_VERSION-verify" .
docker run --rm --network none "$RELEASE_IMAGE:$RELEASE_VERSION-verify" --version
docker run --rm --network none --entrypoint bun \
  "$RELEASE_IMAGE:$RELEASE_VERSION-verify" \
  --no-install --no-env-file -e \
  'console.log({bun:Bun.version,arch:process.arch,uid:process.getuid(),version:require("./package.json").version})'
```

The reported application version must match the release and UID must be `1000`.
The Dockerfile also checks the bundled MCP catalog and builds every UI asset.
For runtime acceptance, start a temporary container with `--network none`, a
dedicated synthetic `devices.json`, no real router credentials and no host port
publishing. Enable its dashboard on 9090 and use `docker exec` to check `/health`,
dashboard HTML, MCP initialization and `tools/list` from inside that container.
For an MCP listener bound to `127.0.0.1:8000`, set the synthetic config's
`mcp.allowedHosts` to `127.0.0.1:8000`; keep Host-header protection enabled.
Do not reuse the running service's JSON or state volume. Health alone does not
prove MCP protocol/catalog correctness or router connectivity.

The repository's `.github/workflows/docker.yml` automates this runtime acceptance
on **both native architectures** using `scripts/check-docker-runtime.ts` and a
disposable JSON fixture. It builds locally on the runner without registry login
or publication. Verify both jobs have passed for the release source; one native
pass plus a cross-build does not imply the other architecture was executed.

Repeat native smoke checks on each supported architecture where available. This
project builds JavaScript on `BUILDPLATFORM`; a successful AMD64 cross-build on
ARM does **not** validate native AMD64 execution. Do not treat a QEMU/JSC failure
as a native result or disable safeguards to conceal it. Record untested platforms.

## 3. Publish the versioned image

```sh
docker buildx build --pull --platform linux/amd64,linux/arm64 \
  --tag "$RELEASE_IMAGE:$RELEASE_VERSION" --push .
docker buildx imagetools inspect "$RELEASE_IMAGE:$RELEASE_VERSION"
```

Check for both `linux/amd64` and `linux/arm64`. `unknown/unknown` manifests can be
BuildKit attestations; they are not runnable architectures. Copy the **top-level
Digest** printed by inspect, not one architecture's digest:

```sh
RELEASE_DIGEST=sha256:REPLACE_WITH_VERIFIED_TOP_LEVEL_DIGEST
docker pull --platform "$RELEASE_PLATFORM" "$RELEASE_IMAGE@$RELEASE_DIGEST"
docker run --rm --network none "$RELEASE_IMAGE@$RELEASE_DIGEST" --version
```

Repeat the isolated HTTP/dashboard/MCP acceptance checks against this pulled
digest. If any check fails, **do not promote `latest`**. Inspect and document the
failure; use a new version for a corrected published artifact.

## 4. Promote the verified digest to latest

```sh
docker buildx imagetools create --tag "$RELEASE_IMAGE:latest" \
  "$RELEASE_IMAGE@$RELEASE_DIGEST"
docker buildx imagetools inspect "$RELEASE_IMAGE:latest"
docker buildx imagetools inspect "$RELEASE_IMAGE:$RELEASE_VERSION"
```

Both tags must resolve to the same top-level digest and contain both platforms.
This promotes the verified manifest without rebuilding. Record the digest,
source commit, native tests and any platform limitations in the release record.

## 5. Upgrade a deployment separately

After reviewing backups and confirming pending configuration changes:

```sh
MIKROTIK_IMAGE_TAG=5.22.0 docker compose pull mikrotik-mcp
MIKROTIK_IMAGE_TAG=5.22.0 docker compose up -d mikrotik-mcp
docker compose ps mikrotik-mcp
docker compose logs --tail 50 mikrotik-mcp
```

Use your published version in both commands. Existing `devices.json` and state
mounts remain in place; do not use `down -v`. Reconnect MCP clients after upgrading.
Publishing does not itself deploy/restart any running service. See
[deployment and persistence](docker.md) for the initial config and SSH key mounts.

## Local cleanup

Stop/remove only your named temporary smoke container, then remove your temporary
verification image tag. Inspect the exact targets first. Do not prune all Docker
images, build caches or volumes on a shared development machine. Registry images
are independent of local images; local removal does not unpublish the release.

References: [Docker login and credential helpers](https://docs.docker.com/reference/cli/docker/login/),
[registry authentication](https://docs.docker.com/reference/api/registry/auth/),
[Docker multi-platform builds](https://docs.docker.com/build/building/multi-platform/)
and [manifest promotion](https://docs.docker.com/reference/cli/docker/buildx/imagetools/create/).

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
