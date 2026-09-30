import { expect, it, vi } from "vite-plus/test";
import { rolldown } from "vite/rolldown";
import dashboardConfig from "../ui/vite.observability.config";

const configFor = async (isSsrBuild = false) => {
  if (typeof dashboardConfig !== "function") throw new Error("Expected dashboard config factory");
  return dashboardConfig({ command: "build", mode: "production", isSsrBuild });
};

it("filters only redundant client directive warnings, not other diagnostics or SSR", async () => {
  const clientDirective = {
    code: "MODULE_LEVEL_DIRECTIVE",
    message:
      'The semantics of the module level directive "use client" in "component.js" may not be preserved when bundling.',
  };
  for (const isSsrBuild of [false, true]) {
    const config = await configFor(isSsrBuild);
    const onLog = config.build!.rolldownOptions!.onLog!;
    const handler = vi.fn();
    onLog("warn", clientDirective, handler);
    expect(handler).toHaveBeenCalledTimes(isSsrBuild ? 1 : 0);
    handler.mockClear();
    for (const log of [
      { ...clientDirective, message: clientDirective.message.replace("use client", "use server") },
      { code: "UNRESOLVED_IMPORT", message: "Cannot resolve package" },
      { code: "PLUGIN_WARNING", message: clientDirective.message },
    ]) {
      onLog("warn", log, handler);
      expect(handler).toHaveBeenLastCalledWith("warn", log);
    }
    onLog("info", clientDirective, handler);
    expect(handler).toHaveBeenLastCalledWith("info", clientDirective);
  }
});

it("bundles client components without directive noise while retaining a bounded single-file budget", async () => {
  const config = await configFor();
  expect(config.build!.chunkSizeWarningLimit).toBe(2000);
  expect(config.build!.rolldownOptions!.output).toEqual({ codeSplitting: false });
  expect(config.build!.cssCodeSplit).toBe(false);
  expect(config.logLevel).not.toBe("silent");
  const diagnostics = vi.fn();
  const bundle = await rolldown({
    input: "entry.js",
    onLog: (level, log) => config.build!.rolldownOptions!.onLog!(level, log, diagnostics),
    plugins: [
      {
        name: "client-directive-fixture",
        resolveId: (id) => id,
        load: (id) =>
          id === "entry.js"
            ? 'export { value } from "client.js";'
            : '"use client"; export const value = 42;',
      },
    ],
  });
  try {
    const result = await bundle.generate({ format: "es", codeSplitting: false });
    expect(result.output).toHaveLength(1);
    expect(result.output[0]).toMatchObject({ type: "chunk", imports: [], dynamicImports: [] });
    expect(result.output[0]).toHaveProperty("exports", ["value"]);
    expect(diagnostics).not.toHaveBeenCalled();
  } finally {
    await bundle.close();
  }
});

it("still fails the build on real compilation errors", async () => {
  const config = await configFor();
  const bundle = await rolldown({
    input: "broken.js",
    onLog: config.build!.rolldownOptions!.onLog,
    plugins: [
      {
        name: "invalid-source-fixture",
        resolveId: (id) => id,
        load: () => "export const = 42;",
      },
    ],
  });
  try {
    await expect(bundle.generate({ format: "es" })).rejects.toThrow();
  } finally {
    await bundle.close();
  }
});
