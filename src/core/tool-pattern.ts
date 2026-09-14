/** Case-insensitive, whole-name tool glob. Only `*` is special; regex syntax is literal. */
export function globMatch(pattern: string, name: string): boolean {
  const rx = new RegExp(
    `^${pattern
      .toLowerCase()
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")}$`,
  );
  return rx.test(name.toLowerCase());
}
