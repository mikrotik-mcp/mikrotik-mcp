/// <reference types="node" />
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vite-plus/test";
import { authenticatedAccount, ensureAccount, HUB } from "../scripts/docker-publish/auth.ts";
import type { AuthIO, CommandResult } from "../scripts/docker-publish/auth.ts";
import {
  assertTagAvailable,
  digestFromInspect,
  isMissingTag,
  publishRelease,
  validRepository,
  validVersion,
} from "../scripts/docker-publish/workflow.ts";
import type { PublishIO, ReleasePlan } from "../scripts/docker-publish/workflow.ts";

const SECRET = "synthetic-credential-for-offline-tests";
const auth = Buffer.from(`testuser:${SECRET}`).toString("base64");
const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string): CommandResult => ({ code: 1, stdout: "", stderr });
function authIO(config: unknown = { auths: { [HUB]: { auth } } }): AuthIO {
  return {
    configDir: "/synthetic/docker",
    platform: "darwin",
    read: vi.fn(async () => JSON.stringify(config)),
    helper: vi.fn(async () => ok(JSON.stringify({ Username: "testuser", Secret: SECRET }))),
    which: vi.fn(() => true),
    request: vi.fn(async () => Response.json({ token: "synthetic-access-token" })),
    login: vi.fn(async () => {}),
    note: vi.fn(),
  };
}

