/**
 * Configuration templates: RouterOS script text with `{{variable}}` places, so
 * one reviewed configuration can be applied to many routers with different
 * values. PURE.
 *
 * A place stands for one whole value: `/system identity set name={{identity}}`.
 * The value is written as a RouterOS value (quoted when it needs quotes), so a
 * value can never add a parameter or a second command. For the same reason a
 * place may not be inside quotes; the template is refused when one is.
 *
 * `{{name|default}}` gives a default for a variable that is not passed.
 */
import { quoteValue } from "./routeros";

const PLACE = /\{\{\s*([A-Za-z][A-Za-z0-9_]{0,40})\s*(?:\|([^{}]*))?\}\}/g;

export interface TemplateVariable {
  name: string;
  /** The default, when the template gives one. */
  default?: string;
}

/** The variables of a template, in the order they first appear. */
export function templateVariables(text: string): TemplateVariable[] {
  const seen = new Map<string, TemplateVariable>();
  for (const match of text.matchAll(PLACE)) {
    const name = match[1]!;
    const fallback = match[2]?.trim();
    const known = seen.get(name);
    if (!known) seen.set(name, { name, default: fallback });
    else if (known.default === undefined && fallback !== undefined) known.default = fallback;
  }
  return Array.from(seen.values());
}

/** Why a template cannot be used, or an empty list. */
export function checkTemplate(text: string): string[] {
  const problems: string[] = [];
  text.split("\n").forEach((line, index) => {
    // Walk the line and note whether each place starts inside a quoted string.
    let inString = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (inString && char === "\\") i += 1;
      else if (char === '"') inString = !inString;
      else if (inString && line.startsWith("{{", i))
        problems.push(
          `Line ${index + 1}: a {{place}} is inside quotes. Write name={{var}} with no quotes; the value is quoted for you.`,
        );
    }
    const stray = line.replace(PLACE, "");
    if (stray.includes("{{") || stray.includes("}}"))
      problems.push(`Line ${index + 1}: '{{' or '}}' that is not a valid {{variable}}.`);
  });
  if (text.trim() === "") problems.push("The template is empty.");
  return problems;
}

/**
 * The template with every place replaced by its value. Throws with the names
 * of the variables that have no value and no default.
 */
export function renderTemplate(text: string, values: Record<string, string>): string {
  const missing = templateVariables(text)
    .filter((v) => values[v.name] === undefined && v.default === undefined)
    .map((v) => v.name);
  if (missing.length > 0) throw new Error(`No value for: ${missing.join(", ")}`);
  const defaults = new Map(templateVariables(text).map((v) => [v.name, v.default]));
  return text.replace(PLACE, (_, name: string) =>
    quoteValue(values[name] ?? defaults.get(name) ?? ""),
  );
}

const VERB =
  /(?:^|\s)(?:add|set|remove|enable|disable|unset|move|import|export|print|reset|run|edit|find|get|comment)(?:\s|$)/;

/**
 * The commands of a rendered template. Two styles are read:
 * full commands (`/ip address add address=…`), and export style, where a line
 * that is only a menu (`/ip address`) applies to the lines under it (`add …`).
 * A line that ends with `\` continues on the next line. `#` lines are comments.
 */
export function templateCommands(rendered: string): string[] {
  const commands: string[] = [];
  let menu = "";
  let pending = "";
  for (const raw of rendered.replace(/\r\n?/g, "\n").split("\n")) {
    const piece = raw.trim();
    if (piece.endsWith("\\")) {
      pending += `${piece.slice(0, -1).trimEnd()} `;
      continue;
    }
    const line = (pending + piece).trim();
    pending = "";
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("/")) {
      // A menu line has no value and no verb: it sets the place for what follows.
      if (!line.includes("=") && !VERB.test(line)) {
        menu = line;
        continue;
      }
      commands.push(line);
    } else if (line.startsWith(":") || menu === "") commands.push(line);
    else commands.push(`${menu} ${line}`);
  }
  return commands;
}
