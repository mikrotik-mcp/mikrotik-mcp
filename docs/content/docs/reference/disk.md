---
title: "Disk"
description: "Storage management (`/disk`): list/get disks, format (filesystem/partition/encryption), label & state, RAID/rsync/RAM virtual disks, SMB/NFS sharing, and eject."
---

## Tools

- [List All Attached Disks](#list_disks)
- [Get Disk Details](#get_disk)
- [Format Disk (Destructive Erase)](#format_disk)
- [Set Disk Properties](#set_disk)
- [Share a Disk over SMB / NFS](#share_disk)
- [Add a Virtual Disk (RAID / rsync / RAM)](#add_disk)
- [Eject Removable Disk](#eject_disk)
- [Remove a Virtual Disk Entry](#remove_disk)

## list_disks

**List All Attached Disks** · Risk: **read**

List all storage devices (`/disk print`) attached to the MikroTik — NVMe, SATA/SSD, USB drives, eMMC/internal flash, their partitions, plus any RAID/rsync/RAM virtual disks. Use this to discover storage and obtain each disk's `slot` (the identifier needed by get_disk, format_disk, set_disk, share_disk, eject_disk and remove_disk). Returns slot, type, model/serial, interface, size, free space, filesystem, label and mount point. Optionally filter by partial `slot_filter`, `type_filter` (e.g. raid, partition, rsync) or `interface_filter` (e.g. nvme, usb, sata). Set `detail=true` for the full per-disk property block. For one disk use get_disk.

| Parameter          | Required | Definition                                                                 |
| ------------------ | -------- | -------------------------------------------------------------------------- |
| `slot_filter`      | No       | Partial slot match, e.g. 'usb' `{"type":"string"}`                         |
| `type_filter`      | No       | Partial type match, e.g. 'raid', 'partition' `{"type":"string"}`           |
| `interface_filter` | No       | Partial interface match, e.g. 'nvme', 'usb' `{"type":"string"}`            |
| `detail`           | Yes      | Show the full per-disk property block `{"default":false,"type":"boolean"}` |

## get_disk

**Get Disk Details** · Risk: **read**

Get full detail for a single disk by slot (`/disk print detail where slot=...`) — its type, filesystem, size and free space, label, mount point, partition layout, model/serial/firmware, RAID role, SMART status, and any SMB/NFS sharing. Use list_disks to find the slot. To erase/reformat use format_disk; to change its label or sharing use set_disk / share_disk.

| Parameter | Required | Definition                                          |
| --------- | -------- | --------------------------------------------------- |
| `slot`    | Yes      | Disk slot, e.g. 'nvme1', 'usb1' `{"type":"string"}` |

## format_disk

**Format Disk (Destructive Erase)** · Risk: **dangerous**

Erase and (re)format a disk or partition (`/disk format-drive`) — PERMANENTLY DESTROYS all data on the target slot. Use to prepare new storage, change filesystem, repartition, or enable encryption. Requires confirm=true. `file_system` picks the filesystem (ext4, exfat, fat32, ntfs). `label` sets the volume label. `partition_size` (e.g. '10G') formats only part of the drive (creating a partition) instead of the whole device. `encryption` + `encryption_password` create an encrypted volume (supply the RouterOS encryption value, e.g. 'aes-cbc'). Identify the disk by `slot` from list_disks. For read-only inspection use list_disks / get_disk.

| Parameter             | Required | Definition                                                                                                  |
| --------------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `slot`                | Yes      | Disk slot to format, e.g. 'usb1' `{"type":"string"}`                                                        |
| `file_system`         | No       | Filesystem to create (RouterOS can format these) `{"type":"string","enum":["ext4","exfat","fat32","ntfs"]}` |
| `label`               | No       | Volume label `{"type":"string"}`                                                                            |
| `partition_size`      | No       | Format only this much as a partition, e.g. '10G' (omit = whole drive) `{"type":"string"}`                   |
| `encryption`          | No       | Encryption algorithm to enable, e.g. 'aes-cbc' (RouterOS value) `{"type":"string"}`                         |
| `encryption_password` | No       | Passphrase when encryption is set `{"type":"string"}`                                                       |
| `confirm`             | Yes      | Must be true to actually ERASE the disk `{"type":"boolean"}`                                                |

## set_disk

**Set Disk Properties** · Risk: **write-idempotent**

Update a disk's non-destructive properties (`/disk set [find slot=...]`) — set its `label` or `comment`, enable/disable it, or assign it to a software RAID array via `raid_master` (the slot of the RAID disk created with add_disk) or attach it under a `parent`. Does NOT erase data (use format_disk for that) and does NOT configure sharing (use share_disk). Identify by `slot` from list_disks.

| Parameter     | Required | Definition                                                         |
| ------------- | -------- | ------------------------------------------------------------------ |
| `slot`        | Yes      | Disk slot to modify `{"type":"string"}`                            |
| `label`       | No       | Volume / disk label `{"type":"string"}`                            |
| `comment`     | No       | `{"type":"string"}`                                                |
| `raid_master` | No       | Slot of the RAID disk to make this a member of `{"type":"string"}` |
| `parent`      | No       | Parent disk slot to attach under `{"type":"string"}`               |
| `disabled`    | No       | `{"type":"boolean"}`                                               |

## share_disk

**Share a Disk over SMB / NFS** · Risk: **write**

Expose a disk on the network by setting its sharing properties (`/disk set [find slot=...]`) — toggle `smb_sharing` (Windows/macOS file sharing) with a `smb_share_name` and allowed `smb_users`, and/or `nfs_sharing` for Unix clients. RouterOS serves the share from the disk's mount point. The SMB/NFS server must be enabled on the device. Pass smb_sharing=false / nfs_sharing=false to stop sharing. Identify the disk by `slot` from list_disks.

| Parameter        | Required | Definition                                                                |
| ---------------- | -------- | ------------------------------------------------------------------------- |
| `slot`           | Yes      | Disk slot to share `{"type":"string"}`                                    |
| `smb_sharing`    | No       | Enable/disable SMB (CIFS) sharing `{"type":"boolean"}`                    |
| `smb_share_name` | No       | SMB share name shown to clients `{"type":"string"}`                       |
| `smb_users`      | No       | Comma-separated SMB users allowed to access the share `{"type":"string"}` |
| `nfs_sharing`    | No       | Enable/disable NFS sharing `{"type":"boolean"}`                           |

## add_disk

**Add a Virtual Disk (RAID / rsync / RAM)** · Risk: **write**

Create a virtual disk (`/disk add`). Use `type` to pick the kind: `raid` (software RAID array — set `raid_type` such as raid0/raid1/raid5/raid6/raid10, then add member drives with set_disk raid_master=<new slot>), `rsync` (a network rsync backup target), or `tmpfs` (a RAM disk — set `tmpfs_max_size`, e.g. '256M'). Optionally name the new disk via `slot`. `properties` passes any additional RouterOS attribute=value pairs for the chosen type (e.g. rsync-target, nfs-server). Requires RouterOS 7.x with disk/RAID support. To delete a virtual disk use remove_disk.

| Parameter        | Required | Definition                                                                                                                                             |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `type`           | Yes      | Virtual disk type: 'raid', 'rsync', 'tmpfs', 'encrypted', … `{"type":"string"}`                                                                        |
| `slot`           | No       | Name/slot for the new virtual disk `{"type":"string"}`                                                                                                 |
| `raid_type`      | No       | For type=raid, e.g. 'raid1', 'raid5' `{"type":"string"}`                                                                                               |
| `tmpfs_max_size` | No       | For type=tmpfs, e.g. '256M' `{"type":"string"}`                                                                                                        |
| `comment`        | No       | `{"type":"string"}`                                                                                                                                    |
| `properties`     | No       | Extra RouterOS attribute=value pairs for this disk type `{"type":"object","propertyNames":{"type":"string"},"additionalProperties":{"type":"string"}}` |

## eject_disk

**Eject Removable Disk** · Risk: **write**

Safely eject / unmount a removable disk (`/disk eject`) so it can be physically unplugged without data loss — flushes caches and unmounts the device. Use for USB drives and other hot-pluggable media before removal. Identify by `slot` from list_disks. This does not erase data; to delete a virtual disk entry use remove_disk.

| Parameter | Required | Definition                                          |
| --------- | -------- | --------------------------------------------------- |
| `slot`    | Yes      | Disk slot to eject, e.g. 'usb1' `{"type":"string"}` |

## remove_disk

**Remove a Virtual Disk Entry** · Risk: **destructive**

Delete a virtual disk entry (`/disk remove [find slot=...]`) — for software RAID arrays, rsync targets, RAM disks and other entries created with add_disk. Verifies the disk exists first. This removes the logical disk (and, for a RAID, breaks the array); it is NOT for formatting a physical drive — use format_disk for that, or eject_disk to safely unplug removable media. Identify by `slot`.

| Parameter | Required | Definition                                      |
| --------- | -------- | ----------------------------------------------- |
| `slot`    | Yes      | Virtual disk slot to remove `{"type":"string"}` |
