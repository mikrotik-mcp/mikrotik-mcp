import { z } from "zod";
import { defineTool, READ, WRITE } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { resolveDeviceName } from "../core/runtime";
import { assertDeviceAccess } from "../core/scoped-access";
import { workspaceStore } from "../workspaces/store";
import { checkInput, compareRuns } from "../client-check/model";
import type { CheckSession } from "../client-check/model";
import { createCheck, publicSession } from "../client-check/service";

export const clientCheckTools: ToolModule = [
  defineTool({
    name: "create_client_check",
    title: "Create a Client Network Check",
    annotations: WRITE,
    description:
      "Create a 5–60 minute, six-run browser test invitation. Open returned clientPath on the affected phone/laptop via a reachable dashboard address; the fragment token grants test access only, never dashboard access. Explicit user start transfers at most 20 MiB per run to THIS MCP host. This is not internet throughput unless the host is on the remote path. Measures browser HTTP latency, loaded latency and transfers, not ICMP, DNS leakage, PMTU or app availability. Optional caseId links historical investigation evidence. No router changes.",
    inputSchema: checkInput.shape,
    handler: async (a, ctx) => JSON.stringify(await createCheck(a, ctx.device)),
  }),
  defineTool({
    name: "list_client_checks",
    title: "Read Client Network Checks",
    annotations: READ,
    description:
      "Read browser-reported measurements saved for this router. Tokens are never returned. Observed peer IP belongs to this HTTP connection, not necessarily the user's public internet exit. Does not run tests or contact routers.",
    inputSchema: {},
    async handler(_a, ctx) {
      const d = resolveDeviceName(ctx.device);
      assertDeviceAccess([d], "list_client_checks", "READ");
      return JSON.stringify(
        (await workspaceStore()).list<CheckSession>("client-check", d).map(publicSession),
      );
    },
  }),
  defineTool({
    name: "compare_client_checks",
    title: "Compare Two Client Test Runs",
    annotations: READ,
    description:
      "Compare two complete browser test runs in one session, for example Wi-Fi vs WireGuard. Requires the same endpoint. Measurements are client-reported and sequential, not proof of a bottleneck or a fastest route.",
    inputSchema: { id: z.uuid(), first: z.uuid(), second: z.uuid() },
    async handler(a, ctx) {
      const d = resolveDeviceName(ctx.device);
      assertDeviceAccess([d], "compare_client_checks", "READ");
      const s = (await workspaceStore()).get<CheckSession>("client-check", a.id, d),
        first = s?.runs.find((r) => r.id === a.first),
        second = s?.runs.find((r) => r.id === a.second);
      if (!first || !second) throw new Error("Choose two saved runs in this router's session.");
      return JSON.stringify(compareRuns(first, second));
    },
  }),
  defineTool({
    name: "close_client_check",
    title: "Revoke a Client Check Invitation",
    annotations: WRITE,
    description:
      "Immediately close the selected test invitation. Rejects further measurements while retaining saved history. No router configuration changes.",
    inputSchema: { id: z.uuid() },
    async handler(a, ctx) {
      const d = resolveDeviceName(ctx.device);
      assertDeviceAccess([d], "close_client_check", "WRITE");
      const store = await workspaceStore(),
        s = store.get<CheckSession>("client-check", a.id, d);
      if (!s) throw new Error("Check not found.");
      s.status = "closed";
      store.save("client-check", s);
      return JSON.stringify(publicSession(s));
    },
  }),
];
