/**
 * A secret that is not written in the configuration file: `env:NAME` reads an
 * environment variable, `file:/path` reads a file (a Docker or Kubernetes
 * secret, or a file a password manager writes).
 *
 * The reference is resolved each time a connection opens, so a rotated secret
 * is used without a restart. The value never enters the configuration, its
 * backups or the dashboard's config editor; only the reference does.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const KEYRING_PART = "[A-Za-z0-9][A-Za-z0-9._@-]{0,63}";
export const SECRET_REF = new RegExp(
  `^(?:env:[A-Za-z_][A-Za-z0-9_]*|file:.+|keyring:${KEYRING_PART}/${KEYRING_PART})$`,
);

type Runner = (program: string, args: string[]) => string;
const runProgram: Runner = (program, args) =>
  execFileSync(program, args, {
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
let runner: Runner = runProgram;

/** Replace the program runner (tests only). Pass nothing to restore. */
export function setKeyringRunner(fn?: Runner): void {
  runner = fn ?? runProgram;
}

/**
 * Read a secret from the keyring of the operating system: the macOS Keychain
 * (`security`) or the Secret Service on Linux (`secret-tool`). The program is
 * started with an argument list, no shell, and the two names are limited to a
 * plain set of characters, so neither can be read as an option.
 */
function fromKeyring(service: string, account: string, platform = process.platform): string {
  const call: [string, string[]] | undefined =
    platform === "darwin"
      ? ["security", ["find-generic-password", "-s", service, "-a", account, "-w"]]
      : platform === "linux"
        ? ["secret-tool", ["lookup", "service", service, "account", account]]
        : undefined;
  if (!call) throw new Error(`the keyring is not supported on ${platform}; use env: or file:`);
  let value: string;
  try {
    value = runner(call[0], call[1]).replace(/\r?\n$/, "");
  } catch {
    throw new Error(
      `the keyring has no entry for service "${service}", account "${account}" (or ${call[0]} is not installed)`,
    );
  }
  if (value === "") throw new Error(`the keyring entry "${service}/${account}" is empty`);
  return value;
}

/** Resolve `env:NAME`, `file:/path` or `keyring:service/account`. Throws with a reason that names no secret. */
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
  if (reference.startsWith("keyring:") && SECRET_REF.test(reference)) {
    const [service, account] = reference.slice(8).split("/") as [string, string];
    return fromKeyring(service, account);
  }
  throw new Error("a secret reference must be env:NAME, file:/path or keyring:service/account");
}

/** The literal value, or the referenced one when a reference is set. */
export function secretOf(
  literal: string | undefined,
  reference: string | undefined,
): string | undefined {
  return reference ? resolveSecret(reference) : literal;
}
