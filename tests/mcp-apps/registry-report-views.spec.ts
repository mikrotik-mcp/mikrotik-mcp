import { describe, expect, it } from "vite-plus/test";
import { defineTool, READ, WRITE } from "../../src/core/registry";
import {
  REPORT_VIEW_TOOLS,
  REPORT_VIEW_META,
  reportViewForTool,
} from "../../src/core/report-views";
import { moduleCatalog } from "../../src/tools/index";
import { UI_VIEWS, uiViewUri } from "../../src/core/ui-resources";

describe("new report coverage", () => {
  it("maps real tools exactly once to registered views", () => {
    const names = Object.values(REPORT_VIEW_TOOLS).flat();
    expect(new Set(names).size).toBe(names.length);
    const catalog = new Set(moduleCatalog.flatMap((m) => m.tools.map((t) => t.name)));
    for (const [kind, tools] of Object.entries(REPORT_VIEW_TOOLS)) {
      expect(UI_VIEWS.some((v) => v.id === kind)).toBe(true);
      for (const tool of tools) {
        expect(catalog.has(tool), tool).toBe(true);
        expect(reportViewForTool(tool)).toBe(kind);
      }
    }
    expect(reportViewForTool("remove_route")).toBeUndefined();
  });

  it.each([false, true])(
    "preserves structured contracts; appViews disabled=%s",
    async (disabled) => {
      let config: any, callback: any;
      const data = { ports: [], stats: { hosts: 0 } };
      defineTool({
        name: "map_l2_fabric",
        title: "Fabric",
        description: "fixture",
        annotations: READ,
        handler: () => ({ text: "No ports", structuredContent: data }),
      }).register(
        {
          registerTool: (_name: string, c: any, cb: any) => {
            config = c;
            callback = cb;
          },
        } as never,
        { appViews: !disabled },
      );
      const result = await callback({});
      expect(result.structuredContent).toBe(data);
      if (disabled) {
        expect(config._meta).toBeUndefined();
        expect(result._meta).toBeUndefined();
      } else {
        expect(config._meta.ui.resourceUri).toBe(uiViewUri("fabric"));
        expect(result._meta[REPORT_VIEW_META].data).toBe(data);
      }
    },
  );

  it("keeps write annotations and does not expose result-only views as app-callable", async () => {
    let config: any, callback: any;
    defineTool({
      name: "create_investigation",
      title: "Case",
      description: "fixture",
      annotations: WRITE,
      handler: () => JSON.stringify({ client: "192.0.2.1" }),
    }).register({
      registerTool: (_name: string, c: any, cb: any) => {
        config = c;
        callback = cb;
      },
    } as never);
    expect(config.annotations.readOnlyHint).not.toBe(true);
    expect(config._meta.ui.visibility).toEqual(["model"]);
    expect((await callback({})).structuredContent).toMatchObject({
      __mikrotikView: "report",
      data: { client: "192.0.2.1" },
    });
  });
});
