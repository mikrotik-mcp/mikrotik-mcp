/** Portable prompt composition shared by MCP, the dashboard and Raycast. No I/O. */
export interface PromptTemplate {
  name: string;
  title: string;
  description: string;
  arguments: { name: string; description?: string; required?: boolean }[];
  body: string;
}

export function substitutePrompt(body: string, vars: Record<string, unknown>): string {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key: string) => {
    const value = Object.hasOwn(vars, key) ? vars[key] : undefined;
    if (value === undefined || value === null || value === "") return whole;
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
      return String(value);
    return JSON.stringify(value) ?? whole;
  });
}

export function promptCategory(prompt: PromptTemplate): string {
  const name = prompt.name;
  if (/diagnos|troubleshoot|health|investigat|slow|round-trip/.test(name)) return "Troubleshoot";
  if (/security|harden|audit|firewall|access|port-knock|port-scan|threat/.test(name))
    return "Security";
  if (/vpn|wireguard|tunnel|routing|bgp|ospf|ipsec|v2ray/.test(name)) return "VPN & routing";
  if (/backup|restore|recovery|upgrade|drift|rollout|fleet/.test(name)) return "Maintenance";
  return "Build & configure";
}

export function missingPromptArguments(prompt: PromptTemplate, values: Record<string, string>) {
  return prompt.arguments
    .filter(
      (arg) => arg.required && (!Object.hasOwn(values, arg.name) || !values[arg.name]?.trim()),
    )
    .map((arg) => arg.name);
}

/** Builds a draft only; never executes tools or transmits anything to an LLM. */
export function composePrompt(
  prompt: PromptTemplate,
  values: Record<string, string>,
  request = "",
  device = "",
): string {
  const missing = missingPromptArguments(prompt, values);
  if (missing.length) throw new Error(`Complete required fields: ${missing.join(", ")}`);
  const args = Object.fromEntries(
    prompt.arguments.map((arg) => [
      arg.name,
      (Object.hasOwn(values, arg.name) ? values[arg.name]?.trim() : "") ||
        "(not specified; ask if needed)",
    ]),
  );
  const body = substitutePrompt(prompt.body, args);
  return [
    `# ${prompt.title}`,
    `Workflow: ${prompt.name}`,
    device.trim()
      ? `Target device (configured MCP name): ${device.trim()}`
      : "Confirm the target router or routers with me before running tools.",
    request.trim() ? `## My request\n${request.trim()}` : "",
    `## Workflow\n${body}`,
    "## Execution boundary\nUse MikroTik MCP only if connected. Never invent observations or claim changes were applied without tool evidence. Ask for missing details and approval before configuration changes; take a recoverable backup first. If MCP is unavailable, provide a plan and explain that nothing was executed.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
