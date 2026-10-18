import { z } from "zod";
import { defineTool, READ, WRITE } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { addressSetInput, composeAddressSet, referenceSchema } from "../address-sets/model";
import {
  applyAddressSet,
  createAddressSet,
  listAddressSets,
  previewAddressSet,
} from "../address-sets/service";

export const addressSetTools: ToolModule = [
  defineTool({
    name: "compose_address_set",
    title: "Compose an Address Set",
    annotations: READ,
    description:
      "Pure IPv4/IPv6 CIDR union, intersection or difference. Normalizes, deduplicates and compacts exact coverage; returns checksum and exact address count. Source is a provenance label, never fetched/executed. No router or disk I/O.",
    inputSchema: addressSetInput.shape,
    handler(a) {
      return JSON.stringify(composeAddressSet(a));
    },
  }),
  defineTool({
    name: "list_address_sets",
    title: "List Address Set Revisions",
    annotations: READ,
    description:
      "Read the newest 100 locally persisted address-set revisions for the selected device, including publication state and rollback references. No router I/O.",
    inputSchema: {},
    async handler(_, ctx) {
      return JSON.stringify(await listAddressSets(ctx));
    },
  }),
  defineTool({
    name: "create_address_set",
    title: "Save Address Set Revision",
    annotations: WRITE,
    description:
      "Save an immutable non-empty CIDR composition with checksum, provenance and optional parent revision. Local write only; never changes a router. Input at most 2048 prefixes per operand, output at most 4096. Publication currently capped at 64 compacted prefixes to preserve Safe Mode undo coverage.",
    inputSchema: addressSetInput.shape,
    async handler(a, ctx) {
      return JSON.stringify(await createAddressSet(a, ctx));
    },
  }),
  defineTool({
    name: "preview_address_set",
    title: "Preview Address Set Publication or Rollback",
    annotations: READ,
    description:
      "Read current rules and prepare a two-minute state-bound preview. Explicitly select 1–8 filter/mangle rule IDs, address-list fields and expected old list names. Creates a new generation without deleting old/manual entries. Rollback restores only these references, retaining generations. Never changes router configuration; use apply_address_set only after explicit review. Not an atomic packet-wide swap.",
    inputSchema: {
      id: z.uuid(),
      references: referenceSchema.array().max(8).default([]),
      rollback: z.boolean().default(false),
      allowLargeChange: z
        .boolean()
        .default(false)
        .describe("Explicitly acknowledge /0 or coverage changing by more than 50% of the parent"),
    },
    async handler(a, ctx) {
      return JSON.stringify(
        await previewAddressSet(a.id, a.references, a.rollback, ctx, a.allowLargeChange),
      );
    },
  }),
  defineTool({
    name: "apply_address_set",
    title: "Apply Approved Address Set Preview",
    annotations: WRITE,
    description:
      "After explicit confirmation: capture a local backup, acquire exclusive Safe Mode, recheck preview fingerprint, create the generation, switch only selected references, verify exact contents and commit. Maximum 64 prefixes + 8 references, SSH only. Failure/ambiguous commit is uncertain and never automatically retried. Rollback previews preserve all lists. Requires fresh preview id and confirm=true.",
    inputSchema: { id: z.uuid(), planId: z.uuid(), confirm: z.boolean().default(false) },
    async handler(a, ctx) {
      return JSON.stringify(await applyAddressSet(a.id, a.planId, a.confirm, ctx));
    },
  }),
];