describe("docker publish authentication", () => {
  it.each([
    null,
    [],
    { auths: [] },
    { auths: { [HUB]: null } },
    { auths: { [HUB]: { password: 123 } } },
    { credsStore: false },
    { credHelpers: { [HUB]: 42 } },
  ])("fails before login on malformed Docker configuration %#", async (config) => {
    const io = authIO(config);
    await expect(ensureAccount(io)).rejects.toThrow("config.json is invalid");
    expect(io.login).not.toHaveBeenCalled();
    expect(io.helper).not.toHaveBeenCalled();
  });
  it("reads custom Docker config and verifies inline credentials only with Docker Hub", async () => {
    const io = authIO();
    expect(await ensureAccount(io)).toBe("testuser");
    expect(io.read).toHaveBeenCalledWith("/synthetic/docker/config.json");
    expect(io.request).toHaveBeenCalledWith(
      "https://auth.docker.io/token?service=registry.docker.io",
      expect.objectContaining({ redirect: "error", headers: { Authorization: `Basic ${auth}` } }),
    );
    expect(io.login).not.toHaveBeenCalled();
    expect(io.helper).not.toHaveBeenCalled();
    expect(io.note).not.toHaveBeenCalled();
  });

  it("uses the Hub-specific helper before credsStore and stale inline auth", async () => {
    const io = authIO({
      credsStore: "desktop",
      credHelpers: { [HUB]: "osxkeychain" },
      auths: { [HUB]: { auth } },
    });
    expect(await ensureAccount(io)).toBe("testuser");
    expect(io.helper).toHaveBeenCalledWith("docker-credential-osxkeychain", HUB);
  });

  it("reads Docker Desktop credentials without persisting or echoing its result", async () => {
    const io = authIO({ credsStore: "desktop", auths: { [HUB]: {} } });
    expect(await authenticatedAccount(io)).toBe("testuser");
    expect(io.helper).toHaveBeenCalledWith("docker-credential-desktop", HUB);
    expect(JSON.stringify(vi.mocked(io.note).mock.calls)).not.toContain(SECRET);
  });

  it.each(["index.docker.io", "docker.io", "registry-1.docker.io"])(
    "supports legacy Hub auth key %s",
    async (key) => {
      expect(await authenticatedAccount(authIO({ auths: { [key]: { auth } } }))).toBe("testuser");
    },
  );

  it("does not use credentials for lookalike registries", async () => {
    const io = authIO({ auths: { "docker.io.attacker.test": { auth } } });
    expect(await authenticatedAccount(io)).toBeUndefined();
    expect(io.request).not.toHaveBeenCalled();
  });

  it("detects a default native store only when Docker has no configured auth", async () => {
    const io = authIO({});
    expect(await authenticatedAccount(io)).toBe("testuser");
    expect(io.helper).toHaveBeenCalledWith("docker-credential-osxkeychain", HUB);
    const linux = authIO({});
    linux.platform = "linux";
    linux.which = (name) => name.endsWith("secretservice");
    expect(await authenticatedAccount(linux)).toBe("testuser");
    expect(linux.helper).toHaveBeenCalledWith("docker-credential-secretservice", HUB);
  });

  it("waits for login and re-reads the newly stored account", async () => {
    const io = authIO();
    let loggedIn = false;
    io.read = vi.fn(async () =>
      loggedIn ? JSON.stringify({ auths: { [HUB]: { auth } } }) : undefined,
    );
    io.which = () => false;
    let finishLogin!: () => void;
    io.login = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishLogin = () => {
            loggedIn = true;
            resolve();
          };
        }),
    );
    const account = ensureAccount(io);
    await vi.waitFor(() => expect(io.login).toHaveBeenCalledOnce());
    expect(io.request).not.toHaveBeenCalled();
    finishLogin();
    expect(await account).toBe("testuser");
    expect(io.read).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403])("renews rejected credentials (HTTP %i)", async (status) => {
    const io = authIO();
    vi.mocked(io.request).mockResolvedValueOnce(new Response(null, { status }));
    expect(await ensureAccount(io)).toBe("testuser");
    expect(io.login).toHaveBeenCalledOnce();
  });

  it("does not proceed after failed login", async () => {
    const io = authIO({});
    io.which = () => false;
    io.login = async () => {
      throw new Error("cancelled login");
    };
    await expect(ensureAccount(io)).rejects.toThrow("cancelled login");
    expect(io.request).not.toHaveBeenCalled();
  });

  it("rejects a login that exits without storing usable credentials", async () => {
    const io = authIO({});
    io.which = () => false;
    await expect(ensureAccount(io)).rejects.toThrow("did not yield a verifiable account");
  });

  it("renews token-only credentials instead of treating <token> as a username", async () => {
    const io = authIO({ credsStore: "desktop" });
    vi.mocked(io.helper).mockResolvedValueOnce(
      ok(JSON.stringify({ Username: "<token>", Secret: SECRET })),
    );
    expect(await ensureAccount(io)).toBe("testuser");
    expect(io.login).toHaveBeenCalledOnce();
  });

  it("recognizes missing helper credentials", async () => {
    const io = authIO({ credsStore: "desktop" });
    vi.mocked(io.helper).mockResolvedValueOnce(fail("credentials not found in native keychain"));
    expect(await ensureAccount(io)).toBe("testuser");
    expect(io.login).toHaveBeenCalledOnce();
  });

  it("never falls back to stale inline auth if the helper is locked", async () => {
    const io = authIO({ credsStore: "desktop", auths: { [HUB]: { auth } } });
    io.helper = async () => fail(`locked: ${SECRET}`);
    await expect(ensureAccount(io)).rejects.toThrow("keychain is locked");
    expect(io.request).not.toHaveBeenCalled();
    expect(io.login).not.toHaveBeenCalled();
  });

  it.each(["../bad", "desktop;echo", "-helper"])(
    "rejects helper executable injection %s",
    async (helper) => {
      const io = authIO({ credsStore: helper });
      await expect(ensureAccount(io)).rejects.toThrow("helper name is invalid");
      expect(io.helper).not.toHaveBeenCalled();
    },
  );

  it("sanitizes config, helper, HTTP and network errors", async () => {
    const cases = [
      (io: AuthIO) => {
        io.read = async () => `{${SECRET}`;
      },
      (io: AuthIO) => {
        io.request = async () => {
          throw new Error(SECRET);
        };
      },
      (io: AuthIO) => {
        io.request = async () => new Response(SECRET);
      },
      (io: AuthIO) => {
        io.read = async () => JSON.stringify({ credsStore: "desktop" });
        io.helper = async () => ok(SECRET);
      },
    ];
    for (const setup of cases) {
      const io = authIO();
      setup(io);
      const error = await ensureAccount(io).catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(SECRET);
      expect(io.login).not.toHaveBeenCalled();
    }
  });

  it.each([429, 500, 503])("does not mislabel HTTP %i as logged out", async (status) => {
    const io = authIO();
    io.request = async () => new Response(null, { status });
    await expect(ensureAccount(io)).rejects.toThrow(`HTTP ${status}`);
    expect(io.login).not.toHaveBeenCalled();
  });
});

