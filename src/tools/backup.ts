/**
 * Backup, export, and file management — `/system backup`, `/export`, `/file`.
 *
 * Covers creating/restoring system backups, generating configuration exports,
 * importing scripts, and moving files on and off the device filesystem.
 */
import { z } from "zod";
import { checkDiskSpace } from "../backups/disk-check";
import { backupDir, writeBinaryBackup, writeBackup } from "../backups/vault";
import {
  downloadFileFromDevice,
  executeMikrotikCommand,
  uploadFileToDevice,
} from "../core/connector";
import { deviceDateStamp } from "../core/datestamp";
import { WRITE, READ, defineTool, DANGEROUS } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { Cmd, isEmpty, looksLikeError, quoted, quoteValue, menuPath } from "../core/routeros";
import { getDevice, resolveDeviceName } from "../core/runtime";
import { deviceSlug } from "../core/slug";
import { isMacTelnetDevice } from "../core/transport";

export const backupTools: ToolModule = [
  defineTool({
    name: "create_backup",
    title: "Create System Backup",
    annotations: WRITE,
    description:
      "Creates a binary system backup (`/system backup save`) — a full encrypted snapshot of all" +
      " device configuration, suitable for disaster recovery and full-config restore. Unlike" +
      " `create_export` or `export_section` which produce human-readable text files, this produces" +
      " an opaque `.backup` binary that can only be applied via `restore_backup`. Name defaults to" +
      " `backup_<device-datetime>` if omitted; `dont_encrypt=true` skips encryption;" +
      " `include_password=false` omits credentials from the snapshot. Returns file details of the" +
      " created `.backup` file on success.",
    inputSchema: {
      name: z.string().optional(),
      dont_encrypt: z.boolean().default(false),
      include_password: z.boolean().default(true),
      comment: z.string().optional(),
    },
    async handler(a, ctx) {
      // Default name uses the DEVICE's local date-time (Jalali in Tehran, else
      // Gregorian) — not the MCP host clock — so the filename matches the router.
      const name = a.name || `backup_${await deviceDateStamp(ctx)}`;
      ctx.info(`Creating backup: name=${name}`);

      const disk = await checkDiskSpace(ctx);

      const cmd = new Cmd("/system backup save").set("name", name);
      if (a.dont_encrypt) cmd.raw("dont-encrypt=yes");
      else cmd.set("password", ""); // Empty password for encryption
      if (!a.include_password) cmd.raw("password-file=no");

      const result = await executeMikrotikCommand(cmd.build(), ctx);

      if (!(result.includes("saved") || result.trim() === "")) {
        if (disk.low) {
          return (
            `Failed to create backup (device disk is ${disk.usedPct?.toFixed(0)}% used): ${result}\n\n` +
            "Tip: use create_local_backup or create_export instead — text exports can be captured " +
            "directly to the local vault without using any device disk space."
          );
        }
        return `Failed to create backup: ${result}`;
      }

      // Backup created on device. If disk is low, download it to the local vault
      // over SFTP and remove from the device to free space. The SSH user needs the
      // `read` (and `sensitive` for .backup files) policy for SFTP downloads to work.
      if (disk.low) {
        const dc = getDevice(ctx.device);
        if (isMacTelnetDevice(dc)) {
          // MAC-Telnet has no SFTP — leave the file on device with a warning.
          return (
            `Backup '${name}.backup' created on device, but disk is ${disk.usedPct?.toFixed(0)}% used. ` +
            "This is a MAC-Telnet device (no SFTP), so the file cannot be downloaded automatically. " +
            "Free disk space manually or use create_local_backup for a text export that bypasses device storage."
          );
        }
        const deviceFile = `${name}.backup`;
        try {
          ctx.info(`Low disk (${disk.usedPct?.toFixed(0)}%) — downloading backup to local vault`);
          const data = await downloadFileFromDevice(ctx.device, deviceFile);
          const device = resolveDeviceName(ctx.device);
          const vaultName = writeBinaryBackup(`${deviceSlug(device)}_${deviceFile}`, data);
          // Remove the file from the device to free space.
          await executeMikrotikCommand(`/file remove ${deviceFile}`, ctx);
          return (
            `[LOW DISK — ${disk.usedPct?.toFixed(0)}% used] Backup '${deviceFile}' created, downloaded to ` +
            `local vault as '${vaultName}' (${data.length} bytes) at ${backupDir()}, and removed from ` +
            "the device to free disk space."
          );
        } catch (e) {
          // Download/cleanup failed — the backup is still on device. A common cause
          // is the SSH user missing the `read` or `sensitive` policy on RouterOS.
          return (
            `Backup '${name}.backup' created on device, but the automatic download-and-cleanup ` +
            `failed: ${e instanceof Error ? e.message : String(e)}. The file is still on the device. ` +
            "Ensure the SSH user has the 'read' and 'sensitive' policies for SFTP downloads to work."
          );
        }
      }

      const fileDetails = await executeMikrotikCommand(
        `/file print detail where name=${quoteValue(`${name}.backup`)}`,
        ctx,
      );
      return fileDetails
        ? `Backup created successfully:\n\n${fileDetails}`
        : `Backup '${name}.backup' created successfully.`;
    },
  }),

  defineTool({
    name: "list_backups",
    title: "List Backup Files",
    annotations: READ,
    description:
      "Lists `.backup` binary files on the device filesystem (`/file print where type=backup`)." +
      " By default shows only binary backup files; set `include_exports=true` to also include" +
      " `.rsc` script files. Filter by name substring with `name_filter`. For detailed metadata on" +
      " a specific file use `backup_info`. Returns a table of matching files or a not-found message.",
    inputSchema: {
      name_filter: z.string().optional(),
      include_exports: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Listing backups with filter: name=${a.name_filter}`);

      let cmd = "/file print where type=backup";
      if (a.include_exports) cmd = "/file print where (type=backup or type=script)";

      if (a.name_filter) {
        if (a.include_exports) {
          cmd = `/file print where (type=backup or type=script) and name~${quoted(a.name_filter)}`;
        } else {
          cmd = `/file print where type=backup and name~${quoted(a.name_filter)}`;
        }
      }

      const result = await executeMikrotikCommand(cmd, ctx);
      if (isEmpty(result)) return "No backup files found.";
      return `BACKUP FILES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "create_export",
    title: "Create Full Configuration Export",
    annotations: READ,
    description:
      "Exports the complete device configuration to a `.rsc` plain-text script file (`/export" +
      " file=<name>`), re-applicable via `import_configuration`. Unlike `create_backup`, the result" +
      " is human-readable plain text — not a binary snapshot — and passwords are hidden by default" +
      " (`hide_sensitive=true`). `file_format` changes only the file extension used when looking up" +
      " the saved file — no `format=` flag is ever sent to RouterOS, so the content is always" +
      " RouterOS script text regardless of the chosen extension; selecting `json` or `xml` will also" +
      " cause the post-export file lookup to fail because RouterOS saves the file as `.rsc`." +
      " ALWAYS default to a FULL configuration export: leave `compact` and `verbose` off (the plain" +
      " full export) unless the user explicitly asks for less or more. Set `compact` ONLY when the" +
      " user wants a smaller diff that omits default values, or `verbose` ONLY when they want every" +
      " parameter (including defaults). `export_type` only controls where the `file=` argument is" +
      " positioned in the command and does not independently drive compactness or verbosity. For a" +
      " single subsection only use `export_section`. Returns file details of the created export file.",
    inputSchema: {
      name: z.string().optional(),
      file_format: z.enum(["rsc", "json", "xml"]).default("rsc"),
      export_type: z.enum(["full", "compact", "verbose"]).default("full"),
      hide_sensitive: z.boolean().default(true),
      verbose: z.boolean().default(false),
      compact: z.boolean().default(false),
      comment: z.string().optional(),
    },
    async handler(a, ctx) {
      const name = a.name || `export_${await deviceDateStamp(ctx)}`;
      ctx.info(`Creating export: name=${name}, format=${a.file_format}`);

      const disk = await checkDiskSpace(ctx);

      // When disk is low, capture stdout (no file= arg) and save to local vault.
      if (disk.low) {
        ctx.info(`Low disk (${disk.usedPct?.toFixed(0)}%) — redirecting export to local vault`);
        const cmd = new Cmd("/export");
        cmd.raw(a.verbose ? "verbose" : null);
        cmd.raw(a.compact ? "compact" : null);
        cmd.raw(!a.hide_sensitive ? "show-sensitive" : null);
        // No file= parameter — output goes to stdout.
        const body = await executeMikrotikCommand(cmd.build(), ctx);
        if (isEmpty(body) || looksLikeError(body)) {
          return `Failed to create export: ${body}`;
        }
        const device = resolveDeviceName(ctx.device);
        const vaultName = writeBackup(`${deviceSlug(device)}_${name}.rsc`, body);
        return (
          `[LOW DISK — ${disk.usedPct?.toFixed(0)}% used] Export saved to LOCAL VAULT as '${vaultName}' ` +
          `(${Buffer.byteLength(body)} bytes) at ${backupDir()} — no file was written to the device.`
        );
      }

      // Determine file extension based on format
      const extension = a.file_format === "json" || a.file_format === "xml" ? a.file_format : "rsc";
      const fullName = `${name}.${extension}`;

      const cmd = new Cmd("/export");
      if (a.export_type === "full") cmd.set("file", name);
      cmd.raw(a.verbose ? "verbose" : null);
      cmd.raw(a.compact ? "compact" : null);
      cmd.raw(!a.hide_sensitive ? "show-sensitive" : null);
      if (a.export_type !== "full") cmd.set("file", name);

      const result = await executeMikrotikCommand(cmd.build(), ctx);

      if (result.trim() === "" || !result.toLowerCase().includes("failure:")) {
        const fileDetails = await executeMikrotikCommand(
          `/file print detail where name=${quoteValue(fullName)}`,
          ctx,
        );
        return fileDetails
          ? `Export created successfully:\n\n${fileDetails}`
          : `Export '${fullName}' created successfully.`;
      }
      return `Failed to create export: ${result}`;
    },
  }),

  defineTool({
    name: "export_section",
    title: "Export Configuration Section",
    annotations: READ,
    description:
      "Exports one RouterOS subsection to a `.rsc` script file (`/<section> export file=<name>`)." +
      " Use when you need only a partial config snapshot rather than the full device export." +
      " `section` is the RouterOS command path without a leading slash —" +
      ' e.g. "ip address", "interface vlan", "ip firewall filter", "ip firewall nat",' +
      ' "queue simple". For the full device configuration use `create_export`; to apply the' +
      " resulting file use `import_configuration`. Returns file details of the created `.rsc` file.",
    inputSchema: {
      section: z.string(),
      name: z.string().optional(),
      hide_sensitive: z.boolean().default(true),
      compact: z.boolean().default(false),
    },
    async handler(a, ctx) {
      let name = a.name;
      if (!name) {
        const cleanSection = a.section.replace(/ /g, "_").replace(/\//g, "_");
        name = `export_${cleanSection}_${await deviceDateStamp(ctx)}`;
      }

      ctx.info(`Exporting section: section=${a.section}, name=${name}`);

      const disk = await checkDiskSpace(ctx);

      // When disk is low, capture stdout (no file= arg) and save to local vault.
      if (disk.low) {
        ctx.info(
          `Low disk (${disk.usedPct?.toFixed(0)}%) — redirecting section export to local vault`,
        );
        const cmd = new Cmd(`/${menuPath(a.section)} export`);
        cmd.raw(!a.hide_sensitive ? "show-sensitive" : null);
        cmd.raw(a.compact ? "compact" : null);
        // No file= parameter — output goes to stdout.
        const body = await executeMikrotikCommand(cmd.build(), ctx);
        if (isEmpty(body) || looksLikeError(body)) {
          return `Failed to export section: ${body}`;
        }
        const device = resolveDeviceName(ctx.device);
        const vaultName = writeBackup(`${deviceSlug(device)}_${name}.rsc`, body);
        return (
          `[LOW DISK — ${disk.usedPct?.toFixed(0)}% used] Section export saved to LOCAL VAULT as ` +
          `'${vaultName}' (${Buffer.byteLength(body)} bytes) at ${backupDir()} — no file was written ` +
          "to the device."
        );
      }

      const cmd = new Cmd(`/${menuPath(a.section)} export`).set("file", name);
      cmd.raw(!a.hide_sensitive ? "show-sensitive" : null);
      cmd.raw(a.compact ? "compact" : null);

      const result = await executeMikrotikCommand(cmd.build(), ctx);

      if (result.trim() === "" || !result.toLowerCase().includes("failure:")) {
        const fileDetails = await executeMikrotikCommand(
          `/file print detail where name=${quoteValue(`${name}.rsc`)}`,
          ctx,
        );
        return fileDetails
          ? `Section export created successfully:\n\n${fileDetails}`
          : `Section export '${name}.rsc' created successfully.`;
      }
      return `Failed to export section: ${result}`;
    },
  }),

  defineTool({
    name: "download_file",
    title: "Download File from Device",
    annotations: READ,
    description:
      "Downloads a file from the device filesystem over SFTP and returns its raw bytes base64-encoded" +
      " as `FILE_CONTENT_BASE64:<data>`. Works for any file type — `.backup`, `.rsc`, `.p12`" +
      " certificates, keys, etc. Verifies file existence first (`/file print count-only`). The SSH" +
      " user MUST have the `read` policy (and `sensitive` for `.backup` / certificate files) on" +
      " RouterOS for SFTP downloads to work. NOT available on MAC-Telnet devices (Layer-2 has no" +
      " file transfer). To list available files use `list_backups`; for file metadata use" +
      " `backup_info`; to push a file onto the device use `upload_file`.",
    inputSchema: {
      filename: z
        .string()
        .describe("Name of the file on the device, e.g. 'cert.p12' or 'backup.backup'"),
    },
    async handler(a, ctx) {
      ctx.info(`Downloading file: filename=${a.filename}`);

      // Verify file exists on device before attempting SFTP download.
      const count = await executeMikrotikCommand(
        `/file print count-only where name=${quoteValue(a.filename)}`,
        ctx,
      );
      if (count.trim() === "0") return `File '${a.filename}' not found on the device.`;

      try {
        const data = await downloadFileFromDevice(ctx.device, a.filename);
        const encoded = data.toString("base64");
        return `FILE_CONTENT_BASE64:${encoded}`;
      } catch (e) {
        return (
          `Failed to download '${a.filename}': ${e instanceof Error ? e.message : String(e)}. ` +
          "Ensure the SSH user has the 'read' and 'sensitive' policies on RouterOS."
        );
      }
    },
  }),

  defineTool({
    name: "upload_file",
    title: "Upload File to Device",
    annotations: WRITE,
    description:
      "Transfer a file to the device filesystem over SFTP (the file subsystem RouterOS exposes on its SSH" +
      " server) — this actually pushes the bytes, then verifies the file appears in `/file`. Use it to put" +
      " a file on the router before another tool can use it: a `.rsc` config script (then apply with" +
      " `import_configuration`), a `.backup` file (then `restore_backup`), or a certificate/key (then" +
      " `import_certificate`). `filename` is the DESTINATION path on the device — root by default" +
      " (e.g. `config.rsc`), or an external-disk path (e.g. `disk1/cert.pem`). `content_base64` is the file's" +
      " raw bytes, base64-encoded (binary-safe — works for `.backup`/cert files, not just text). Overwrites" +
      " any existing file of the same name. NOT available on MAC-Telnet devices (Layer-2 has no file" +
      " transfer) — there, have the router pull the file itself with `/tool fetch` from a reachable URL.",
    inputSchema: {
      filename: z
        .string()
        .describe("Destination path on the device, e.g. 'config.rsc' or 'disk1/cert.pem'"),
      content_base64: z.string().describe("File bytes, base64-encoded (binary-safe)"),
    },
    async handler(a, ctx) {
      ctx.info(`Uploading file: filename=${a.filename}`);
      const data = Buffer.from(a.content_base64, "base64");
      if (data.length === 0) {
        return "Nothing to upload: content_base64 is empty or decoded to 0 bytes.";
      }

      try {
        await uploadFileToDevice(ctx.device, a.filename, data);
      } catch (e) {
        return `Failed to upload '${a.filename}': ${e instanceof Error ? e.message : String(e)}`;
      }

      // Confirm the bytes landed: a successful SFTP write should surface the file
      // in /file by the same name (RouterOS lists uploaded files there).
      const verify = await executeMikrotikCommand(
        `/file print count-only where name=${quoted(a.filename)}`,
        ctx,
      );
      if (verify.trim() === "0") {
        return (
          `File '${a.filename}' was transferred (${data.length} bytes) but did not appear in /file under ` +
          "that exact name — RouterOS may have stored it at a slightly different path. Run list_files to " +
          "confirm, then apply it (import_configuration / restore_backup / import_certificate)."
        );
      }
      return (
        `File '${a.filename}' uploaded successfully (${data.length} bytes) and is now in /file. Apply it: ` +
        "import_configuration for a `.rsc`, restore_backup for a `.backup`, or import_certificate for a cert."
      );
    },
  }),

  defineTool({
    name: "restore_backup",
    title: "Restore System Backup",
    annotations: DANGEROUS,
    description:
      "Loads a `.backup` file from the device filesystem and replaces the running configuration" +
      " (`/system backup load`). DANGEROUS: the device REBOOTS immediately — all current config is" +
      " replaced with the snapshot. Verifies file existence first (`/file print count-only`)." +
      " Provide `password` if the backup was created with encryption. For applying a text `.rsc`" +
      " script without rebooting use `import_configuration`; to create a new backup first use" +
      " `create_backup`.",
    inputSchema: {
      filename: z.string(),
      password: z.string().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Restoring backup: filename=${a.filename}`);

      const count = await executeMikrotikCommand(
        `/file print count-only where name=${quoteValue(a.filename)}`,
        ctx,
      );
      if (count.trim() === "0") return `Backup file '${a.filename}' not found.`;

      const cmd = new Cmd("/system backup load")
        .set("name", a.filename)
        .opt("password", a.password)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);

      if (result.includes("Restoring system configuration") || result.trim() === "") {
        return `Backup '${a.filename}' restored successfully. System will reboot.`;
      }
      return `Failed to restore backup: ${result}`;
    },
  }),

  defineTool({
    name: "import_configuration",
    title: "Import RouterOS Configuration Script",
    annotations: DANGEROUS,
    description:
      "Executes a `.rsc` script file already on the device filesystem (`/import file=<filename>`)." +
      " Use to apply a configuration exported by `create_export` or `export_section`. DANGEROUS:" +
      " the script's commands run immediately and can overwrite live configuration; unlike" +
      " `restore_backup` no reboot is triggered. `run_after_reset=true` defers execution until" +
      " after the next factory-reset; `verbose=true` logs each command as it runs. Returns the" +
      " script execution output or a success message.",
    inputSchema: {
      filename: z.string(),
      run_after_reset: z.boolean().default(false),
      verbose: z.boolean().default(false),
    },
    async handler(a, ctx) {
      ctx.info(`Importing configuration: filename=${a.filename}`);

      const count = await executeMikrotikCommand(
        `/file print count-only where name=${quoteValue(a.filename)}`,
        ctx,
      );
      if (count.trim() === "0") return `Configuration file '${a.filename}' not found.`;

      const cmd = new Cmd("/import")
        .set("file", a.filename)
        .flag("run-after-reset", a.run_after_reset)
        .flag("verbose", a.verbose)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);

      if (result.trim() === "" || result.includes("Script file loaded and executed successfully")) {
        return `Configuration '${a.filename}' imported successfully.`;
      }
      return `Import result:\n${result}`;
    },
  }),

  defineTool({
    name: "remove_file",
    title: "Remove File from Device",
    annotations: DANGEROUS,
    description:
      "Permanently deletes a named file from the device filesystem (`/file remove <filename>`)." +
      " DANGEROUS: deletion is immediate and irreversible — applies to any file type (`.backup`," +
      " `.rsc`, logs, etc.). Verifies existence first via `/file print count-only`; returns" +
      " success or a not-found message.",
    inputSchema: {
      filename: z.string(),
    },
    async handler(a, ctx) {
      ctx.info(`Removing file: filename=${a.filename}`);

      const count = await executeMikrotikCommand(
        `/file print count-only where name=${quoteValue(a.filename)}`,
        ctx,
      );
      if (count.trim() === "0") return `File '${a.filename}' not found.`;

      const result = await executeMikrotikCommand(`/file remove ${quoteValue(a.filename)}`, ctx);

      if (result.trim() === "") return `File '${a.filename}' removed successfully.`;
      return `Failed to remove file: ${result}`;
    },
  }),

  defineTool({
    name: "backup_info",
    title: "Get Backup File Details",
    annotations: READ,
    description:
      "Returns detailed metadata for a specific file on the device filesystem" +
      " (`/file print detail where name=<filename>`). Shows size, creation time, type, and other" +
      " file attributes. For scanning all backup files use `list_backups`; to retrieve the file" +
      " contents use `download_file`.",
    inputSchema: {
      filename: z.string(),
    },
    async handler(a, ctx) {
      ctx.info(`Getting backup info: filename=${a.filename}`);

      const result = await executeMikrotikCommand(
        `/file print detail where name=${quoteValue(a.filename)}`,
        ctx,
      );
      if (isEmpty(result)) return `Backup file '${a.filename}' not found.`;
      return `BACKUP FILE DETAILS:\n\n${result}`;
    },
  }),
];
