import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { utils } from "ssh2";
import { expect, test } from "vite-plus/test";
import { createSshKey, createSshKeyResponse } from "../../src/observability/ssh-key-create";
import { listSshKeys } from "../../src/observability/ssh-key-inventory";

test("generated identities are parseable, private, discoverable and never overwritten", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-key-create-"));
  try {
    const directory = join(dir, ".ssh");
    const key = await createSshKey({ name: "home" }, directory);
    const privateText = await readFile(key.path, "utf8");
    const parsed = utils.parseKey(privateText);
    expect(parsed).not.toBeInstanceOf(Error);
    if (parsed instanceof Error) throw parsed;
    expect(parsed.isPrivateKey()).toBe(true);
    const publicKey = utils.parseKey(key.publicKey);
    if (publicKey instanceof Error) throw publicKey;
    expect(parsed.getPublicSSH()).toEqual(publicKey.getPublicSSH());
    expect((await stat(key.path)).mode & 0o777).toBe(0o600);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect(JSON.stringify(key)).not.toContain("PRIVATE KEY");
    expect((await listSshKeys([], directory)).keys).toEqual([key]);
    await expect(createSshKey({ name: "home" }, directory)).rejects.toThrow("already exists");
    expect(await readFile(key.path, "utf8")).toBe(privateText);
    await writeFile(join(directory, "existing.pub"), "keep");
    await expect(createSshKey({ name: "existing" }, directory)).rejects.toThrow("already exists");
    expect(await readFile(join(directory, "existing.pub"), "utf8")).toBe("keep");
    expect(await readdir(directory)).not.toContain("existing");
    await symlink(key.path, join(directory, "linked"));
    await expect(createSshKey({ name: "linked" }, directory)).rejects.toThrow("already exists");
    expect(await readFile(key.path, "utf8")).toBe(privateText);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.each(["../escape", "/tmp/key", "a.pub", "a\nkey", "", "x".repeat(65)])(
  "rejects unsafe key name %s",
  async (name) => {
    await expect(createSshKey({ name })).rejects.toThrow("key name");
  },
);

test("creation rejects cross-origin requests and malformed bodies before touching disk", async () => {
  const url = "http://localhost:9090/api/config/ssh-keys";
  for (const origin of [undefined, "https://evil.example"]) {
    const response = await createSshKeyResponse(
      new Request(url, { method: "POST", headers: origin ? { origin } : {}, body: "{}" }),
    );
    expect(response.status).toBe(403);
  }
  const response = await createSshKeyResponse(
    new Request(url, {
      method: "POST",
      headers: { origin: "http://localhost:9090", "content-type": "application/json" },
      body: JSON.stringify({ name: "../bad" }),
    }),
  );
  expect(response.status).toBe(400);
  expect(response.headers.get("cache-control")).toBe("no-store");
});
