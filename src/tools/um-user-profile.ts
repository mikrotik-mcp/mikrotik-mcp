import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import type { ToolContext } from "../core/context";
import { Cmd, commandUnsupported, looksLikeError } from "../core/routeros";
import type { OpResult } from "./aaa-data";

const assignmentSchema = z
  .array(
    z.object({
      ".id": z.string().regex(/^\*[0-9a-f]+$/i),
      user: z.string(),
      profile: z.string(),
      state: z.enum(["running-active", "running active", "running", "used"]),
    }),
  )
  .max(1000);
type Assignment = z.infer<typeof assignmentSchema>[number];
const active = (row: Assignment) => row.state.replaceAll(" ", "-") === "running-active";

/** Read IDs and assignment states together; never zip mutable print indexes with a second read. */
async function assignments(ctx: ToolContext, user: string): Promise<Assignment[]> {
  const query = new Cmd("/user-manager user-profile print")
    .raw("as-value where")
    .set("user", user)
    .build();
  const output = await executeMikrotikCommand(
    `:put [:serialize to=json value=[${query}] options=json.no-string-conversion]`,
    ctx,
  );
  if (output.length > 1_000_000) throw new Error("Assignment response too large");
  const rows = assignmentSchema.parse(JSON.parse(output));
  if (
    rows.some((row) => row.user !== user) ||
    new Set(rows.map((row) => row[".id"])).size !== rows.length
  )
    throw new Error("Invalid assignment identities");
  return rows;
}

/**
 * A service profile is a separate assignment, not a user property. Validate before
 * editing, reuse a non-expired assignment or create one, then activate and read it
 * back. Preserve other assignments/history; never reset counters or disconnect a
 * session. An uncertain write is reported for review, never replayed or undone blindly.
 */
export async function updateUmUserWithProfile(
  ctx: ToolContext,
  user: string,
  profile: string,
  pairs: [string, string][],
): Promise<OpResult> {
  if (typeof profile !== "string" || !profile.trim() || !user.trim())
    return { ok: false, message: "A user name and a valid profile name are required." };
  const renamed = pairs.find(([key]) => key === "name")?.[1] ?? user;
  if (typeof renamed !== "string" || !renamed.trim())
    return { ok: false, message: "A valid user name is required." };
  let writeAttempted = false;
  try {
    for (const [menu, name] of [
      ["user", user],
      ["profile", profile],
    ]) {
      const count = await executeMikrotikCommand(
        new Cmd(`/user-manager ${menu} print count-only where`).set("name", name).build(),
        ctx,
      );
      if (count.trim() !== "1")
        return {
          ok: false,
          message: `The selected ${menu} could not be verified on this device. Refresh before saving.`,
        };
    }
    let rows = await assignments(ctx, user);
    if (rows.filter(active).length > 1)
      return {
        ok: false,
        message: "Multiple active profiles were returned. Review Assignments before saving.",
      };
    const eligible = rows.filter((row) => row.profile === profile && row.state !== "used");
    let target = eligible.find(active) ?? (eligible.length === 1 ? eligible[0] : undefined);
    if (!target && eligible.length > 1)
      return {
        ok: false,
        message: "Multiple pending assignments use this profile. Review Assignments before saving.",
      };

    const write = async (command: string) => {
      writeAttempted = true;
      const output = await executeMikrotikCommand(command, ctx);
      if (commandUnsupported(output) || looksLikeError(output))
        throw new Error("Router rejected update");
    };
    if (pairs.length) {
      const selector = new Cmd("find where").set("name", user).build();
      const command = new Cmd("/user-manager user set").raw(`[${selector}]`);
      for (const [key, value] of pairs) command.set(key, value);
      await write(command.build());
    }
    // A rename updates RouterOS references. Re-read before using any assignment ID.
    rows = await assignments(ctx, renamed);
    if (target) {
      const targetId = target[".id"];
      target = rows.find(
        (row) => row[".id"] === targetId && row.profile === profile && row.state !== "used",
      );
      if (!target) throw new Error("Assignment changed during save");
    } else {
      // Another writer may have assigned this profile since the preflight; never add a duplicate.
      if (rows.some((row) => row.profile === profile && row.state !== "used"))
        throw new Error("Assignments changed during save");
      const previousIds = new Set(rows.map((row) => row[".id"]));
      await write(
        new Cmd("/user-manager user-profile add")
          .set("user", renamed)
          .set("profile", profile)
          .build(),
      );
      rows = await assignments(ctx, renamed);
      const added = rows.filter(
        (row) => !previousIds.has(row[".id"]) && row.profile === profile && row.state !== "used",
      );
      if (added.length !== 1) throw new Error("New assignment could not be verified");
      target = added[0];
    }
    if (!active(target)) {
      const selector = new Cmd("find where")
        .set(".id", target[".id"])
        .set("user", renamed)
        .set("profile", profile)
        .build();
      await write(
        new Cmd("/user-manager user-profile activate-user-profile").raw(`[${selector}]`).build(),
      );
    }
    const current = (await assignments(ctx, renamed)).filter(active);
    if (
      current.length !== 1 ||
      current[0][".id"] !== target[".id"] ||
      current[0].profile !== profile
    )
      throw new Error("Activation could not be verified");
    return {
      ok: true,
      message: `User saved. Active profile: ${profile}. Existing connections may need to reconnect for new limits.`,
    };
  } catch {
    return writeAttempted
      ? {
          ok: false,
          reviewRequired: true,
          message:
            "Save could not be fully confirmed. User settings or profile assignments may have changed. Refresh Users and check Assignments before trying again; no automatic retry was made.",
        }
      : {
          ok: false,
          message:
            "Could not verify this user's profile assignments. No changes were made. Check connectivity and refresh before saving.",
        };
  }
}
