import { mkdtemp, writeFile, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { listSshKeys } from "../../src/observability/ssh-key-inventory";

test("key inventory reads validated public companions only, with bounded regular files and usable pair metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-ssh-keys-"));
  try {
    const ssh = join(dir, ".ssh");
    await mkdir(ssh);
    const blob = Buffer.concat([
      Buffer.from([0, 0, 0, 11]),
      Buffer.from("ssh-ed25519"),
      Buffer.from([0, 0, 0, 32]),
      Buffer.alloc(32, 7),
    ]);
    const publicKey = `ssh-ed25519 ${blob.toString("base64")} test-key`;
    for (const name of ["id_ed25519", "public-only"])
      await writeFile(join(ssh, `${name}.pub`), publicKey);
    await writeFile(join(ssh, "id_ed25519"), "PRIVATE_MATERIAL_NEVER_RETURN");
    await writeFile(
      join(ssh, "invalid.pub"),
      "-----BEGIN OPENSSH PRIVATE KEY-----\nPRIVATE_MATERIAL",
    );
    await writeFile(join(ssh, "large.pub"), "x".repeat(17000));
    await symlink(join(ssh, "id_ed25519.pub"), join(ssh, "symlink.pub"));
    await writeFile(join(ssh, "symlink-private.pub"), publicKey);
    await symlink(join(ssh, "id_ed25519"), join(ssh, "symlink-private"));
    const external = join(dir, "custom-key");
    await writeFile(`${external}.pub`, publicKey);
    await writeFile(external, "EXTERNAL_PRIVATE");
    const result = await listSshKeys([external, external, join(ssh, "id_ed25519")], ssh);
    expect(result.keys).toHaveLength(4);
    expect(
      result.keys
        .filter((k) => k.usable)
        .map((k) => k.path)
        .sort(),
    ).toEqual([external, join(ssh, "id_ed25519")].sort());
    expect(
      result.keys.every(
        (k) =>
          k.type === "ssh-ed25519" &&
          k.fingerprint.startsWith("SHA256:") &&
          k.publicKey === publicKey,
      ),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_MATERIAL");
    expect(JSON.stringify(result)).not.toContain("EXTERNAL_PRIVATE");
    expect(await listSshKeys([], join(dir, "missing"))).toEqual({ keys: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
