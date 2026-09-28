import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { resolveDeviceName } from "../core/runtime";
import { assertDeviceAccess } from "../core/scoped-access";
import { investigationStore } from "../investigations/store";
import { workspaceStore } from "../workspaces/store";
import { checkInput, runInput } from "./model";
import type { CheckSession } from "./model";
import { clientPresence } from "./presence";

const digest = (token: string) => createHash("sha256").update(token).digest("hex");
export function publicSession(s: CheckSession) {
  const { tokenHash: _, ...safe } = s;
  return { ...safe, connection: clientPresence(s) };
}
export async function createCheck(input: unknown, selected?: string) {
  const a = checkInput.parse(input),
    device = resolveDeviceName(selected);
  assertDeviceAccess([device], "create_client_check", "WRITE");
  if (a.caseId) {
    const investigation = (await investigationStore()).get(a.caseId);
    if (!investigation || investigation.device !== device)
      throw new Error("Investigation must belong to this router.");
  }
  const token = randomBytes(32).toString("base64url"),
    now = Date.now();
  const value: CheckSession = {
    id: randomUUID(),
    device,
    createdAt: now,
    expiresAt: now + a.minutes * 60000,
    status: "open",
    label: a.label,
    caseId: a.caseId,
    tokenHash: digest(token),
    runs: [],
  };
  (await workspaceStore()).save("client-check", value);
  return { ...publicSession(value), token, clientPath: `/client-check#${value.id}.${token}` };
}
export async function authorizedCheck(id: string, token: string): Promise<CheckSession> {
  if (!/^[\da-f-]{36}$/.test(id) || !/^[\w-]{43}$/.test(token))
    throw new Error("Invalid or expired check link.");
  const s = (await workspaceStore()).get<CheckSession>("client-check", id);
  if (
    !s ||
    s.status !== "open" ||
    s.expiresAt <= Date.now() ||
    !timingSafeEqual(Buffer.from(s.tokenHash), Buffer.from(digest(token)))
  )
    throw new Error("Invalid or expired check link.");
  assertDeviceAccess([s.device], "create_client_check", "WRITE");
  return s;
}
export async function saveCheckRun(
  id: string,
  token: string,
  input: unknown,
  peer: string,
  endpoint: string,
) {
  const s = await authorizedCheck(id, token);
  if (s.runs.length >= 6) throw new Error("Six-run session limit reached. Create another check.");
  const a = runInput.parse(input);
  const run: CheckSession["runs"][number] = {
    ...a,
    id: randomUUID(),
    receivedAt: Date.now(),
    peerAddress: peer,
    family: isIP(peer) === 6 ? "IPv6" : isIP(peer) === 4 ? "IPv4" : "unknown",
    endpoint,
  };
  (await workspaceStore()).replace("client-check", s, {
    ...s,
    runs: [...s.runs, run],
  } as CheckSession);
  return { saved: true, runId: run.id };
}