const DIGEST = `sha256:${"a".repeat(64)}`;
const plan: ReleasePlan = {
  repository: "testuser/mikrotik-mcp",
  version: "5.20.0",
  platforms: ["linux/amd64", "linux/arm64"],
  builder: "default",
  bunVersion: "1.4.2",
  nativePlatform: "linux/arm64",
};
function publishIO(): PublishIO {
  let published = false;
  return {
    run: vi.fn(async (args) => {
      if (args.includes("--push")) {
        published = true;
        return ok();
      }
      if (args.includes("--raw"))
        return ok(
          JSON.stringify({
            manifests: [
              { platform: { os: "linux", architecture: "amd64" } },
              { platform: { os: "linux", architecture: "arm64" } },
              { platform: { os: "unknown", architecture: "unknown" } },
            ],
          }),
        );
      if (args.includes("inspect"))
        return published
          ? ok(`Name: image\nDigest: ${DIGEST}\n`)
          : fail(`ERROR: docker.io/${plan.repository}:${plan.version}: not found`);
      if (args.includes("--version")) return ok(plan.version);
      return ok();
    }),
    metadata: async () => JSON.stringify({ "containerimage.digest": DIGEST }),
    metadataPath: "/synthetic/build.json",
    confirm: vi.fn(async () => true),
    note: vi.fn(),
    step: vi.fn(),
  };
}

