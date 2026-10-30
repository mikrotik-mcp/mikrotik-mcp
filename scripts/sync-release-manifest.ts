#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const version = process.argv[2];
const root = join(import.meta.dir, "..");
const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
if (!version || version !== packageVersion) {
  throw new Error("Release version must match the bumped package.json version.");
}

const path = join(root, "manifest.json");
const source = readFileSync(path, "utf8");
if (JSON.parse(source).version === version) process.exit(0);
const updated = source.replace(
  /^(\s*"version"\s*:\s*")[^"]*(")/m,
  (_match, start: string, end: string) => `${start}${version}${end}`,
);
if (updated === source || JSON.parse(updated).version !== version) {
  throw new Error("Could not update the manifest version.");
}
writeFileSync(path, updated);
