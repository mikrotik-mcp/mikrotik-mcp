/** RouterOS attribute text, including escaped quotes and unquoted values. */
export function redactContainerText(text: string): string {
  return text
    .replace(
      /^(\s*(?:env(?:-current)?|password|(?:default-)?(?:cmd|entrypoint|shell|healthcheck-cmd)|config-json):)[ \t]*[^\r\n]*/gm,
      "$1 ***",
    )
    .replace(
      /(^|\s)(env(?:-current)?|value|password|(?:default-)?(?:cmd|entrypoint|shell|healthcheck-cmd)|config-json)=("(?:\\.|[^"\\])*(?:"|$)|[^\s]*)/g,
      '$1$2="***"',
    );
}

/** Keep command bytes intact for transport; log only the container command path. */
export function containerCommandForLog(command: string): string {
  if (!/\/container(?:[\s/]|$)/.test(command)) return command;
  const prefix =
    command.match(/^\[[^\]\r\n]+\] Executing (?:MikroTik command|\(safe mode\)): /)?.[0] ?? "";
  return `${prefix}${command.match(/\/container(?:[ /](?:config|envs|mounts))?[ /](?:[a-z-]+)/)?.[0] ?? "/container"} [arguments omitted]`;
}

/** Tool-specific fields whose generic names would bypass normal key redaction. */
export function redactContainerInput(tool: string, args: unknown): unknown {
  if (
    !/(?:^|_)container(?:_|$)/.test(tool) ||
    !args ||
    typeof args !== "object" ||
    Array.isArray(args)
  )
    return args;
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [
      key,
      ["env", "value", "cmd", "entrypoint", "password"].includes(key) &&
      value != null &&
      value !== ""
        ? "«redacted»"
        : value,
    ]),
  );
}
