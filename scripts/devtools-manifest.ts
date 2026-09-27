import { effectiveUi } from "../src/core/registry";
import { UI_VIEWS } from "../src/core/ui-resources";
import { listPrompts } from "../src/prompts";
import { ALWAYS_ON_MODULES, moduleCatalog } from "../src/tools";
import { VERSION } from "../src/version";

/** Public declarations only; never serialize tool handlers or runtime configuration. */
export function buildDevtoolsManifest() {
  return {
    format: 1,
    version: VERSION,
    modules: moduleCatalog.map((module) => ({
      slug: module.slug,
      label: module.label,
      group: module.group,
      description: module.description,
      alwaysOn: ALWAYS_ON_MODULES.has(module.slug),
      tools: module.tools.map((tool) => tool.name),
    })),
    tools: moduleCatalog.flatMap((module) =>
      module.tools.map((tool) => {
        const { ui, auto } = effectiveUi(tool);
        return {
          name: tool.name,
          module: module.slug,
          group: module.group,
          noDevice: tool.noDevice === true,
          requires: tool.requires
            ? {
                ...tool.requires,
                ...(tool.requires.board ? { board: tool.requires.board.toString() } : {}),
              }
            : null,
          ui: ui ? { ...ui, automatic: auto } : null,
        };
      }),
    ),
    appViews: UI_VIEWS,
    prompts: listPrompts(),
  };
}
