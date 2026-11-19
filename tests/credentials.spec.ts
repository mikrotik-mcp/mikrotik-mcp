/// <reference types="bun" />
/** Secrets outside the config file, the SSH agent, and a pinned host key. */
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";

const connects = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("ssh2", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Client: class extends EventEmitter {
      connect(cfg: Record<string, unknown>) {
        connects.push(cfg);
        const verifier = cfg.hostVerifier as ((key: Buffer) => boolean) | undefined;
        const accepted = verifier ? verifier(Buffer.from("the-host-key")) : true;
        queueMicrotask(() =>
          accepted
            ? this.emit("ready")
            : this.emit("error", new Error("Host denied (verification failed)")),
        );
      }
      destroy() {}
      end() {}
    },
  };
});

const { DeviceConfigSchema } = await import("../src/config");
const { resolveSecret, secretOf, setKeyringRunner } = await import("../src/core/secret-ref");
const { connectErrorMessage, sshOptionsOf } = await import("../src/core/transport");
const { MikroTikSSHClient } = await import("../src/ssh/client");

afterEach(() => {
  connects.length = 0;
  vi.unstubAllEnvs();
});

test("a secret is read from the environment or a file, and a missing one says which", () => {
  vi.stubEnv("ROUTER_PW", "from-env");
  expect(resolveSecret("env:ROUTER_PW")).toBe("from-env");
  expect(() => resolveSecret("env:NOT_SET_ANYWHERE")).toThrow(/NOT_SET_ANYWHERE is not set/);
  const file = join(mkdtempSync(join(tmpdir(), "secret-")), "pw");
  writeFileSync(file, "from file \n");
  expect(resolveSecret(`file:${file}`)).toBe("from file ");
  expect(() => resolveSecret("file:/no/such/secret")).toThrow(/could not read the secret file/);
  expect(secretOf("literal", undefined)).toBe("literal");
  expect(secretOf("literal", "env:ROUTER_PW")).toBe("from-env");
});

test("the device schema takes references, not other text, and the options carry the result", () => {
  vi.stubEnv("ROUTER_PW", "from-env");
  expect(DeviceConfigSchema.safeParse({ host: "h", passwordFrom: "hunter2" }).success).toBe(false);
  expect(DeviceConfigSchema.safeParse({ host: "h", hostKeySha256: "nope" }).success).toBe(false);
  const dc = DeviceConfigSchema.parse({
    host: "192.0.2.1",
    passwordFrom: "env:ROUTER_PW",
    sshAgent: true,
    hostKeySha256: "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU",
  });
  expect(sshOptionsOf(dc)).toMatchObject({ password: "from-env", agent: true });
  // The stored config holds the reference, never the value.
  expect(JSON.stringify(dc)).not.toContain("from-env");
  expect(
    connectErrorMessage("r", DeviceConfigSchema.parse({ host: "h", sshAgent: true })),
  ).toContain("auth: SSH agent");
});

test("the agent socket is passed to ssh2, and a missing agent is an error", async () => {
  vi.stubEnv("SSH_AUTH_SOCK", "/tmp/agent.sock");
  expect(await new MikroTikSSHClient({ host: "h", username: "u", agent: true }).connect()).toBe(
    true,
  );
  expect(connects[0]!.agent).toBe("/tmp/agent.sock");

  vi.stubEnv("SSH_AUTH_SOCK", "");
  const client = new MikroTikSSHClient({ host: "h", username: "u", agent: true });
  expect(await client.connect()).toBe(false);
  expect(client.lastError).toContain("no agent is running");
});

test("a pinned host key lets the right router in and refuses another", async () => {
  const fingerprint = createHash("sha256").update("the-host-key").digest("base64");
  const good = new MikroTikSSHClient({
    host: "h",
    username: "u",
    hostKeySha256: `SHA256:${fingerprint}`,
  });
  expect(await good.connect()).toBe(true);

  const other = createHash("sha256").update("another-key").digest("base64").replace(/=+$/, "");
  const bad = new MikroTikSSHClient({ host: "h", username: "u", hostKeySha256: other });
  expect(await bad.connect()).toBe(false);
  expect(bad.lastError).toContain("host key does not match the pinned fingerprint");
  expect(bad.lastError).toContain(`SHA256:${fingerprint.replace(/=+$/, "")}`);
  // Without a pin, ssh2 gets no verifier: the old behaviour.
  await new MikroTikSSHClient({ host: "h", username: "u" }).connect();
  expect(connects.at(-1)!.hostVerifier).toBeUndefined();
});

test("a keyring reference runs the system program with an argument list, and names no option", () => {
  const calls: [string, string[]][] = [];
  setKeyringRunner((program, args) => {
    calls.push([program, args]);
    return "from-keyring\n";
  });
  try {
    expect(resolveSecret("keyring:mikrotik-mcp/edge")).toBe("from-keyring");
    const [program, args] = calls[0]!;
    expect(["security", "secret-tool"]).toContain(program);
    expect(args).toContain("mikrotik-mcp");
    expect(args).toContain("edge");
    // A name that could be read as an option, or that has a path in it, is not a reference.
    expect(() => resolveSecret("keyring:-s/x")).toThrow(/must be env:NAME/);
    expect(() => resolveSecret("keyring:a/b/c")).toThrow(/must be env:NAME/);
    expect(
      DeviceConfigSchema.safeParse({ host: "h", passwordFrom: "keyring:svc/acct" }).success,
    ).toBe(true);
    expect(DeviceConfigSchema.safeParse({ host: "h", passwordFrom: "keyring:svc" }).success).toBe(
      false,
    );

    setKeyringRunner(() => {
      throw new Error("exit 44: secret text must not leak");
    });
    expect(() => resolveSecret("keyring:svc/missing")).toThrow(/has no entry for service "svc"/);
    expect(() => resolveSecret("keyring:svc/missing")).not.toThrow(/secret text/);
    setKeyringRunner(() => "");
    expect(() => resolveSecret("keyring:svc/empty")).toThrow(/is empty/);
  } finally {
    setKeyringRunner();
  }
});
