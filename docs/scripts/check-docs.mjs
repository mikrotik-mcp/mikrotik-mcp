import { existsSync, readdirSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import GithubSlugger from "github-slugger";
import { toString } from "mdast-util-to-string";
import { VIEWS } from "../../ui/observability/navigation.ts";
import { listPrompts } from "../../src/prompts/index.ts";

const root = new URL("../", import.meta.url);
const content = new URL("content/docs/", root);
const catalog = JSON.parse(
  readFileSync(new URL("../../schemas/tool-catalog.json", import.meta.url), "utf8"),
);
const manifest = JSON.parse(
  readFileSync(new URL("../../schemas/devtools-manifest.json", import.meta.url), "utf8"),
);
const coverage = JSON.parse(readFileSync(new URL("coverage.json", root), "utf8"));
const captures = JSON.parse(
  readFileSync(new URL("screenshot-capture.json", root), "utf8"),
).captures;
const migrations = JSON.parse(readFileSync(new URL("migration-map.json", root), "utf8"));
for (const migration of migrations) {
  assert(
    existsSync(new URL(`../${migration.destination}`, root)),
    `Missing migrated document: ${migration.source}`,
  );
}
const captureById = new Map(captures.map((capture) => [capture.id, capture]));
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(new URL(`${entry.name}/`, dir)) : [new URL(entry.name, dir)],
  );
}
const pages = files(content).filter(
  (file) => file.pathname.endsWith(".md") || file.pathname.endsWith(".mdx"),
);
const parser = unified().use(remarkParse).use(remarkGfm);
/** Read real Markdown links and headings, excluding code examples and frontmatter. */
function inspectMarkdown(text) {
  const tree = parser.parse(text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ""));
  const slugger = new GithubSlugger();
  const headings = new Set();
  const links = [];
  const references = [];
  const definitions = new Map();
  function visit(node) {
    if (node.type === "heading") headings.add(slugger.slug(toString(node)));
    if (node.type === "link" || node.type === "image") links.push(node.url);
    if (node.type === "definition") definitions.set(node.identifier, node.url);
    if (node.type === "linkReference" || node.type === "imageReference")
      references.push(node.identifier);
    for (const child of node.children ?? []) visit(child);
  }
  visit(tree);
  for (const reference of references) {
    assert(definitions.has(reference), `Unresolved Markdown reference: ${reference}`);
    links.push(definitions.get(reference));
  }
  return { headings, links };
}
// The checker must preserve RouterOS tool underscores and ignore links in code blocks.
const fixture = inspectMarkdown(
  "---\ntitle: Example\n---\n## get_dns_settings\n## get_dns_settings\n[Tool](#get_dns_settings)\n[Guide][guide]\n\n[guide]: ../guide.md#intro\n```md\n[Not a link](/missing)\n```",
);
assert.deepEqual([...fixture.headings], ["get_dns_settings", "get_dns_settings-1"]);
assert.deepEqual(fixture.links, ["#get_dns_settings", "../guide.md#intro"]);
const routeFor = (file) =>
  `/docs/${file.pathname
    .slice(content.pathname.length)
    .replace(/\.mdx?$/, "")
    .replace(/(^|\/)index$/, "")}`.replace(/\/$/, "");
const routes = new Map(
  pages.map((file) => [routeFor(file), inspectMarkdown(readFileSync(file, "utf8"))]),
);
const linkErrors = [];
for (const page of pages) {
  const route = routeFor(page);
  for (const href of routes.get(route).links) {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) continue;
    const target = new URL(href, `https://docs.invalid${route}`);
    const path = decodeURIComponent(target.pathname)
      .replace(/\.mdx?$/, "")
      .replace(/\/index$/, "")
      .replace(/\/$/, "");
    if (path.startsWith("/docs")) {
      const destination = routes.get(path);
      if (!destination) linkErrors.push(`${route}: missing page ${href}`);
      else if (target.hash && !destination.headings.has(decodeURIComponent(target.hash.slice(1))))
        linkErrors.push(`${route}: missing heading ${href}`);
    } else if (path !== "" && !existsSync(new URL(`public${target.pathname}`, root))) {
      linkErrors.push(`${route}: missing asset ${href}`);
    }
    if (!path.startsWith("/screenshots/")) continue;
    const id = path
      .split("/")
      .at(-1)
      .replace(/\.jpg$/, "");
    const capture = captureById.get(id);
    assert(capture?.fullPage === true, `Missing full-page capture record: ${id}`);
    assert(capture.height >= capture.viewportHeight, `Cropped capture: ${id}`);
  }
}
assert.deepEqual(linkErrors, [], "Documentation links must resolve, including heading anchors");
const configSchema = JSON.parse(
  readFileSync(new URL("../schemas/config.schema.json", root), "utf8"),
);
assert.deepEqual(
  [...routes.get("/docs/guides/config-schema").headings],
  Object.keys(configSchema.properties).map((name) => name.toLowerCase()),
  "Configuration schema coverage mismatch",
);
assert.deepEqual(
  [...routes.get("/docs/guides/prompt-catalog").headings],
  listPrompts().map((prompt) => prompt.name),
  "Prompt catalog coverage mismatch",
);
const documented = [];
for (const module of manifest.modules) {
  const page = readFileSync(new URL(`reference/${module.slug}.md`, content), "utf8");
  const names = [...page.matchAll(/^## (\w+)$/gm)]
    .map((match) => match[1])
    .filter((name) => name !== "Tools");
  assert.deepEqual(names, module.tools, `${module.slug}: tool coverage drift`);
  documented.push(...names);
}
assert.deepEqual(
  [...documented].sort((a, b) => a.localeCompare(b)),
  catalog.tools.map((tool) => tool.name).sort((a, b) => a.localeCompare(b)),
  "Tool reference coverage mismatch",
);
for (const view of VIEWS) {
  assert(
    existsSync(new URL(`dashboard/${view.id}.md`, content)),
    `Missing dashboard guide: ${view.id}`,
  );
  assert(
    existsSync(new URL(`public/screenshots/${view.id}.jpg`, root)),
    `Missing dashboard screenshot: ${view.id}`,
  );
  assert(
    captures.some((capture) => capture.id === view.id && capture.fullPage === true),
    `Screenshot is not recorded as full-page: ${view.id}`,
  );
  const review = coverage.dashboard.find((page) => page.id === view.id);
  assert(review, `Missing coverage entry: ${view.id}`);
  if (review.detailsReviewed) {
    assert(review.reviewedSources?.length, `Missing review evidence: ${view.id}`);
    for (const source of review.reviewedSources)
      assert(existsSync(new URL(`../${source}`, root)), `Missing reviewed source: ${source}`);
  }
}
const pending = coverage.dashboard.filter((page) => !page.detailsReviewed);
process.stdout.write(
  `${pages.length} pages; ${documented.length} tools; ${VIEWS.length} dashboard pages and screenshots; internal links resolve.\n`,
);
process.stdout.write(`${pending.length} dashboard detail reviews remain.\n`);
if (process.argv.includes("--complete"))
  assert.equal(pending.length, 0, "Full documentation review is incomplete");
