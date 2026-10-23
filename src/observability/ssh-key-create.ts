import { createHash } from "node:crypto";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { utils } from "ssh2";
import { z } from "zod";
import type { SshKeyOption } from "./ssh-key-inventory";

const inputSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  })
  .strict();
let creating = false;

/** Create a dedicated unattended identity, never replacing files or exposing private bytes. */
export async function createSshKey(
  input: unknown,
  directory = join(homedir(), ".ssh"),
): Promise<SshKeyOption> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success)
    throw new Error("Use 1–64 letters, digits, underscores or hyphens for the key name.");
  if (process.platform === "win32")
    throw new Error(
      "Generate the key using Windows OpenSSH with a restricted ACL, then refresh the public-key list.",
    );
  if (creating) throw new Error("A key is already being created. Wait before trying again.");
  creating = true;
  const path = join(directory, parsed.data.name);
  let privateFile: Awaited<ReturnType<typeof open>> | undefined;
  let publicFile: Awaited<ReturnType<typeof open>> | undefined;
  let complete = false;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o022) !== 0 ||
      stat.uid !== process.getuid?.()
    )
      throw new Error(
        "The SSH directory must be owned by the MCP user and not writable by other users.",
      );
    privateFile = await open(path, "wx", 0o600);
    publicFile = await open(`${path}.pub`, "wx", 0o600);
    const pair = await new Promise<utils.KeyPairReturn>((resolve, reject) => {
      utils.generateKeyPair("rsa", { bits: 3072, comment: parsed.data.name }, (error, key) =>
        error ? reject(error) : resolve(key),
      );
    });
    await privateFile.writeFile(pair.private);
    await publicFile.writeFile(`${pair.public}\n`);
    await privateFile.sync();
    await publicFile.sync();
    const key = utils.parseKey(pair.public);
    if (key instanceof Error) throw key;
    complete = true;
    return {
      path,
      name: parsed.data.name,
      type: key.type,
      publicKey: pair.public,
      usable: true,
      fingerprint: `SHA256:${createHash("sha256").update(key.getPublicSSH()).digest("base64").replace(/=+$/, "")}`,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        "That key name already exists. Choose a new name; existing files were not overwritten.",
      );
    if (error instanceof Error && error.message.startsWith("The SSH directory")) throw error;
    throw new Error(
      "Could not create the key. Check the MCP user's SSH directory permissions and available disk space.",
    );
  } finally {
    await Promise.allSettled([privateFile?.close(), publicFile?.close()]);
    if (!complete) {
      if (privateFile) await unlink(path).catch(() => {});
      if (publicFile) await unlink(`${path}.pub`).catch(() => {});
    }
    creating = false;
  }
}

/** Only the authenticated same-origin dashboard may create identities on this host. */
export async function createSshKeyResponse(req: Request): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  if (
    req.headers.get("origin") !== new URL(req.url).origin ||
    req.headers.get("sec-fetch-site") === "cross-site"
  )
    return Response.json(
      { error: "Key creation requires a same-origin dashboard request." },
      { status: 403, headers },
    );
  if (req.headers.get("content-type")?.split(";")[0] !== "application/json")
    return Response.json({ error: "Expected JSON." }, { status: 415, headers });
  try {
    const body = await req.text();
    if (body.length > 1024) throw new Error("Key request is too large.");
    const key = await createSshKey(JSON.parse(body));
    return Response.json({ key }, { status: 201, headers });
  } catch (error) {
    const message = error instanceof SyntaxError ? "Invalid JSON." : (error as Error).message;
    return Response.json({ error: message }, { status: 400, headers });
  }
}
