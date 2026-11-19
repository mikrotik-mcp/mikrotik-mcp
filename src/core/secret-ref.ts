/**
 * A secret that is not written in the configuration file: `env:NAME` reads an
 * environment variable, `file:/path` reads a file (a Docker or Kubernetes
 * secret, or a file a password manager writes).
 *
 * The reference is resolved each time a connection opens, so a rotated secret
 * is used without a restart. The value never enters the configuration, its
 * backups or the dashboard's config editor; only the reference does.
 */
import { readFileSync } from "node:fs";

export const SECRET_REF = /^(?:env:[A-Za-z_][A-Za-z0-9_]*|file:.+)$/;

/** Resolve `env:NAME` or `file:/path`. Throws with a reason that names no secret. */
export function resolveSecret(reference: string): string {
  if (reference.startsWith("env:")) {
    const value = process.env[reference.slice(4)];
    if (value === undefined || value === "")
      throw new Error(`the environment variable ${reference.slice(4)} is not set`);
    return value;
  }
  if (reference.startsWith("file:")) {
    try {
      // One trailing newline is how an editor or `echo` ends the file; it is not part of the secret.
      return readFileSync(reference.slice(5), "utf8").replace(/\r?\n$/, "");
    } catch (error) {
      throw new Error(
        `could not read the secret file ${reference.slice(5)}: ${(error as NodeJS.ErrnoException).code ?? "error"}`,
      );
    }
  }
  throw new Error("a secret reference must start with env: or file:");
}

/** The literal value, or the referenced one when a reference is set. */
export function secretOf(
  literal: string | undefined,
  reference: string | undefined,
): string | undefined {
  return reference ? resolveSecret(reference) : literal;
}
