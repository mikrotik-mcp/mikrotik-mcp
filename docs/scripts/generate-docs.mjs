import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { listPrompts } from "../../src/prompts/index.ts";

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const catalog = read("../../schemas/tool-catalog.json");
const manifest = read("../../schemas/devtools-manifest.json");
const tools = new Map(catalog.tools.map((tool) => [tool.name, tool]));
const destination = new URL("../content/docs/reference/", import.meta.url);
const front = (title, description) =>
  `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\n---\n\n`;
const cell = (value) => String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
let index = front(
  "Tool reference",
  `${tools.size} tools across ${manifest.modules.length} modules, generated from the release catalog.`,
);
index +=
  "Select a module for its supported operations, input constraints and risk annotations. The optional `device` argument selects a configured router; omitting it uses the configured default.\n\n";
for (const module of manifest.modules) {
  let text = front(module.label, module.description);
  text += `## Tools\n\n${module.tools
    .map((name) => `- [${tools.get(name).title}](#${name})`)
    .join("\n")}\n\n`;
  for (const name of module.tools) {
    const tool = tools.get(name);
    if (!tool) throw new Error(`Catalog is missing ${name}`);
    text += `## ${name}\n\n**${tool.title}** · Risk: **${tool.risk}**\n\n${tool.description}\n\n`;
    const schema = tool.inputSchema;
    const properties = Object.entries(schema.properties ?? {});
    if (properties.length) {
      text += "| Parameter | Required | Definition |\n| --- | --- | --- |\n";
      for (const [key, { description = "", $schema, ...constraints }] of properties) {
        text += `| \`${key}\` | ${(schema.required ?? []).includes(key) ? "Yes" : "No"} | ${cell(description)} \`${cell(JSON.stringify(constraints))}\` |\n`;
      }
      text += "\n";
    } else text += "No tool-specific parameters.\n\n";
  }
  writeFileSync(new URL(`${module.slug}.md`, destination), text);
}
writeFileSync(new URL("index.md", destination), index);
writeFileSync(
  new URL("meta.json", destination),
  `${JSON.stringify(
    {
      title: "Tool reference",
      root: true,
      description: "Parameters, operations and risk levels",
      pages: [
        "index",
        ...[...new Set(manifest.modules.map((module) => module.group))].flatMap((group) => [
          `---${group}---`,
          ...manifest.modules
            .filter((module) => module.group === group)
            .map((module) => module.slug),
        ]),
      ],
    },
    null,
    2,
  )}\n`,
);
process.stdout.write(
  `Generated ${tools.size} tools across ${manifest.modules.length} modules in ${fileURLToPath(destination)}\n`,
);

const guides = new URL("../content/docs/guides/", import.meta.url);
const config = read("../../schemas/config.schema.json");
let configText = front(
  "Configuration schema",
  "Every configuration block, default and validation rule, generated from the runtime schema.",
);
configText +=
  "Use these definitions inside your `devices.json`. Defaults apply only when a value is omitted. Environment variables and CLI flags can override supported fields; see [Configuration](/docs/guides/configuration) and [CLI](/docs/guides/cli). Required properties are listed inside each object. Optional secrets are not example values.\n\n";
for (const [name, definition] of Object.entries(config.properties)) {
  configText += `## ${name}\n\n\`\`\`json\n${JSON.stringify(definition, null, 2)}\n\`\`\`\n\n`;
}
writeFileSync(new URL("config-schema.md", guides), configText);

const prompts = listPrompts();
let promptText = front(
  "Prompt catalog",
  `${prompts.length} guided workflows and their supported arguments, generated from the prompt loader.`,
);
promptText +=
  "Select a workflow in your MCP client's prompt picker, supply its arguments, then review the assistant's plan. A prompt guides an LLM; it does not grant permission, guarantee rollback or bypass tool access controls. Confirm risky changes and verify their results. [Authoring and invocation](/docs/guides/prompts).\n\n";
for (const prompt of prompts) {
  promptText += `## ${prompt.name}\n\n**${prompt.title}**\n\n${prompt.description}\n\n`;
  if (prompt.arguments.length) {
    promptText += "| Argument | Required | Purpose |\n| --- | --- | --- |\n";
    for (const arg of prompt.arguments)
      promptText += `| \`${arg.name}\` | ${arg.required ? "Yes" : "No"} | ${cell(arg.description ?? "")} |\n`;
    promptText += "\n";
  } else promptText += "No required workflow arguments.\n\n";
  promptText += `[Read the workflow](https://github.com/mikrotik-mcp/mikrotik-mcp/blob/main/prompts/${prompt.name}.md).\n\n`;
}
writeFileSync(new URL("prompt-catalog.md", guides), promptText);
process.stdout.write(
  `Generated ${Object.keys(config.properties).length} configuration blocks and ${prompts.length} prompts.\n`,
);
