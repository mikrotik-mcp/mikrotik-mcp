import type { ToolContext } from "../core/context";
import { executeMikrotikCommand } from "../core/connector";
import { Cmd, commandUnsupported, looksLikeError } from "../core/routeros";
import { redactContainerText } from "../utils/container-redaction";

export const CONTAINER_UNAVAILABLE =
  "Container command unavailable. Inspect the target's version, package, device-mode and supported fields before planning changes; no automatic install/reboot.";
type Scope = "/container" | "/container envs" | "/container mounts";

/** Errors omit raw replies, which may echo env values or command arguments. */
export async function containerRead(command: string, ctx: ToolContext): Promise<string> {
  try {
    const result = await executeMikrotikCommand(command, ctx);
    if (commandUnsupported(result)) throw new Error(CONTAINER_UNAVAILABLE);
    if (looksLikeError(result))
      throw new Error(
        "Container read failed; check target syntax and permissions. State is unknown.",
      );
    return result;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === CONTAINER_UNAVAILABLE ||
        error.message.startsWith("Container read failed;"))
    )
      throw error;
    throw new Error(
      "Container read failed; check device connectivity. State is unknown; no write was authorized by this read.",
    );
  }
}

/** Bounded selection: return count and only the single exact .id, never all matches. */
export async function resolveContainerItem(
  scope: Scope,
  selector: Record<string, string | undefined>,
  ctx: ToolContext,
): Promise<string> {
  const where = new Cmd("");
  const entries = Object.entries(selector).filter(([, value]) => value !== undefined);
  if (!entries.length)
    throw new Error("Provide one exact selector or stable .id; no mutation performed.");
  for (const [key, value] of entries) where.set(key, value!);
  const reply = await containerRead(
    `:local ids [${scope} find where ${where.build().trim()}]; :put [:len $ids]; :if ([:len $ids]=1) do={:put [:pick $ids 0]}`,
    ctx,
  );
  const lines = reply
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim());
  if (lines[0] === "0" && lines.length === 1)
    throw new Error("Container item not found; no mutation performed.");
  if (lines[0] === "1" && lines.length === 2 && /^\*[\da-f]+$/i.test(lines[1])) return lines[1];
  throw new Error(
    "Ambiguous or unreadable container selection; use a fresh stable .id. No mutation performed.",
  );
}

/** A missing running flag is NOT proof of stopped, especially during extraction. */
export async function requireStopped(id: string, ctx: ToolContext): Promise<void> {
  const reply = await containerRead(
    `:local c [/container get ${id}]; :if ((($c->"status")="stopped") || (($c->"stopped")=true) || (($c->".stopped")=true)) do={:put "confirmed-stopped"} else={:put "not-confirmed-stopped"}`,
    ctx,
  );
  if (reply.trim() !== "confirmed-stopped")
    throw new Error(
      "Container is not confirmed fully stopped. Inspect status/flags and wait before this operation; no mutation performed.",
    );
}

/** Never retry ambiguous writes or expose a transport error that embeds a secret. */
export async function containerWrite(command: string, ctx: ToolContext): Promise<void> {
  let result: string;
  try {
    result = await executeMikrotikCommand(command, ctx);
  } catch {
    throw new Error(
      "Container write outcome UNKNOWN after transport failure. Inspect the exact target before retrying; it may have applied. Command details omitted to protect credentials.",
    );
  }
  if (commandUnsupported(result)) throw new Error(CONTAINER_UNAVAILABLE);
  if (looksLikeError(result))
    throw new Error(
      "Container write rejected by RouterOS. Inspect supported fields and permissions before retrying. Raw reply omitted to protect credentials.",
    );
}

/** A read-back failure after a write must not invite an automatic replay. */
export async function containerReadBack(command: string, ctx: ToolContext): Promise<string> {
  try {
    return redactContainerText(await containerRead(command, ctx));
  } catch {
    return "Read-back unavailable; outcome UNVERIFIED. Inspect before retrying the write.";
  }
}
