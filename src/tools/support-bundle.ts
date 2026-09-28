import { z } from "zod";
import { defineTool, READ, WRITE } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { resolveDeviceName } from "../core/runtime";
import { assertDeviceAccess } from "../core/scoped-access";
import { workspaceStore } from "../workspaces/store";
import { bundleInput, bundleHtml } from "../support/bundle";
import type { Bundle } from "../support/bundle";
import { createBundle } from "../support/service";

export const supportBundleTools: ToolModule = [
  defineTool({
    name: "create_support_bundle",
    title: "Prepare a Minimised Support Report",
    annotations: WRITE,
    description:
      "Build a local support package for at most seven days using selected investigations, event metadata, snapshot section counts and client-check summaries. No live router queries or uploads. Excludes raw logs/exports/tool bodies, secrets, comments and personal labels BEFORE persistence; aliases network identifiers consistently within this bundle. Missing evidence remains unknown. Review timestamps/counts/relationships before sharing: minimisation is not absolute anonymity.",
    inputSchema: bundleInput.shape,
    handler: async (a, ctx) => JSON.stringify(await createBundle(a, ctx.device)),
  }),
  defineTool({
    name: "list_support_bundles",
    title: "Read Local Support Reports",
    annotations: READ,
    description:
      "Read minimised locally saved support reports for this router. Does not send reports to anyone.",
    inputSchema: {},
    async handler(_a, ctx) {
      const d = resolveDeviceName(ctx.device);
      assertDeviceAccess([d], "list_support_bundles", "READ");
      return JSON.stringify(
        (await workspaceStore()).list<Bundle>("support", d).filter((b) => {
          try {
            assertDeviceAccess(b.devices, "list_support_bundles", "READ");
            return true;
          } catch {
            return false;
          }
        }),
      );
    },
  }),
  defineTool({
    name: "export_support_bundle",
    title: "Export a Reviewed Support Report",
    annotations: READ,
    description:
      "Return a saved, minimised support report as JSON or self-contained script-free HTML. No filesystem path or external destination is accepted. Review before sharing; no automatic upload.",
    inputSchema: { id: z.uuid(), format: z.enum(["json", "html"]).default("json") },
    async handler(a, ctx) {
      const d = resolveDeviceName(ctx.device);
      assertDeviceAccess([d], "export_support_bundle", "READ");
      const b = (await workspaceStore()).get<Bundle>("support", a.id, d);
      if (!b) throw new Error("Report not found.");
      assertDeviceAccess(b.devices, "export_support_bundle", "READ");
      return a.format === "html"
        ? bundleHtml(b)
        : JSON.stringify({ report: b.report, digest: b.digest });
    },
  }),
  defineTool({
    name: "delete_support_bundle",
    title: "Delete a Local Support Report",
    annotations: WRITE,
    description:
      "Delete this saved minimised report only after explicit approval. Original investigations, snapshots and events are retained; exported copies cannot be revoked.",
    inputSchema: { id: z.uuid(), confirm: z.boolean().default(false) },
    async handler(a, ctx) {
      const d = resolveDeviceName(ctx.device);
      assertDeviceAccess([d], "delete_support_bundle", "WRITE");
      if (!a.confirm) throw new Error("Confirm report deletion.");
      (await workspaceStore()).delete("support", a.id, d);
      return JSON.stringify({ deleted: true });
    },
  }),
];
