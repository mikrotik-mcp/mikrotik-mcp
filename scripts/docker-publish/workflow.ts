import { PublishError } from "./auth.ts";
import type { CommandResult } from "./auth.ts";

export interface ReleasePlan {
  repository: string;
  version: string;
  platforms: string[];
  builder: string;
  bunVersion: string;
  nativePlatform: string;
}

export interface PublishIO {
  run: (args: string[], interactive?: boolean) => Promise<CommandResult>;
  metadata: () => Promise<string>;
  metadataPath: string;
  confirm: (question: string, initial?: boolean) => Promise<boolean>;
  note: (message: string) => void;
  step: (message: string) => void;
}

export function validRepository(value: string): boolean {
  return (
    /^[a-z0-9][a-z0-9_-]{1,254}\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/.test(value) &&
    value.length <= 255
  );
}

export function validVersion(value: string): boolean {
  return (
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?$/.test(
      value,
    ) && value.length <= 128
  );
}

export function digestFromInspect(output: string): string {
  const digest = /^Digest:\s+(sha256:[a-f0-9]{64})\s*$/m.exec(output)?.[1];
  if (!digest) throw new PublishError("Registry did not return a top-level SHA-256 digest.");
  return digest;
}

/** Only a registry's explicit missing-manifest response means absence, never DNS/auth/TLS failure. */
export function isMissingTag(result: CommandResult, reference: string): boolean {
  if (result.code === 0) return false;
  const message = result.stderr.trim();
  return (
    message === `ERROR: ${reference}: not found` ||
    message === `ERROR: docker.io/${reference}: not found` ||
    /^ERROR: .*manifest unknown(?:: manifest unknown)?$/i.test(message)
  );
}

async function checked(io: PublishIO, args: string[], interactive = false): Promise<CommandResult> {
  const result = await io.run(args, interactive);
  if (result.code !== 0)
    throw new PublishError(
      `Command failed (exit ${result.code}): ${args.join(" ")}. Publication stopped; no automatic retry.`,
    );
  return result;
}

export async function assertTagAvailable(
  io: Pick<PublishIO, "run">,
  reference: string,
): Promise<void> {
  const result = await io.run(["docker", "buildx", "imagetools", "inspect", reference]);
  if (result.code === 0)
    throw new PublishError(
      `${reference} already exists. Release a new version; published version tags are not overwritten.`,
    );
  if (!isMissingTag(result, reference))
    throw new PublishError(
      "Could not prove the version tag is absent (authentication, network or registry error). Nothing was pushed.",
    );
}

async function verifyImage(
  io: PublishIO,
  reference: string,
  expected: string,
  platforms: string[],
): Promise<void> {
  const result = await checked(io, ["docker", "buildx", "imagetools", "inspect", reference]);
  if (digestFromInspect(result.stdout) !== expected)
    throw new PublishError(`Digest mismatch for ${reference}. Do not deploy this tag.`);
  const raw = await checked(io, ["docker", "buildx", "imagetools", "inspect", "--raw", reference]);
  let available: string[];
  try {
    const index = JSON.parse(raw.stdout);
    available = index.manifests.map(
      (entry: { platform?: { os?: string; architecture?: string } }) =>
        `${entry.platform?.os}/${entry.platform?.architecture}`,
    );
  } catch {
    throw new PublishError("Registry did not return the expected multi-platform index.");
  }
  if (platforms.some((platform) => !available.includes(platform)))
    throw new PublishError(
      "Published image is missing a requested architecture. latest was not promoted.",
    );
}

const SMOKE = `const p = await Bun.file('/app/package.json').json();
if (p.version !== Bun.argv.at(-2) || Bun.version !== Bun.argv.at(-1) || process.getuid() !== 1000) process.exit(1);
console.log(JSON.stringify({version:p.version,bun:Bun.version,uid:process.getuid(),arch:process.arch}));`;

/** Version first; verify registry + native runtime, then require a separate explicit latest promotion. */
export async function publishRelease(plan: ReleasePlan, io: PublishIO): Promise<string> {
  if (!validRepository(plan.repository) || !validVersion(plan.version))
    throw new PublishError("Invalid publication target.");
  if (
    !plan.platforms.length ||
    plan.platforms.some((p) => !["linux/amd64", "linux/arm64"].includes(p))
  )
    throw new PublishError("Unsupported build platform.");
  const reference = `${plan.repository}:${plan.version}`;
  io.step("Check version tag");
  await assertTagAvailable(io, reference);
  if (!(await io.confirm(`Publish ${reference} to Docker Hub?`)))
    throw new PublishError("Cancelled. Nothing was pushed.");
  // Recheck after the operator's pause. Registries do not offer compare-and-swap tag creation;
  // enable immutable version tags on Docker Hub to protect against concurrent publishers.
  await assertTagAvailable(io, reference);
  io.step("Build & push version — Docker progress follows");
  await checked(
    io,
    [
      "docker",
      "buildx",
      "build",
      "--builder",
      plan.builder,
      "--pull",
      "--provenance=mode=min",
      "--platform",
      plan.platforms.join(","),
      "--tag",
      reference,
      "--metadata-file",
      io.metadataPath,
      "--push",
      ".",
    ],
    true,
  );
  let digest: string;
  try {
    digest = JSON.parse(await io.metadata())["containerimage.digest"];
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid image digest");
  } catch {
    throw new PublishError(
      `Build finished but its digest could not be verified. Inspect ${reference}; do not retry blindly or promote latest.`,
    );
  }
  io.step("Read back registry digest & architectures");
  await verifyImage(io, reference, digest, plan.platforms);
  io.note(`Version published: ${reference}\nDigest: ${digest}`);
  if (!plan.platforms.includes(plan.nativePlatform)) {
    io.note(
      `No native ${plan.nativePlatform} image selected. Runtime not tested; latest promotion is skipped.`,
    );
    return digest;
  }
  io.step(`Pull exact digest & smoke-test ${plan.nativePlatform}`);
  const immutable = `${plan.repository}@${digest}`;
  await checked(io, ["docker", "pull", "--platform", plan.nativePlatform, immutable], true);
  await checked(io, [
    "docker",
    "run",
    "--rm",
    "--network",
    "none",
    "--platform",
    plan.nativePlatform,
    "--entrypoint",
    "bun",
    immutable,
    "--no-install",
    "--no-env-file",
    "-e",
    SMOKE,
    plan.version,
    plan.bunVersion,
  ]);
  const version = await checked(io, [
    "docker",
    "run",
    "--rm",
    "--network",
    "none",
    "--platform",
    plan.nativePlatform,
    immutable,
    "--version",
  ]);
  if (version.stdout.trim() !== plan.version)
    throw new PublishError("Published CLI version did not match. latest was not promoted.");
  io.note(
    "Native Bun/version/non-root/CLI checks passed. HTTP, dashboard, MCP protocol and other architectures still need release acceptance tests (docs/docker-publishing.md).",
  );
  if (
    await io.confirm(
      "Have release acceptance tests passed, and should latest now point to this verified digest?",
    )
  ) {
    io.step("Promote verified digest to latest");
    await checked(
      io,
      ["docker", "buildx", "imagetools", "create", "--tag", `${plan.repository}:latest`, immutable],
      true,
    );
    await verifyImage(io, `${plan.repository}:latest`, digest, plan.platforms);
    await verifyImage(io, reference, digest, plan.platforms);
    io.note("latest and the version tag now match the verified digest.");
  } else io.note("Version published; latest was left unchanged.");
  return digest;
}
