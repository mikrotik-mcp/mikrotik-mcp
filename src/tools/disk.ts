/**
 * Storage / disk management — `/disk` (RouterOS 7.8+ storage subsystem).
 *
 * Covers every part of the disk surface: physical drives (NVMe/SATA/USB/eMMC),
 * partitions, filesystems and encryption (format-drive), labels and state (set),
 * software RAID / rsync / RAM virtual disks (add/remove), SMB & NFS sharing
 * (set on the disk entry), and removable-media eject. Disks are identified by
 * their RouterOS `slot` (e.g. `nvme1`, `usb1`, `sata1-part1`). Every tool guards
 * with `commandUnsupported` so a device without disk support degrades to a
 * friendly message instead of a raw error.
 */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import {
  WRITE_IDEMPOTENT,
  WRITE,
  READ,
  DESTRUCTIVE,
  DANGEROUS,
  defineTool,
} from "../core/registry";
import type { ToolModule } from "../core/registry";
import {
  whereClause,
  looksLikeError,
  isEmpty,
  commandUnsupported,
  quoteValue,
  Cmd,
  quoted,
} from "../core/routeros";
import { redactSecrets } from "../utils";

const NOT_AVAILABLE = "Disk management is not available on this device (no `/disk` support).";

/** Allowed RouterOS attribute keys for a virtual-disk `add` (defence-in-depth). */
const ADD_KEYS = new Set([
  "type",
  "slot",
  "raid-type",
  "raid-master",
  "parent",
  "comment",
  "tmpfs-max-size",
  "rsync-target",
  "rsync-export",
  "rsync-username",
  "rsync-password",
  "nfs-server",
  "nfs-export",
]);

