---
title: "Containers"
description: "Shared container safety knowledge and exact-target OCI lifecycle (`/container`), global config (registry/tmpdir/RAM), named env lists, and volume mounts."
---

## Tools

- [Get RouterOS Container Guide](#get_routeros_container_guide)
- [List Containers](#list_containers)
- [Get Container Detail](#get_container)
- [Add Container](#add_container)
- [Update Container](#update_container)
- [Start Container](#start_container)
- [Stop Container](#stop_container)
- [Remove Container](#remove_container)
- [Get Container Global Config](#get_container_config)
- [Set Container Global Config](#set_container_config)
- [List Container Env Metadata](#list_container_envs)
- [Add Container Env Variable](#add_container_env)
- [Remove Container Env Variable](#remove_container_env)
- [List Container Mounts](#list_container_mounts)
- [Add Container Mount](#add_container_mount)
- [Remove Container Mount](#remove_container_mount)

## get_routeros_container_guide

**Get RouterOS Container Guide** · Risk: **read**

Read shared version-aware container knowledge: prerequisites, image compatibility, VETH isolation, lifecycle, secrets and troubleshooting. No device access. Use before auditing, deploying or changing containers.

| Parameter | Required | Definition                                                                                                                        |
| --------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `topic`   | Yes      | `{"default":"all","type":"string","enum":["all","prerequisites","images","networking","lifecycle","security","troubleshooting"]}` |

## list_containers

**List Containers** · Risk: **read**

Discover container .ids, exact names/tags and lifecycle status/flags. Pull/start/stop are asynchronous; running is not application health. Sensitive env/command/config fields are masked. Use get_routeros_container_guide before changes.

| Parameter       | Required | Definition                                                                       |
| --------------- | -------- | -------------------------------------------------------------------------------- |
| `name_filter`   | No       | RouterOS name regex, escaped as a command value `{"type":"string"}`              |
| `tag_filter`    | No       | `{"type":"string"}`                                                              |
| `status_filter` | No       | Legacy status regex; newer releases may expose flags instead `{"type":"string"}` |
| `detail`        | Yes      | `{"default":false,"type":"boolean"}`                                             |

## get_container

**Get Container Detail** · Risk: **read**

Read one exact, unique container by stable id, name or exact tag; rejects ambiguity. Sensitive env, command and image-config fields are masked. Missing state is unknown, not stopped.

| Parameter | Required | Definition                                                                                              |
| --------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `id`      | No       | Stable .id from fresh discovery; never a row number `{"type":"string","pattern":"^\\*[\\da-fA-F]+$"}`   |
| `name`    | No       | Exact unique container name `{"type":"string","minLength":1}`                                           |
| `tag`     | No       | Exact unique image tag, not a regex; prefer id when images are shared `{"type":"string","minLength":1}` |

## add_container

**Add Container** · Risk: **write**

Create one container after approved prerequisite, image/storage and network review. Requires exactly one image source, a unique name, VETH and dedicated root_dir. No package installation, device-mode, NAT or firewall changes are implicit. Use supported image-save archives; no blanket single-layer restriction. Explicit legacy envlist/mounts aliases are available; inspect target syntax before writing. Returns a pending extraction request, not a healthy deployment; poll before starting.

| Parameter       | Required | Definition                                                                                           |
| --------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `interface`     | Yes      | Previously configured VETH `{"type":"string","minLength":1}`                                         |
| `root_dir`      | Yes      | Dedicated root path on verified storage `{"type":"string","minLength":1}`                            |
| `env`           | No       | Sensitive inline environment; verify support on the target `{"type":"string"}`                       |
| `envlists`      | No       | Current CLI named environment lists `{"type":"string"}`                                              |
| `envlist`       | No       | Legacy singular envlist; exclusive with envlists `{"type":"string"}`                                 |
| `mount`         | No       | Inline mount expression supported by the target; not Docker syntax `{"type":"string"}`               |
| `mountlists`    | No       | Current CLI named mount lists `{"type":"string"}`                                                    |
| `mounts`        | No       | Legacy mounts reference; exclusive with mountlists `{"type":"string"}`                               |
| `cmd`           | No       | Command override; may contain secrets `{"type":"string"}`                                            |
| `entrypoint`    | No       | Entrypoint override; may contain secrets `{"type":"string"}`                                         |
| `workdir`       | No       | `{"type":"string"}`                                                                                  |
| `hostname`      | No       | `{"type":"string"}`                                                                                  |
| `dns`           | No       | `{"type":"string"}`                                                                                  |
| `user`          | No       | `{"type":"string"}`                                                                                  |
| `stop_signal`   | No       | `{"type":"string"}`                                                                                  |
| `devices`       | No       | Device passthrough; extra privilege requires explicit review `{"type":"string"}`                     |
| `cpu_list`      | No       | `{"type":"string"}`                                                                                  |
| `memory_high`   | No       | Soft memory pressure threshold, not a hard cap `{"type":"string"}`                                   |
| `memory_max`    | No       | Hard memory limit only where supported; can terminate processes `{"type":"string"}`                  |
| `logging`       | No       | `{"type":"boolean"}`                                                                                 |
| `start_on_boot` | No       | `{"type":"boolean"}`                                                                                 |
| `comment`       | No       | `{"type":"string"}`                                                                                  |
| `name`          | Yes      | Unique name for read-back and ambiguous-write recovery `{"type":"string","minLength":1}`             |
| `remote_image`  | No       | Reviewed architecture-compatible image with pinned version/digest `{"type":"string","minLength":1}`  |
| `file`          | No       | Uploaded Docker/Podman saved image archive supported by the target `{"type":"string","minLength":1}` |

## update_container

**Update Container** · Risk: **write-idempotent**

Update exactly one container. Runtime settings require positive fully-stopped evidence; logging, comment and start_on_boot can change without stopping. Named env/mount lists can affect other consumers. Inspect target syntax; no automatic compatibility retries.

| Parameter       | Required | Definition                                                                                              |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `id`            | No       | Stable .id from fresh discovery; never a row number `{"type":"string","pattern":"^\\*[\\da-fA-F]+$"}`   |
| `name`          | No       | Exact unique container name `{"type":"string","minLength":1}`                                           |
| `tag`           | No       | Exact unique image tag, not a regex; prefer id when images are shared `{"type":"string","minLength":1}` |
| `interface`     | No       | VETH interface(s); verify target syntax and image interface names `{"type":"string","minLength":1}`     |
| `root_dir`      | No       | Dedicated root path on appropriate storage, not internal flash `{"type":"string","minLength":1}`        |
| `env`           | No       | Sensitive inline environment; verify support on the target `{"type":"string"}`                          |
| `envlists`      | No       | Current CLI named environment lists `{"type":"string"}`                                                 |
| `envlist`       | No       | Legacy singular envlist; exclusive with envlists `{"type":"string"}`                                    |
| `mount`         | No       | Inline mount expression supported by the target; not Docker syntax `{"type":"string"}`                  |
| `mountlists`    | No       | Current CLI named mount lists `{"type":"string"}`                                                       |
| `mounts`        | No       | Legacy mounts reference; exclusive with mountlists `{"type":"string"}`                                  |
| `cmd`           | No       | Command override; may contain secrets `{"type":"string"}`                                               |
| `entrypoint`    | No       | Entrypoint override; may contain secrets `{"type":"string"}`                                            |
| `workdir`       | No       | `{"type":"string"}`                                                                                     |
| `hostname`      | No       | `{"type":"string"}`                                                                                     |
| `dns`           | No       | `{"type":"string"}`                                                                                     |
| `user`          | No       | `{"type":"string"}`                                                                                     |
| `stop_signal`   | No       | `{"type":"string"}`                                                                                     |
| `devices`       | No       | Device passthrough; extra privilege requires explicit review `{"type":"string"}`                        |
| `cpu_list`      | No       | `{"type":"string"}`                                                                                     |
| `memory_high`   | No       | Soft memory pressure threshold, not a hard cap `{"type":"string"}`                                      |
| `memory_max`    | No       | Hard memory limit only where supported; can terminate processes `{"type":"string"}`                     |
| `logging`       | No       | `{"type":"boolean"}`                                                                                    |
| `start_on_boot` | No       | `{"type":"boolean"}`                                                                                    |
| `comment`       | No       | `{"type":"string"}`                                                                                     |

## start_container

**Start Container** · Risk: **write**

start exactly one container by stable id, exact unique name or tag. Start requires positive stopped evidence. Asynchronous: inspect state with bounded polling; accepted does not mean healthy/completed.

| Parameter | Required | Definition                                                                                              |
| --------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `id`      | No       | Stable .id from fresh discovery; never a row number `{"type":"string","pattern":"^\\*[\\da-fA-F]+$"}`   |
| `name`    | No       | Exact unique container name `{"type":"string","minLength":1}`                                           |
| `tag`     | No       | Exact unique image tag, not a regex; prefer id when images are shared `{"type":"string","minLength":1}` |

## stop_container

**Stop Container** · Risk: **write**

stop exactly one container by stable id, exact unique name or tag. Start requires positive stopped evidence. Asynchronous: inspect state with bounded polling; accepted does not mean healthy/completed.

| Parameter | Required | Definition                                                                                              |
| --------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `id`      | No       | Stable .id from fresh discovery; never a row number `{"type":"string","pattern":"^\\*[\\da-fA-F]+$"}`   |
| `name`    | No       | Exact unique container name `{"type":"string","minLength":1}`                                           |
| `tag`     | No       | Exact unique image tag, not a regex; prefer id when images are shared `{"type":"string","minLength":1}` |

## remove_container

**Remove Container** · Risk: **destructive**

Remove exactly one container after a positive stopped check. Back up application data first; do not assume root-dir survives removal. Does not separately delete volumes/layers. Verify absence; never blindly retry an ambiguous write.

| Parameter | Required | Definition                                                                                              |
| --------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `id`      | No       | Stable .id from fresh discovery; never a row number `{"type":"string","pattern":"^\\*[\\da-fA-F]+$"}`   |
| `name`    | No       | Exact unique container name `{"type":"string","minLength":1}`                                           |
| `tag`     | No       | Exact unique image tag, not a regex; prefer id when images are shared `{"type":"string","minLength":1}` |

## get_container_config

**Get Container Global Config** · Risk: **read**

Read registry, extraction storage and memory settings. Registry credentials are masked. Settings are router-wide and may affect every container.

No tool-specific parameters.

## set_container_config

**Set Container Global Config** · Risk: **write-idempotent**

Update router-wide registry/extraction/storage/memory settings and read back. Use verified storage and HTTPS registry; may affect other workloads. memory_high is a soft threshold. ram_high is a compatibility input alias for the same RouterOS memory-high property.

| Parameter      | Required | Definition                                                                  |
| -------------- | -------- | --------------------------------------------------------------------------- |
| `registry_url` | No       | `{"type":"string"}`                                                         |
| `tmpdir`       | No       | `{"type":"string"}`                                                         |
| `layer_dir`    | No       | `{"type":"string"}`                                                         |
| `memory_high`  | No       | `{"type":"string"}`                                                         |
| `ram_high`     | No       | Deprecated alias of memory_high; never sent as ram-high `{"type":"string"}` |
| `username`     | No       | `{"type":"string"}`                                                         |
| `password`     | No       | `{"type":"string"}`                                                         |

## list_container_envs

**List Container Env Metadata** · Risk: **read**

List environment .ids, list names and keys WITHOUT retrieving values. Treat every value as potentially secret. Shared lists may have multiple container consumers.

| Parameter     | Required | Definition                          |
| ------------- | -------- | ----------------------------------- |
| `list_filter` | No       | Exact list name `{"type":"string"}` |

## add_container_env

**Add Container Env Variable** · Risk: **write**

Add a sensitive value to a named env list. Current CLI groups by list; check target syntax. Review all consumers before changing a shared list. Existing running containers may need an approved stop/start; no implicit restart.

| Parameter | Required | Definition                        |
| --------- | -------- | --------------------------------- |
| `list`    | Yes      | `{"type":"string","minLength":1}` |
| `key`     | Yes      | `{"type":"string","minLength":1}` |
| `value`   | Yes      | `{"type":"string"}`               |

## remove_container_env

**Remove Container Env Variable** · Risk: **destructive**

Remove one env entry by stable id OR exact list+key. Reject duplicates/unreadable selection. Review containers consuming this list first; no implicit restart.

| Parameter | Required | Definition                                                                                            |
| --------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `id`      | No       | Stable .id from fresh discovery; never a row number `{"type":"string","pattern":"^\\*[\\da-fA-F]+$"}` |
| `list`    | No       | `{"type":"string","minLength":1}`                                                                     |
| `key`     | No       | `{"type":"string","minLength":1}`                                                                     |

## list_container_mounts

**List Container Mounts** · Risk: **read**

Read mount metadata. Current CLI groups by list; legacy CLI may use name. No application files are read. A list can contain several mounts.

| Parameter     | Required | Definition                                                 |
| ------------- | -------- | ---------------------------------------------------------- |
| `list_filter` | No       | `{"type":"string","minLength":1}`                          |
| `name_filter` | No       | Legacy exact name filter `{"type":"string","minLength":1}` |

## add_container_mount

**Add Container Mount** · Risk: **write**

Add a persistent mount using current list= OR legacy name=, never both. Verify target syntax first. Use appropriate storage; a missing source may be populated from the image. Review consumers; this neither formats storage nor restarts containers.

| Parameter | Required | Definition                                                                                  |
| --------- | -------- | ------------------------------------------------------------------------------------------- |
| `list`    | No       | Current CLI mount-list name `{"type":"string","minLength":1}`                               |
| `name`    | No       | Legacy CLI mount name; do not use for current list syntax `{"type":"string","minLength":1}` |
| `src`     | Yes      | `{"type":"string","minLength":1}`                                                           |
| `dst`     | Yes      | `{"type":"string","minLength":1}`                                                           |

## remove_container_mount

**Remove Container Mount** · Risk: **destructive**

Remove one mount definition by stable id or unique list/name, optionally narrowed by src/dst. Rejects multi-entry lists. Review shared consumers first; no host files are deleted by this tool.

| Parameter | Required | Definition                                                                                            |
| --------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `id`      | No       | Stable .id from fresh discovery; never a row number `{"type":"string","pattern":"^\\*[\\da-fA-F]+$"}` |
| `list`    | No       | `{"type":"string","minLength":1}`                                                                     |
| `name`    | No       | `{"type":"string","minLength":1}`                                                                     |
| `src`     | No       | `{"type":"string","minLength":1}`                                                                     |
| `dst`     | No       | `{"type":"string","minLength":1}`                                                                     |
