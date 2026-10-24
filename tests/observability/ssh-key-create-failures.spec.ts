import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { utils } from "ssh2";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { createSshKey, createSshKeyResponse } from "../../src/observability/ssh-key-create";

const home = vi.hoisted(() => ({ path: "" }));
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  homedir: () => home.path,
}));
beforeEach(async () => {
  home.path = await mkdtemp(join(tmpdir(), "mcp-key-failure-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(home.path, { recursive: true, force: true });
});

/** Exercise the real HTTP validation path without writing into the operator's SSH directory. */
function request(body: string, headers: Record<string, string> = {}) {
  return new Request("http://localhost:9090/api/config/ssh-keys", {
    method: "POST",
    body,
    headers: { origin: "http://localhost:9090", "content-type": "application/json", ...headers },
  });
}
test("HTTP creation returns only a usable public identity and refuses replacement", async () => {
  const res = await createSshKeyResponse(request('{"name":"web"}'));
  expect(res.status).toBe(201);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const body = await res.json();
  expect(body.key.path).toBe(join(home.path, ".ssh", "web"));
  expect(body.key.publicKey).toMatch(/^ssh-rsa /);
  expect(body.key.usable).toBe(true);
  expect(JSON.stringify(body)).not.toContain("PRIVATE KEY");
  const duplicate = await createSshKeyResponse(request('{"name":"web"}'));
  expect(duplicate.status).toBe(400);
  expect((await duplicate.json()).error).toContain("already exists");
});
test.each([
  ["{", {}, 400, "Invalid JSON"],
  ["x".repeat(1025), {}, 400, "too large"],
  ["{}", { "content-type": "text/plain" }, 415, "Expected JSON"],
  ["{}", { "sec-fetch-site": "cross-site" }, 403, "same-origin"],
] as const)(
  "HTTP rejects malformed/foreign requests (%i)",
  async (body, headers, status, message) => {
    const res = await createSshKeyResponse(request(body, headers));
    expect(res.status).toBe(status);
    expect((await res.json()).error).toContain(message);
    expect(await readdir(home.path)).toEqual([]);
  },
);
test("unsafe shared or symlinked directories are rejected without files", async () => {
  const dir = join(home.path, "shared");
  await mkdir(dir);
  await chmod(dir, 0o777);
  await expect(createSshKey({ name: "key" }, dir)).rejects.toThrow("not writable");
  expect(await readdir(dir)).toEqual([]);
  await chmod(dir, 0o700);
  await symlink(dir, join(home.path, "linked"));
  await expect(createSshKey({ name: "key" }, join(home.path, "linked"))).rejects.toThrow(
    "SSH directory",
  );
});
test("filesystem failures produce a safe message and release the creation lock", async () => {
  const file = join(home.path, "file");
  await writeFile(file, "keep");
  await expect(createSshKey({ name: "key" }, file)).rejects.toThrow("already exists");
  const key = await createSshKey({ name: "retry" });
  expect(key.usable).toBe(true);
});
test("generation failure removes both reserved files and does not leak private details", async () => {
  vi.spyOn(utils, "generateKeyPair").mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error) => void;
    callback(new Error("sensitive provider detail"));
  });
  await expect(createSshKey({ name: "key" })).rejects.toThrow("Could not create the key");
  expect(await readdir(join(home.path, ".ssh"))).toEqual([]);
});
test("invalid generated public material is removed instead of reporting success", async () => {
  vi.spyOn(utils, "parseKey").mockReturnValue(new Error("invalid public material"));
  await expect(createSshKey({ name: "invalid" })).rejects.toThrow("Could not create the key");
  expect(await readdir(join(home.path, ".ssh"))).toEqual([]);
});
test("Windows fails closed before creating any file", async () => {
  vi.stubGlobal("process", { ...process, platform: "win32" });
  await expect(createSshKey({ name: "key" })).rejects.toThrow("Windows OpenSSH");
  expect(await readdir(home.path)).toEqual([]);
});

test("cleanup tolerates files already removed by another host process", async () => {
  vi.spyOn(utils, "parseKey").mockImplementation(() => {
    unlinkSync(join(home.path, ".ssh", "removed"));
    unlinkSync(join(home.path, ".ssh", "removed.pub"));
    return new Error("invalid public material");
  });
  await expect(createSshKey({ name: "removed" })).rejects.toThrow("Could not create the key");
  expect(await readdir(join(home.path, ".ssh"))).toEqual([]);
});
test("concurrent creation is rejected while the first request owns its files", async () => {
  let rejectGeneration!: (error: Error) => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.spyOn(utils, "generateKeyPair").mockImplementation((...args: unknown[]) => {
    rejectGeneration = args.at(-1) as (error: Error) => void;
    started();
  });
  const first = createSshKey({ name: "first" });
  const failed = expect(first).rejects.toThrow("Could not create the key");
  await ready;
  try {
    await expect(createSshKey({ name: "second" })).rejects.toThrow("already being created");
  } finally {
    rejectGeneration(new Error("cancelled"));
    await failed;
  }
  expect(await readdir(join(home.path, ".ssh"))).toEqual([]);
});
