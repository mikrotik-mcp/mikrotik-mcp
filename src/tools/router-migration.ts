import { z } from "zod";
import { defineTool, READ, WRITE, DESTRUCTIVE } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { resolveDeviceName } from "../core/runtime";
import { assertDeviceAccess } from "../core/scoped-access";
import { workspaceStore } from "../workspaces/store";
import { migrationInput } from "../migration/model";
import type { MigrationPlan } from "../migration/model";
import {
  migrationInventory,
  previewMigration,
  applyMigration,
  undoMigration,
} from "../migration/service";

export const routerMigrationTools: ToolModule = [
  defineTool({
    name: "inspect_router_migration",
    title: "Inspect Router Migration Capabilities",
    annotations: READ,
    description:
      "Read router hardware, RouterOS version, installed packages and interfaces for a replacement migration. Does not expose the raw export or change configuration. Use a dedicated, unmapped management port on target.",
    inputSchema: {},
    async handler(_a, ctx) {
      const { export: _, ...info } = await migrationInventory(resolveDeviceName(ctx.device));
      return JSON.stringify(info);
    },
  }),
  defineTool({
    name: "preview_router_migration",
    title: "Preview a Router Replacement",
    annotations: WRITE,
    description:
      "Read source and target, map physical Ethernet ports and persist a five-minute, device-bound staging plan. Select supported sections; incompatible fields, collisions and unresolved dependencies BLOCK staging. Lists ALL unselected/unsupported sections as manual work. Same RouterOS 7 version required. Never copies credentials, certificates, scripts, Wi-Fi drivers or VPN secrets, and never changes target management. Preview changes local state only.",
    inputSchema: migrationInput.shape,
    handler: async (a, ctx) => JSON.stringify(await previewMigration(a, ctx.device)),
  }),
  defineTool({
    name: "list_router_migrations",
    title: "Read Router Migration Plans",
    annotations: READ,
    description:
      "Read durable migration previews, backup references, rehearsal/staging outcomes and manual cutover items for the selected TARGET router.",
    inputSchema: {},
    async handler(_a, ctx) {
      const d = resolveDeviceName(ctx.device);
      assertDeviceAccess([d], "list_router_migrations", "READ");
      const plans = (await workspaceStore()).list<MigrationPlan>("migration", d);
      for (const p of plans) assertDeviceAccess([p.input.source], "list_router_migrations", "READ");
      return JSON.stringify(plans);
    },
  }),
  defineTool({
    name: "apply_router_migration",
    title: "Rehearse or Stage an Approved Migration",
    annotations: WRITE,
    description:
      "Only after user reviews the exact preview: back up source and target locally, reject stale state, acquire NEW Safe Mode, apply at most 60 additive objects and read each back. Default rehearse rolls back and verifies the original export; stage commits INACTIVE addresses, ports, DHCP, routes and firewall rules. Never resets a router or activates duplicate networks. Manual physical cutover, secrets and application verification remain required. No direct-write fallback; uncertain results must not be retried.",
    inputSchema: {
      id: z.uuid(),
      mode: z.enum(["rehearse", "stage"]).default("rehearse"),
      confirm: z.boolean().default(false),
      acknowledgeManual: z.boolean().default(false),
    },
    handler: async (a, ctx) =>
      JSON.stringify(
        await applyMigration(a.id, a.mode, a.confirm, a.acknowledgeManual, ctx.device),
      ),
  }),
  defineTool({
    name: "undo_router_migration",
    title: "Remove Unchanged Staged Migration Objects",
    annotations: DESTRUCTIVE,
    description:
      "After explicit approval remove ONLY this plan's staged objects under Safe Mode, provided none was edited or activated. Verify target export matches pre-migration snapshot before commit. Refuses uncertain migrations; never wipes unrelated target configuration.",
    inputSchema: { id: z.uuid(), confirm: z.boolean().default(false) },
    handler: async (a, ctx) => JSON.stringify(await undoMigration(a.id, a.confirm, ctx.device)),
  }),
];
