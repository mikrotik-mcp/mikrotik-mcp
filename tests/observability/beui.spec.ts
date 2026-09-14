/// <reference types="node" />
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vite-plus/test";
import manifest from "../../ui/observability/components/beui/registry-manifest.json";
import { VIEWS, parseViewHash } from "../../ui/observability/navigation";
import { DASHBOARD_API_PATH } from "../../ui/observability/dev-routing";

const base = resolve(import.meta.dirname, "../../ui/observability/components/beui");

test("retained BeUI collections match installed components and retain their license", () => {
  const slugs = manifest.components.map((item) => item.slug);
  expect([...slugs].sort()).toEqual([
    "action-swap",
    "animated-badge",
    "animated-sidebar",
    "button",
    "checkbox",
    "dynamic-island",
    "expandable-action-bar",
    "input",
    "loader",
    "pull-to-refresh",
    "select",
    "shared-layout-bg",
    "switch",
    "tabs",
    "theme-toggle",
    "tooltip",
  ]);
  expect(new Set(slugs).size).toBe(slugs.length);
  const componentFiles = new Set<string>();
  for (const item of manifest.components) {
    for (const file of item.files) {
      expect(file).not.toContain("..");
      expect(file.startsWith("/")).toBe(false);
      expect(existsSync(resolve(base, "registry", file))).toBe(true);
      if (file.startsWith("components/")) componentFiles.add(file);
    }
  }
  const installed = readdirSync(resolve(base, "registry/components"), {
    recursive: true,
    encoding: "utf8",
  })
    .filter((file) => /\.[jt]sx?$/.test(file))
    .map((file) => `components/${file.replaceAll("\\", "/")}`);
  expect(installed.sort()).toEqual([...componentFiles].sort());
  expect(readFileSync(resolve(base, "LICENSE"), "utf8")).toContain("MIT License");
});

test("all dashboard pages accept both bookmark formats", () => {
  for (const { id } of VIEWS) {
    expect(parseViewHash(`#${id}`)).toBe(id);
    expect(parseViewHash(`#/${id}`)).toBe(id);
  }
  for (const hash of [
    "",
    "#unknown",
    "#components",
    "#dashboard-content",
    "#//devices",
    "#devices/other",
  ])
    expect(parseViewHash(hash)).toBeNull();
});

test("development proxy forwards APIs and streams, never frontend modules", () => {
  const api = new RegExp(DASHBOARD_API_PATH);
  for (const path of ["/api/devices", "/api/stats", "/api/stream", "/api/sse", "/api/config"])
    expect(api.test(path)).toBe(true);
  for (const path of ["/api.ts", "/api.ts?t=123", "/main.tsx", "/design-preview.html", "/"])
    expect(api.test(path)).toBe(false);
});
