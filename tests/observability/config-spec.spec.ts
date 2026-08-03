/**
 * The Config page's hand-authored form spec must stay pinned to the generated
 * JSON Schema. A key that drifts (renamed, moved, mistyped) does not fail loudly
 * in the browser — the control just edits a property the server then rejects or
 * drops, so the round-trip silently loses the setting. These checks are the
 * cheapest place to catch that.
 *
 * The Raycast extension renders the same form from its own hand-kept copy of the
 * spec, so the last check pins the two files to each other.
 */
import { describe, expect, it } from "vite-plus/test";
import schema from "../../schemas/config.schema.json" with { type: "json" };
import * as raycastSpec from "../../raycast/src/config-spec";
import { CONFIG_SECTIONS, DEVICE_FIELDS } from "../../ui/observability/config-spec";
import type { CfgField } from "../../ui/observability/config-spec";

type Node = Record<string, any>;

/** Resolve a dotted key against a schema node, or undefined if any hop is missing. */
function resolve(node: Node | undefined, key: string): Node | undefined {
  return key
    .split(".")
    .reduce<Node | undefined>((n, k) => n?.properties?.[k] as Node | undefined, node);
}

const root = schema as unknown as Node;
const deviceNode = root.properties.devices.additionalProperties as Node;

/** Section id → the schema node holding that section's fields. */
const sectionNode = (path: string | undefined): Node =>
  path ? (root.properties[path] as Node) : root;

function checkField(node: Node | undefined, f: CfgField, where: string): void {
  const prop = resolve(node, f.key);
  expect(prop, `${where}.${f.key} is not in the schema`).toBeDefined();
  const t = prop!.type as string | undefined;
  if (f.type === "bool") expect(t, `${where}.${f.key}`).toBe("boolean");
  if (f.type === "list") expect(t, `${where}.${f.key}`).toBe("array");
  if (f.type === "number") expect(t, `${where}.${f.key}`).toMatch(/integer|number/);
  if (f.type === "select") expect(prop!.enum, `${where}.${f.key} options`).toEqual(f.options);
}

describe("config form spec ↔ schema", () => {
  it("every device field maps to a real device property", () => {
    for (const f of DEVICE_FIELDS) checkField(deviceNode, f, "devices.*");
  });

  it("every section field maps to a real property of its section", () => {
    for (const s of CONFIG_SECTIONS) {
      if (s.kind !== "object") continue;
      const node = sectionNode(s.path);
      expect(node, `section ${s.id} has no schema block`).toBeDefined();
      for (const f of s.fields) checkField(node, f, s.path ?? "(root)");
    }
  });

  it("every section path is a real top-level schema block", () => {
    for (const s of CONFIG_SECTIONS)
      if (s.path) expect(root.properties[s.path], `section ${s.id}`).toBeDefined();
  });

  it("every configurable top-level block is reachable from the form", () => {
    // Handled outside the section cards: devices/defaultDevice have their own
    // card, `tools` is the Modules card, `dashboard.feedLimit` is the prefs panel.
    const elsewhere = new Set(["devices", "defaultDevice", "tools"]);
    const covered = new Set(
      CONFIG_SECTIONS.flatMap((s) => (s.path ? [s.path] : s.fields.map((f) => f.key))),
    );
    const missing = Object.keys(root.properties as Node).filter(
      (k) => !covered.has(k) && !elsewhere.has(k),
    );
    expect(missing, "new config blocks must be added to CONFIG_SECTIONS").toEqual([]);
  });

  it("the Raycast copy of the spec matches", () => {
    expect(raycastSpec.DEVICE_FIELDS, "raycast/src/config-spec.ts drifted").toEqual(DEVICE_FIELDS);
    expect(raycastSpec.CONFIG_SECTIONS, "raycast/src/config-spec.ts drifted").toEqual(
      CONFIG_SECTIONS,
    );
  });
});
