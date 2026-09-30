import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { utils } from "ssh2";

export interface SshKeyOption {
  path: string;
  name: string;
  type: string;
  fingerprint: string;
  publicKey: string;
  usable: boolean;
}

/** Public companions only: never open, derive, return or log private key bytes. */
export async function listSshKeys(
  configuredPaths: string[],
  directory = join(homedir(), ".ssh"),
): Promise<{ keys: SshKeyOption[]; warning?: string }> {
  const paths = new Set(configuredPaths.filter(Boolean).map((path) => resolve(path)));
  let warning: string | undefined;
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isFile() && entry.name.endsWith(".pub"))
        paths.add(join(directory, entry.name.slice(0, -4)));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      warning =
        "The MCP server could not read its .ssh directory. You can enter a key path manually.";
  }
  const keys: SshKeyOption[] = [];
  // Bound filesystem work even when a host has a large key archive.
  if (paths.size > 100)
    warning = "Showing the first 100 key candidates. Use a manual path for other keys.";
  for (const path of [...paths].slice(0, 100)) {
    let file;
    try {
      // NOFOLLOW plus a bounded read excludes symlinks, oversized files and FIFOs.
      const pubPath = `${path}.pub`;
      if (!(await lstat(pubPath)).isFile()) continue;
      file = await open(pubPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 16384) continue;
      const buffer = Buffer.alloc(16385);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 16384) continue;
      const line = buffer.subarray(0, bytesRead).toString("utf8").trim();
      if (!/^(ssh-(rsa|ed25519)|ecdsa-sha2-nistp\d+) [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/.test(line))
        continue;
      const key = utils.parseKey(line);
      if (key instanceof Error || key.isPrivateKey()) continue;
      let usable = false;
      try {
        const privateStat = await lstat(path);
        if (privateStat.isFile() && privateStat.size > 0) {
          await access(path, constants.R_OK);
          usable = true;
        }
      } catch {
        /* A public-only key is still available to copy, not select. */
      }
      keys.push({
        path,
        name: basename(path),
        type: key.type,
        fingerprint: `SHA256:${createHash("sha256").update(key.getPublicSSH()).digest("base64").replace(/=+$/, "")}`,
        publicKey: line,
        usable,
      });
    } catch {
      /* Ignore missing or invalid public companions; no sensitive path errors. */
    } finally {
      await file?.close();
    }
  }
  return { keys, ...(warning ? { warning } : {}) };
}
