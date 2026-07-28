/**
 * Optional S3-compatible object storage, backed by Bun's native S3 client.
 *
 * The feature is opt-in: when no S3 config is present (`config.s3` is
 * undefined), `isS3Configured()` is false and the S3 backup tools short-circuit
 * with a friendly message instead of throwing. Credentials, bucket and
 * endpoint come from the loaded config (which itself layers env → flags → JSON
 * `s3` block on top of Bun's native `S3_*`/`AWS_*` lookup).
 */
import { S3Client } from "bun";
import type { S3Config } from "../config";
import { getConfig } from "./runtime";
import { deviceSlug } from "./slug";

export function getS3Config(): S3Config | undefined {
  return getConfig().s3;
}

/** True when enough S3 settings exist to construct a client. */
export function isS3Configured(): boolean {
  const s3 = getS3Config();
  return !!(s3 && (s3.bucket || s3.endpoint || s3.accessKeyId));
}

/**
 * Build a Bun `S3Client` from the active config. Only defined fields are passed
 * so Bun can still fall back to its native `S3_*`/`AWS_*` env lookup for any
 * value left unset. Throws if S3 is not configured at all.
 */
export function getS3Client(): S3Client {
  const s3 = getS3Config();
  if (!s3 || !isS3Configured()) {
    throw new Error(
      "S3 is not configured. Set S3_* (or AWS_*) environment variables, or add " +
        'an "s3" block to the JSON config file.',
    );
  }
  const opts: Record<string, string> = {};
  if (s3.accessKeyId) opts.accessKeyId = s3.accessKeyId;
  if (s3.secretAccessKey) opts.secretAccessKey = s3.secretAccessKey;
  if (s3.sessionToken) opts.sessionToken = s3.sessionToken;
  if (s3.region) opts.region = s3.region;
  if (s3.endpoint) opts.endpoint = s3.endpoint;
  if (s3.bucket) opts.bucket = s3.bucket;
  return new S3Client(opts);
}

function trimSlashes(s: string): string {
  // The trailing alternative is anchored with a negative look-behind so the
  // engine can only start matching at the FIRST slash of a run. Without it,
  // `\/+$` retries from every slash in a run that isn't at the end of the
  // string, which makes trimming quadratic in the input length (ReDoS).
  return s.replace(/^\/+|(?<!\/)\/+$/g, "");
}

/**
 * The key prefix for a device's backups: `<configured-prefix>/<device>/`.
 * Backups are organised per device so each router's files live under their own
 * "folder" in the bucket. Returns "" only when neither prefix nor device apply.
 */
export function s3DevicePrefix(device?: string): string {
  // Slugify the device segment so a name like "Ali Home" becomes "Ali-Home"
  // rather than embedding a raw space in the S3 key.
  const segments = [getS3Config()?.prefix ?? "", device ? deviceSlug(device) : ""]
    .map(trimSlashes)
    .filter(Boolean);
  return segments.length ? `${segments.join("/")}/` : "";
}

/**
 * Build the S3 object key for a file: `<configured-prefix>/<device>/<name>`.
 * Pass the (resolved) device name to categorise the object under that router.
 */
export function s3Key(name: string, device?: string): string {
  return s3DevicePrefix(device) + name.replace(/^\/+/, "");
}

/** Configured presigned-URL lifetime in seconds (default 3600). */
export function presignExpiresIn(): number {
  return getS3Config()?.presignExpiresIn ?? 3600;
}

/** A short, human-readable summary of where backups will be stored. */
export function s3Target(): string {
  const s3 = getS3Config();
  if (!s3) return "S3 not configured";
  const where = s3.endpoint ?? "AWS S3";
  const bucket = s3.bucket ?? "(bucket from env)";
  const layout = `${trimSlashes(s3.prefix ?? "")}${s3.prefix ? "/" : ""}<device>/<file>`;
  return `bucket='${bucket}' at ${where}, layout='${layout}'`;
}
