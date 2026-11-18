/**
 * S3 backup transfer — optional, opt-in.
 *
 * Moves backup/export files between the device and an S3-compatible bucket.
 * The actual byte transfer is performed by the device's own `/tool fetch`
 * against a short-lived presigned URL (so large/binary backups stream straight
 * from the router to S3 without passing through this process), while the Bun
 * native S3 client handles presigning, listing, stat and deletion server-side.
 *
 * Every tool degrades gracefully: if S3 is not configured they return a clear
 * message instead of failing.
 */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { deviceDateStamp } from "../core/datestamp";
import { WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { looksLikeError, Cmd, quoteValue } from "../core/routeros";
import { resolveDeviceName } from "../core/runtime";
import {
  s3Target,
  s3Key,
  s3DevicePrefix,
  presignExpiresIn,
  isS3Configured,
  getS3Client,
} from "../core/s3";

const NOT_CONFIGURED =
  "S3 is not configured. Set S3_* (or AWS_*) environment variables, or add an " +
  '"s3" block to the JSON config file, to enable S3 backup transfer.';

/** RouterOS `/tool fetch` reports `status: finished` on success. */
function fetchSucceeded(output: string): boolean {
  return /status:\s*finished/i.test(output);
}

export const s3BackupTools: ToolModule = [
  defineTool({
    name: "s3_backup_status",
    title: "Check S3 Backup Configuration Status",
    annotations: READ,
    description:
      "Report whether S3 backup storage is enabled and show the configured " +
      "target bucket/endpoint (MCP-side check only — no RouterOS command is " +
      "executed). Use this to verify the S3 integration is active before " +
      "attempting uploads or downloads; if disabled, the response includes the " +
      "required environment variables / config block. " +
      "For uploading a device file to S3 use upload_backup_to_s3; for listing " +
      "stored objects use list_s3_backups. " +
      "Returns 'ENABLED' with the target endpoint, or 'DISABLED' with setup " +
      "instructions.",
    async handler(_a, ctx) {
      ctx.info("Checking S3 backup status");
      if (!isS3Configured()) return `S3 backup storage is DISABLED.\n\n${NOT_CONFIGURED}`;
      return `S3 backup storage is ENABLED.\n\nTarget: ${s3Target()}`;
    },
  }),

  defineTool({
    name: "upload_backup_to_s3",
    title: "Upload Device Backup File to S3",
    annotations: WRITE,
    description:
      "Upload a file from the RouterOS device filesystem to the configured " +
      "S3-compatible bucket (`/tool fetch` with `http-method=put` via a " +
      "server-side presigned PUT URL). Solves the problem of pushing `.backup` " +
      "or `.rsc` export files from the router to cloud storage without routing " +
      "bytes through this MCP process — the device streams directly to S3. " +
      "First verifies the file exists on the device via `/file print count-only`; " +
      "fails clearly if S3 is not configured. " +
      "For downloading a stored object back to the device use " +
      "download_backup_from_s3; for listing what is already in S3 use " +
      "list_s3_backups; to check S3 is configured use s3_backup_status.\n\n" +
      "Notes:\n" +
      "    filename: the on-device filename, e.g. 'daily.backup'.\n" +
      "    key: optional S3 object key; defaults to '<prefix>/<device>/" +
      "<device-datetime>-<filename>' stamped with the DEVICE's local date-time " +
      "(Jalali calendar in Tehran, Gregorian elsewhere) so repeat uploads " +
      "version automatically instead of overwriting.\n" +
      "    expires_in: presigned-URL lifetime in seconds (minimum 60).\n" +
      "Returns the final S3 key and target endpoint on success.",
    inputSchema: {
      filename: z.string().describe("File on the device, e.g. 'daily.backup'"),
      key: z
        .string()
        .optional()
        .describe("S3 object key (defaults to prefix + device-local datetime + filename)"),
      expires_in: z.number().int().min(60).optional().describe("Presigned-URL lifetime in seconds"),
    },
    async handler(a, ctx) {
      if (!isS3Configured()) return NOT_CONFIGURED;
      const key =
        a.key ??
        s3Key(`${await deviceDateStamp(ctx)}-${a.filename}`, resolveDeviceName(ctx.device));
      ctx.info(`Uploading '${a.filename}' to S3 key '${key}'`);

      // Ensure the source file exists on the device first.
      const count = await executeMikrotikCommand(
        `/file print count-only where name=${quoteValue(a.filename)}`,
        ctx,
      );
      if (count.trim() === "0") return `File '${a.filename}' not found on the device.`;

      let url: string;
      try {
        url = getS3Client().presign(key, {
          method: "PUT",
          expiresIn: a.expires_in ?? presignExpiresIn(),
        });
      } catch (e) {
        return `Failed to presign S3 upload URL: ${e instanceof Error ? e.message : String(e)}`;
      }

      // The device PUTs the file body directly to the presigned URL. NOTE: do
      // NOT pass `mode=` here — a full `url=` already implies the scheme, and
      // adding `mode` flips RouterOS into its legacy address/src-path parsing
      // where `src-path` is read as a *remote* path, colliding with the URL's
      // path ("failure: Conflicting remote paths provided in URI and parameter").
      // With url + http-method=put, `src-path` is correctly the local source file.
      const cmd = new Cmd("/tool fetch")
        .set("url", url)
        .set("http-method", "put")
        .set("src-path", a.filename)
        .set("output", "none")
        .build();
      const result = await executeMikrotikCommand(cmd, ctx);

      if (looksLikeError(result) || !fetchSucceeded(result))
        return `Failed to upload '${a.filename}' to S3 (key '${key}'):\n\n${result}`;
      return `Uploaded '${a.filename}' to S3 key '${key}' (${s3Target()}).`;
    },
  }),

  defineTool({
    name: "download_backup_from_s3",
    title: "Download S3 Backup File to Device",
    annotations: WRITE,
    description:
      "Download an object from the configured S3 bucket onto the RouterOS " +
      "device filesystem (`/tool fetch` via a server-side presigned GET URL). " +
      "Use this to stage a previously uploaded backup or export onto the router " +
      "before restoring it — bytes stream directly from S3 to the device without " +
      "passing through this MCP process. " +
      "For uploading a device file to S3 use upload_backup_to_s3; to find " +
      "available object keys use list_s3_backups; to inspect a key's metadata " +
      "before downloading use s3_backup_info.\n\n" +
      "Notes:\n" +
      "    key: the exact S3 object key to download (get it from list_s3_backups).\n" +
      "    filename: optional device destination path; defaults to the key's " +
      "basename.\n" +
      "    expires_in: presigned-URL lifetime in seconds (minimum 60).\n" +
      "Returns the S3 key and device filename on success.",
    inputSchema: {
      key: z.string().describe("S3 object key to download"),
      filename: z
        .string()
        .optional()
        .describe("Device destination filename (defaults to the key basename)"),
      expires_in: z.number().int().min(60).optional().describe("Presigned-URL lifetime in seconds"),
    },
    async handler(a, ctx) {
      if (!isS3Configured()) return NOT_CONFIGURED;
      const filename = a.filename ?? a.key.split("/").pop() ?? a.key;
      ctx.info(`Downloading S3 key '${a.key}' to device file '${filename}'`);

      let url: string;
      try {
        url = getS3Client().presign(a.key, {
          method: "GET",
          expiresIn: a.expires_in ?? presignExpiresIn(),
        });
      } catch (e) {
        return `Failed to presign S3 download URL: ${e instanceof Error ? e.message : String(e)}`;
      }

      // No `mode=`: the full `url=` already implies the scheme (passing a
      // conflicting/redundant mode triggers RouterOS "Conflicting ... in URI and
      // parameter"). `dst-path` is the local destination on the device.
      const cmd = new Cmd("/tool fetch").set("url", url).set("dst-path", filename).build();
      const result = await executeMikrotikCommand(cmd, ctx);

      if (looksLikeError(result) || !fetchSucceeded(result))
        return `Failed to download S3 key '${a.key}' to '${filename}':\n\n${result}`;
      return `Downloaded S3 key '${a.key}' to device file '${filename}'.`;
    },
  }),

  defineTool({
    name: "list_s3_backups",
    title: "List S3 Backup Objects",
    annotations: READ,
    description:
      "List objects in the configured S3 bucket (MCP-side `S3.list()` call — " +
      "no RouterOS command is executed). Use this to discover available backup " +
      "keys before downloading or deleting. By default scopes to this device's " +
      "prefix (`<prefix>/<device>/`); pass an explicit `prefix` (including `''` " +
      "for the entire bucket) to list backups for all devices or arbitrary paths. " +
      "For metadata on a specific key use s3_backup_info; to download a key to " +
      "the device use download_backup_from_s3; to delete a key use " +
      "delete_s3_backup; to upload a new file use upload_backup_to_s3. " +
      "Returns each object's key, size in bytes, and last-modified timestamp " +
      "(up to `max_keys`, 1–1000); indicates if results are truncated.",
    inputSchema: {
      prefix: z
        .string()
        .optional()
        .describe("Key prefix to list under (defaults to this device's '<prefix>/<device>/')"),
      max_keys: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(100)
        .describe("Maximum number of objects to return (1-1000)"),
    },
    async handler(a, ctx) {
      if (!isS3Configured()) return NOT_CONFIGURED;
      const prefix = a.prefix ?? s3DevicePrefix(resolveDeviceName(ctx.device));
      ctx.info(`Listing S3 objects (prefix='${prefix}')`);
      try {
        const res = await getS3Client().list({
          prefix: prefix || undefined,
          maxKeys: a.max_keys,
        });
        const items = res.contents ?? [];
        if (items.length === 0) return "No S3 objects found matching the criteria.";
        const lines = items.map(
          (o) => `${o.key}  (${o.size ?? "?"} bytes, modified ${o.lastModified ?? "?"})`,
        );
        const more = res.isTruncated ? "\n\n(more results available)" : "";
        return `S3 OBJECTS (${s3Target()}):\n\n${lines.join("\n")}${more}`;
      } catch (e) {
        return `Failed to list S3 objects: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  }),

  defineTool({
    name: "s3_backup_info",
    title: "Get S3 Backup Object Metadata",
    annotations: READ,
    description:
      "Retrieve metadata for a single S3 object (`S3.stat()` server-side — no " +
      "RouterOS command is executed): size in bytes, content-type, ETag, and " +
      "last-modified timestamp. Use this to verify an upload completed correctly " +
      "or to inspect a backup before downloading it. " +
      "To list all available keys first use list_s3_backups; to download the " +
      "object to the device use download_backup_from_s3; to delete it use " +
      "delete_s3_backup. " +
      "`key` is the exact S3 object key as returned by list_s3_backups. " +
      "Returns 'not found' if the key does not exist.",
    inputSchema: {
      key: z.string().describe("S3 object key"),
    },
    async handler(a, ctx) {
      if (!isS3Configured()) return NOT_CONFIGURED;
      ctx.info(`Getting S3 object info: key='${a.key}'`);
      try {
        const client = getS3Client();
        if (!(await client.exists(a.key))) return `S3 object '${a.key}' not found.`;
        const stat = await client.stat(a.key);
        return (
          `S3 OBJECT '${a.key}':\n\n` +
          `size: ${stat.size} bytes\n` +
          `type: ${stat.type}\n` +
          `etag: ${stat.etag}\n` +
          `lastModified: ${stat.lastModified.toISOString()}`
        );
      } catch (e) {
        return `Failed to stat S3 object '${a.key}': ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  }),

  defineTool({
    name: "delete_s3_backup",
    title: "Delete S3 Backup Object",
    annotations: DESTRUCTIVE,
    description:
      "Permanently delete a single object from the configured S3 bucket " +
      "(`S3.delete()` server-side — no RouterOS command is executed). Use this " +
      "to clean up old or superseded backup files from S3 storage; the operation " +
      "is irreversible. " +
      "To list available keys before deleting use list_s3_backups; to inspect " +
      "an object's metadata first use s3_backup_info; to upload new backups use " +
      "upload_backup_to_s3. " +
      "`key` is the exact S3 object key as returned by list_s3_backups. " +
      "Returns a 'not found' message if the key does not exist.",
    inputSchema: {
      key: z.string().describe("S3 object key to delete"),
    },
    async handler(a, ctx) {
      if (!isS3Configured()) return NOT_CONFIGURED;
      ctx.info(`Deleting S3 object: key='${a.key}'`);
      try {
        const client = getS3Client();
        if (!(await client.exists(a.key))) return `S3 object '${a.key}' not found.`;
        await client.delete(a.key);
        return `S3 object '${a.key}' deleted successfully.`;
      } catch (e) {
        return `Failed to delete S3 object '${a.key}': ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  }),
];