describe("docker publish release safety", () => {
  it("publishes version first, verifies it, smoke-tests, then promotes the same digest", async () => {
    const io = publishIO();
    expect(await publishRelease(plan, io)).toBe(DIGEST);
    const calls = vi.mocked(io.run).mock.calls.map(([args]) => args);
    expect(calls.find((args) => args.includes("--push"))).toEqual([
      "docker",
      "buildx",
      "build",
      "--builder",
      "default",
      "--pull",
      "--provenance=mode=min",
      "--platform",
      "linux/amd64,linux/arm64",
      "--tag",
      "testuser/mikrotik-mcp:5.20.0",
      "--metadata-file",
      "/synthetic/build.json",
      "--push",
      ".",
    ]);
    expect(calls.find((args) => args.includes("create"))).toEqual([
      "docker",
      "buildx",
      "imagetools",
      "create",
      "--tag",
      "testuser/mikrotik-mcp:latest",
      `testuser/mikrotik-mcp@${DIGEST}`,
    ]);
    expect(calls.findIndex((args) => args.includes("--version"))).toBeLessThan(
      calls.findIndex((args) => args.includes("create")),
    );
    expect(
      calls
        .filter((args) => args.includes("run"))
        .every((args) => args.includes("none") && args.includes("--rm")),
    ).toBe(true);
    expect(io.confirm).toHaveBeenCalledTimes(2);
  });

  it("does not build if the final confirmation is declined", async () => {
    const io = publishIO();
    io.confirm = async () => false;
    await expect(publishRelease(plan, io)).rejects.toThrow("Cancelled");
    expect(vi.mocked(io.run).mock.calls).toHaveLength(1);
  });

  it("never overwrites an existing version", async () => {
    const io = publishIO();
    io.run = vi.fn(async () => ok(`Digest: ${DIGEST}`));
    await expect(publishRelease(plan, io)).rejects.toThrow("already exists");
    expect(io.confirm).not.toHaveBeenCalled();
  });

  it("rechecks version absence after the confirmation pause", async () => {
    const io = publishIO();
    vi.mocked(io.run)
      .mockResolvedValueOnce(fail(`ERROR: ${plan.repository}:${plan.version}: not found`))
      .mockResolvedValueOnce(ok());
    await expect(publishRelease(plan, io)).rejects.toThrow("already exists");
    expect(vi.mocked(io.run).mock.calls.every(([args]) => !args.includes("--push"))).toBe(true);
  });

  it.each([
    "ERROR: unauthorized",
    "ERROR: lookup registry-1.docker.io: host not found",
    "ERROR: connection reset",
    "ERROR: unexpected status 500",
    "ERROR: repository not found: access denied",
  ])("fails closed on ambiguous tag check: %s", async (message) => {
    const io = publishIO();
    io.run = async () => fail(message);
    await expect(assertTagAvailable(io, "testuser/app:1.0.0")).rejects.toThrow("Could not prove");
    expect(isMissingTag(fail(message), "testuser/app:1.0.0")).toBe(false);
  });

  it("does not promote when version push fails", async () => {
    const io = publishIO();
    const run = io.run;
    io.run = vi.fn((args) =>
      args.includes("--push") ? Promise.resolve(fail("push failed")) : run(args),
    );
    await expect(publishRelease(plan, io)).rejects.toThrow("Publication stopped");
    expect(vi.mocked(io.run).mock.calls.some(([args]) => args.includes("create"))).toBe(false);
  });

  it("does not promote when registry digest differs from build metadata", async () => {
    const io = publishIO();
    io.metadata = async () =>
      JSON.stringify({ "containerimage.digest": `sha256:${"b".repeat(64)}` });
    await expect(publishRelease(plan, io)).rejects.toThrow("Digest mismatch");
    expect(vi.mocked(io.run).mock.calls.some(([args]) => args.includes("create"))).toBe(false);
  });

  it("requires every requested architecture", async () => {
    const io = publishIO();
    const run = io.run;
    io.run = (args) =>
      args.includes("--raw") ? Promise.resolve(ok('{"manifests":[]}')) : run(args);
    await expect(publishRelease(plan, io)).rejects.toThrow("missing a requested architecture");
  });

  it("leaves latest unchanged when promotion is declined", async () => {
    const io = publishIO();
    vi.mocked(io.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await publishRelease(plan, io);
    expect(vi.mocked(io.run).mock.calls.some(([args]) => args.includes("create"))).toBe(false);
  });

  it("leaves latest unchanged when native runtime is unavailable", async () => {
    const io = publishIO();
    await publishRelease({ ...plan, nativePlatform: "linux/s390x" }, io);
    expect(io.confirm).toHaveBeenCalledTimes(1);
    expect(vi.mocked(io.run).mock.calls.some(([args]) => args.includes("create"))).toBe(false);
  });

  it("does not promote when the pulled CLI version is wrong", async () => {
    const io = publishIO();
    const run = io.run;
    io.run = (args) => (args.includes("--version") ? Promise.resolve(ok("0.0.1")) : run(args));
    await expect(publishRelease(plan, io)).rejects.toThrow("CLI version did not match");
  });

  it.each([
    "owner/repo; echo bad",
    "UPPER/repo",
    "owner/repo:latest",
    "host.test/owner/repo",
    "--flag",
    "owner/repo\n",
  ])("rejects an invalid destination %s", (input) => {
    expect(validRepository(input)).toBe(false);
  });
  it.each(["latest", "-flag", "5.20.0;ls", "5.20.0+build", "01.2.3"])(
    "rejects an invalid version %s",
    (input) => {
      expect(validVersion(input)).toBe(false);
    },
  );
  it("accepts valid release inputs and parses only the top-level digest", () => {
    expect(validRepository("team-name/mikrotik-mcp")).toBe(true);
    expect(validVersion("5.20.0-rc.1")).toBe(true);
    expect(digestFromInspect(`Digest: ${DIGEST}\n  Digest: sha256:${"b".repeat(64)}`)).toBe(DIGEST);
  });

  it("keeps authentication runtime-only and uses Bun argv subprocesses", () => {
    const source = readFileSync(new URL("../scripts/publish-docker.ts", import.meta.url), "utf8");
    expect(source).toContain('import { spawn, which } from "bun"');
    expect(source).toContain("spawn(cmd");
    expect(source).toContain('checked(["docker", "login"], true)');
    expect(source).toContain("if (import.meta.main)");
    expect(source).not.toContain("child_process");
    expect(source).toMatch(/`\$\{username\}\/\$\{pkg\.name\.split/);
  });
});
