import { Buffer } from "node:buffer";
import { join } from "node:path";

export const HUB = "https://index.docker.io/v1/";
const HUB_KEYS = [HUB, "index.docker.io", "docker.io", "registry-1.docker.io"];

export class PublishError extends Error {}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface AuthIO {
  read: (path: string) => Promise<string | undefined>;
  helper: (name: string, server: string) => Promise<CommandResult>;
  which: (name: string) => boolean;
  request: (url: string, init: RequestInit) => Promise<Response>;
  login: () => Promise<void>;
  note: (message: string) => void;
  platform: string;
  configDir: string;
}

interface DockerConfig {
  credsStore?: string;
  credHelpers?: Record<string, string>;
  auths?: Record<
    string,
    { auth?: string; username?: string; password?: string; identitytoken?: string }
  >;
}

interface Credential {
  username: string;
  secret: string;
}

export function validNamespace(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{1,254}$/.test(value);
}

function parseConfig(raw: string | undefined): DockerConfig {
  if (raw === undefined) return {};
  try {
    const config = JSON.parse(raw);
    if (!config || typeof config !== "object" || Array.isArray(config))
      throw new Error("Invalid config");
    for (const key of ["auths", "credHelpers"]) {
      if (
        config[key] !== undefined &&
        (!config[key] || typeof config[key] !== "object" || Array.isArray(config[key]))
      )
        throw new Error("Invalid config entry");
    }
    if (config.credsStore !== undefined && typeof config.credsStore !== "string")
      throw new Error("Invalid credential store");
    for (const value of Object.values(config.credHelpers ?? {})) {
      if (typeof value !== "string") throw new Error("Invalid credential helper");
    }
    for (const value of Object.values(config.auths ?? {})) {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid auth entry");
      const entry = value as Record<string, unknown>;
      for (const key of ["auth", "username", "password", "identitytoken"]) {
        if (entry[key] !== undefined && typeof entry[key] !== "string")
          throw new Error("Invalid auth field");
      }
    }
    return config;
  } catch {
    // Never echo parse errors: JSON errors can contain fragments of credentials.
    throw new PublishError(
      "Docker config.json is invalid. Repair it before logging in; it was not changed.",
    );
  }
}

/** Match Docker's canonical Hub helper precedence; never fall back to stale auths after helper failure. */
async function readCredential(io: AuthIO): Promise<Credential | undefined> {
  const config = parseConfig(await io.read(join(io.configDir, "config.json")));
  let helper = config.credHelpers?.[HUB] || config.credsStore;
  if (
    !helper &&
    !Object.keys(config.auths ?? {}).length &&
    !Object.keys(config.credHelpers ?? {}).length
  ) {
    const defaults =
      io.platform === "darwin"
        ? ["osxkeychain"]
        : io.platform === "win32"
          ? ["wincred"]
          : ["pass", "secretservice"];
    helper = defaults.find((name) => io.which(`docker-credential-${name}`));
  }
  if (helper) {
    if (typeof helper !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(helper)) {
      throw new PublishError("Docker credential helper name is invalid.");
    }
    if (!io.which(`docker-credential-${helper}`)) {
      throw new PublishError(
        `Docker credential helper '${helper}' is missing from PATH. Fix Docker's credential store first.`,
      );
    }
    const result = await io.helper(`docker-credential-${helper}`, HUB);
    if (result.code !== 0) {
      if (
        /credentials not found in native keychain|credentials not found in keychain|credentials not found in store/i.test(
          result.stdout + result.stderr,
        )
      )
        return undefined;
      throw new PublishError(
        "Docker credential helper failed or the keychain is locked. Unlock/fix it and retry. Its output is hidden for safety.",
      );
    }
    try {
      const value = JSON.parse(result.stdout);
      if (value.Username === "<token>") return undefined;
      if (typeof value.Username !== "string" || typeof value.Secret !== "string")
        throw new Error("Invalid credential shape");
      if (!value.Username || !value.Secret) return undefined;
      if (!validNamespace(value.Username)) throw new Error("Invalid account name");
      return { username: value.Username, secret: value.Secret };
    } catch {
      throw new PublishError(
        "Docker credential helper returned invalid credentials. Its output is hidden for safety.",
      );
    }
  }
  const entry = HUB_KEYS.map((key) => config.auths?.[key]).find(Boolean);
  if (!entry) return undefined;
  if (entry.identitytoken) return undefined; // Legacy token-only login has no reliable account name; renew via Docker.
  if (entry.auth) {
    if (typeof entry.auth !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(entry.auth)) {
      throw new PublishError(
        "Docker Hub auth entry is invalid. Repair config.json before continuing.",
      );
    }
    const decoded = Buffer.from(entry.auth, "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    if (colon < 1) throw new PublishError("Docker Hub auth entry is invalid.");
    const username = decoded.slice(0, colon);
    const secret = decoded.slice(colon + 1).replace(/\0+$/, "");
    if (!validNamespace(username)) throw new PublishError("Docker Hub account name is invalid.");
    return secret ? { username, secret } : undefined;
  }
  if (entry.username && entry.password && validNamespace(entry.username)) {
    return { username: entry.username, secret: entry.password };
  }
  return undefined;
}

/** Only send credentials to Docker's fixed HTTPS auth endpoint; never follow redirects or log responses. */
export async function authenticatedAccount(io: AuthIO): Promise<string | undefined> {
  const credential = await readCredential(io);
  if (!credential) return undefined;
  let response: Response;
  try {
    response = await io.request("https://auth.docker.io/token?service=registry.docker.io", {
      method: "GET",
      redirect: "error",
      headers: {
        Authorization: `Basic ${Buffer.from(`${credential.username}:${credential.secret}`).toString("base64")}`,
      },
    });
  } catch {
    throw new PublishError(
      "Cannot verify Docker Hub login (network/TLS/timeout). No credentials were printed; retry when connectivity is restored.",
    );
  }
  if (response.status === 401 || response.status === 403) return undefined;
  if (!response.ok)
    throw new PublishError(
      `Docker Hub authentication is unavailable (HTTP ${response.status}). Retry later.`,
    );
  try {
    const body = (await response.json()) as { token?: string; access_token?: string };
    if (typeof (body.token ?? body.access_token) !== "string" || !(body.token ?? body.access_token))
      throw new Error("Missing token");
  } catch {
    throw new PublishError(
      "Docker Hub returned an invalid authentication response. Response hidden for safety.",
    );
  }
  return credential.username;
}

export async function ensureAccount(io: AuthIO): Promise<string> {
  let username = await authenticatedAccount(io);
  if (username) return username;
  io.note(
    "Login required: no usable account, expired credentials, or a legacy token-only login. Docker will handle authentication.",
  );
  await io.login(); // Inherited terminal; wait for Docker's browser/device-code flow to finish.
  username = await authenticatedAccount(io); // Re-read config and helper: login can change either.
  if (!username)
    throw new PublishError(
      "Docker login did not yield a verifiable account. Run 'docker login --username YOUR_DOCKER_ID' and retry.",
    );
  return username;
}