export const diskTools: ToolModule = [
  defineTool({
    name: "list_disks",
    title: "List All Attached Disks",
    annotations: READ,
    description:
      "List all storage devices (`/disk print`) attached to the MikroTik — NVMe, SATA/SSD, USB drives, " +
      "eMMC/internal flash, their partitions, plus any RAID/rsync/RAM virtual disks. Use this to discover " +
      "storage and obtain each disk's `slot` (the identifier needed by get_disk, format_disk, set_disk, " +
      "share_disk, eject_disk and remove_disk). Returns slot, type, model/serial, interface, size, free " +
      "space, filesystem, label and mount point. Optionally filter by partial `slot_filter`, `type_filter` " +
      "(e.g. raid, partition, rsync) or `interface_filter` (e.g. nvme, usb, sata). Set `detail=true` for the " +
      "full per-disk property block. For one disk use get_disk.",
    inputSchema: {
      slot_filter: z.string().optional().describe("Partial slot match, e.g. 'usb'"),
      type_filter: z.string().optional().describe("Partial type match, e.g. 'raid', 'partition'"),
      interface_filter: z
        .string()
        .optional()
        .describe("Partial interface match, e.g. 'nvme', 'usb'"),
      detail: z.boolean().default(false).describe("Show the full per-disk property block"),
    },
    async handler(a, ctx) {
      ctx.info("Listing disks");
      const filters: string[] = [];
      if (a.slot_filter) filters.push(`slot~${quoted(a.slot_filter)}`);
      if (a.type_filter) filters.push(`type~${quoted(a.type_filter)}`);
      if (a.interface_filter) filters.push(`interface~${quoted(a.interface_filter)}`);
      const result = await executeMikrotikCommand(
        `/disk print${a.detail ? " detail" : ""}${whereClause(filters)}`,
        ctx,
      );
      if (commandUnsupported(result)) return NOT_AVAILABLE;
      return isEmpty(result) ? "No disks found matching the criteria." : `DISKS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_disk",
    title: "Get Disk Details",
    annotations: READ,
    description:
      "Get full detail for a single disk by slot (`/disk print detail where slot=...`) — its type, filesystem, " +
      "size and free space, label, mount point, partition layout, model/serial/firmware, RAID role, " +
      "SMART status, and any SMB/NFS sharing. Use list_disks to find the slot. To erase/reformat use " +
      "format_disk; to change its label or sharing use set_disk / share_disk.",
    inputSchema: { slot: z.string().describe("Disk slot, e.g. 'nvme1', 'usb1'") },
    async handler(a, ctx) {
      ctx.info(`Getting disk details: slot=${a.slot}`);
      const result = await executeMikrotikCommand(
        `/disk print detail where slot=${quoted(a.slot)}`,
        ctx,
      );
      if (commandUnsupported(result)) return NOT_AVAILABLE;
      return isEmpty(result) ? `Disk '${a.slot}' not found.` : `DISK DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "format_disk",
    title: "Format Disk (Destructive Erase)",
    annotations: DANGEROUS,
    description:
      "Erase and (re)format a disk or partition (`/disk format-drive`) — PERMANENTLY DESTROYS all data on the " +
      "target slot. Use to prepare new storage, change filesystem, repartition, or enable encryption. " +
      "Requires confirm=true. `file_system` picks the filesystem (ext4, exfat, fat32, ntfs). `label` sets the " +
      "volume label. `partition_size` (e.g. '10G') formats only part of the drive (creating a partition) " +
      "instead of the whole device. `encryption` + `encryption_password` create an encrypted volume " +
      "(supply the RouterOS encryption value, e.g. 'aes-cbc'). Identify the disk by `slot` from list_disks. " +
      "For read-only inspection use list_disks / get_disk.",
    inputSchema: {
      slot: z.string().describe("Disk slot to format, e.g. 'usb1'"),
      file_system: z
        .enum(["ext4", "exfat", "fat32", "ntfs"])
        .optional()
        .describe("Filesystem to create (RouterOS can format these)"),
      label: z.string().optional().describe("Volume label"),
      partition_size: z
        .string()
        .optional()
        .describe("Format only this much as a partition, e.g. '10G' (omit = whole drive)"),
      encryption: z
        .string()
        .optional()
        .describe("Encryption algorithm to enable, e.g. 'aes-cbc' (RouterOS value)"),
      encryption_password: z.string().optional().describe("Passphrase when encryption is set"),
      confirm: z.boolean().describe("Must be true to actually ERASE the disk"),
    },
    async handler(a, ctx) {
      ctx.info(`Format disk requested: slot=${a.slot}, confirm=${a.confirm}`);
      if (!a.confirm) return "Format not confirmed. Pass confirm=true to ERASE the disk.";

      const cmd = new Cmd(`/disk format-drive ${quoteValue(a.slot)}`)
        .opt("file-system", a.file_system)
        .opt("label", a.label)
        .opt("partition-size", a.partition_size)
        .opt("encryption", a.encryption)
        .opt("encryption-password", a.encryption_password)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (commandUnsupported(result)) return NOT_AVAILABLE;
      if (looksLikeError(result)) return `Failed to format disk: ${redactSecrets(result)}`;
      return `Formatting disk '${a.slot}'…\n\n${redactSecrets(result)}`;
    },
  }),

  defineTool({
    name: "set_disk",
    title: "Set Disk Properties",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Update a disk's non-destructive properties (`/disk set [find slot=...]`) — set its `label` or `comment`, " +
      "enable/disable it, or assign it to a software RAID array via `raid_master` (the slot of the RAID disk " +
      "created with add_disk) or attach it under a `parent`. Does NOT erase data (use format_disk for that) " +
      "and does NOT configure sharing (use share_disk). Identify by `slot` from list_disks.",
    inputSchema: {
      slot: z.string().describe("Disk slot to modify"),
      label: z.string().optional().describe("Volume / disk label"),
      comment: z.string().optional(),
      raid_master: z.string().optional().describe("Slot of the RAID disk to make this a member of"),
      parent: z.string().optional().describe("Parent disk slot to attach under"),
      disabled: z.boolean().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Setting disk properties: slot=${a.slot}`);
      const cmd = new Cmd(`/disk set [find slot=${quoted(a.slot)}]`)
        .opt("label", a.label)
        .opt("comment", a.comment)
        .opt("raid-master", a.raid_master)
        .opt("parent", a.parent)
        .bool("disabled", a.disabled)
        .build();
      if (cmd.endsWith("]")) return "No updates specified.";

      const result = await executeMikrotikCommand(cmd, ctx);
      if (commandUnsupported(result)) return NOT_AVAILABLE;
      if (looksLikeError(result)) return `Failed to update disk: ${result}`;
      const detail = await executeMikrotikCommand(
        `/disk print detail where slot=${quoted(a.slot)}`,
        ctx,
      );
      return `Disk '${a.slot}' updated.\n\n${detail}`;
    },
  }),

  defineTool({
    name: "share_disk",
    title: "Share a Disk over SMB / NFS",
    annotations: WRITE,
    description:
      "Expose a disk on the network by setting its sharing properties (`/disk set [find slot=...]`) — toggle " +
      "`smb_sharing` (Windows/macOS file sharing) with a `smb_share_name` and allowed `smb_users`, and/or " +
      "`nfs_sharing` for Unix clients. RouterOS serves the share from the disk's mount point. The SMB/NFS " +
      "server must be enabled on the device. Pass smb_sharing=false / nfs_sharing=false to stop sharing. " +
      "Identify the disk by `slot` from list_disks.",
    inputSchema: {
      slot: z.string().describe("Disk slot to share"),
      smb_sharing: z.boolean().optional().describe("Enable/disable SMB (CIFS) sharing"),
      smb_share_name: z.string().optional().describe("SMB share name shown to clients"),
      smb_users: z
        .string()
        .optional()
        .describe("Comma-separated SMB users allowed to access the share"),
      nfs_sharing: z.boolean().optional().describe("Enable/disable NFS sharing"),
    },
    async handler(a, ctx) {
      ctx.info(`Configuring disk sharing: slot=${a.slot}`);
      const cmd = new Cmd(`/disk set [find slot=${quoted(a.slot)}]`)
        .bool("smb-sharing", a.smb_sharing)
        .opt("smb-share-name", a.smb_share_name)
        .opt("smb-users", a.smb_users)
        .bool("nfs-sharing", a.nfs_sharing)
        .build();
      if (cmd.endsWith("]")) return "No sharing settings specified.";

      const result = await executeMikrotikCommand(cmd, ctx);
      if (commandUnsupported(result)) return NOT_AVAILABLE;
      if (looksLikeError(result)) return `Failed to configure disk sharing: ${result}`;
      const detail = await executeMikrotikCommand(
        `/disk print detail where slot=${quoted(a.slot)}`,
        ctx,
      );
      return `Sharing for disk '${a.slot}' updated.\n\n${detail}`;
    },
  }),

  defineTool({
    name: "add_disk",
    title: "Add a Virtual Disk (RAID / rsync / RAM)",
    annotations: WRITE,
    description:
      "Create a virtual disk (`/disk add`). Use `type` to pick the kind: `raid` (software RAID array — set " +
      "`raid_type` such as raid0/raid1/raid5/raid6/raid10, then add member drives with set_disk raid_master=" +
      "<new slot>), `rsync` (a network rsync backup target), or `tmpfs` (a RAM disk — set `tmpfs_max_size`, " +
      "e.g. '256M'). Optionally name the new disk via `slot`. `properties` passes any additional RouterOS " +
      "attribute=value pairs for the chosen type (e.g. rsync-target, nfs-server). Requires RouterOS 7.x with " +
      "disk/RAID support. To delete a virtual disk use remove_disk.",
    inputSchema: {
      type: z.string().describe("Virtual disk type: 'raid', 'rsync', 'tmpfs', 'encrypted', …"),
      slot: z.string().optional().describe("Name/slot for the new virtual disk"),
      raid_type: z.string().optional().describe("For type=raid, e.g. 'raid1', 'raid5'"),
      tmpfs_max_size: z.string().optional().describe("For type=tmpfs, e.g. '256M'"),
      comment: z.string().optional(),
      properties: z
        .record(z.string(), z.string())
        .optional()
        .describe("Extra RouterOS attribute=value pairs for this disk type"),
    },
    async handler(a, ctx) {
      ctx.info(`Adding virtual disk: type=${a.type}`);
      const cmd = new Cmd("/disk add")
        .set("type", a.type)
        .opt("slot", a.slot)
        .opt("raid-type", a.raid_type)
        .opt("tmpfs-max-size", a.tmpfs_max_size)
        .opt("comment", a.comment);
      // Only whitelisted attribute keys may be passed through.
      const extra: Record<string, string> = a.properties ?? {};
      for (const [k, v] of Object.entries(extra)) {
        if (ADD_KEYS.has(k) && v !== "") cmd.set(k, v);
      }
      const built = cmd.build();
      const result = await executeMikrotikCommand(built, ctx);
      if (commandUnsupported(result)) return NOT_AVAILABLE;
      if (looksLikeError(result)) return `Failed to add virtual disk: ${redactSecrets(result)}`;
      return `Virtual disk (type=${a.type}) added.\n\n${redactSecrets(result)}`;
    },
  }),

  defineTool({
    name: "eject_disk",
    title: "Eject Removable Disk",
    annotations: WRITE,
    description:
      "Safely eject / unmount a removable disk (`/disk eject`) so it can be physically unplugged without data " +
      "loss — flushes caches and unmounts the device. Use for USB drives and other hot-pluggable media before " +
      "removal. Identify by `slot` from list_disks. This does not erase data; to delete a virtual disk entry " +
      "use remove_disk.",
    inputSchema: { slot: z.string().describe("Disk slot to eject, e.g. 'usb1'") },
    async handler(a, ctx) {
      ctx.info(`Ejecting disk: slot=${a.slot}`);
      const count = await executeMikrotikCommand(
        `/disk print count-only where slot=${quoted(a.slot)}`,
        ctx,
      );
      if (commandUnsupported(count)) return NOT_AVAILABLE;
      if (count.trim() === "0") return `Disk '${a.slot}' not found.`;
      const result = await executeMikrotikCommand(`/disk eject [find slot=${quoted(a.slot)}]`, ctx);
      if (commandUnsupported(result)) return NOT_AVAILABLE;
      if (looksLikeError(result)) return `Failed to eject disk: ${result}`;
      return `Disk '${a.slot}' ejected — safe to remove.`;
    },
  }),

  defineTool({
    name: "remove_disk",
    title: "Remove a Virtual Disk Entry",
    annotations: DESTRUCTIVE,
    description:
      "Delete a virtual disk entry (`/disk remove [find slot=...]`) — for software RAID arrays, rsync targets, " +
      "RAM disks and other entries created with add_disk. Verifies the disk exists first. This removes the " +
      "logical disk (and, for a RAID, breaks the array); it is NOT for formatting a physical drive — use " +
      "format_disk for that, or eject_disk to safely unplug removable media. Identify by `slot`.",
    inputSchema: { slot: z.string().describe("Virtual disk slot to remove") },
    async handler(a, ctx) {
      ctx.info(`Removing virtual disk: slot=${a.slot}`);
      const count = await executeMikrotikCommand(
        `/disk print count-only where slot=${quoted(a.slot)}`,
        ctx,
      );
      if (commandUnsupported(count)) return NOT_AVAILABLE;
      if (count.trim() === "0") return `Disk '${a.slot}' not found.`;
      const result = await executeMikrotikCommand(
        `/disk remove [find slot=${quoted(a.slot)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove disk: ${result}`;
      return `Disk '${a.slot}' removed.`;
    },
  }),
];
