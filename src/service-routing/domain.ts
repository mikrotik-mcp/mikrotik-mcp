import { z } from "zod";

/** Only a literal DNS name or one leading wildcard. Never accept arbitrary RouterOS regex. */
export const routingDomain = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .refine((value) => {
    const base = value.startsWith("*.") ? value.slice(2) : value;
    const labels = base.split(".");
    return (
      labels.length >= 2 &&
      !/^\d+(?:\.\d+){3}$/.test(base) &&
      labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) &&
      !/^\d+$/.test(labels.at(-1)!)
    );
  }, "Enter a domain such as api.example.com or *.example.com; no URL, port, path or other wildcard.");

export const isWildcard = (domain: string): boolean => domain.startsWith("*.");

export function domainMatches(domain: string, host: string): boolean {
  const candidate = host.toLowerCase();
  return isWildcard(domain)
    ? candidate.endsWith(domain.slice(1)) && candidate.length > domain.length - 1
    : candidate === domain;
}

/** POSIX-compatible, anchored and derived exclusively from validated labels; excludes the apex. */
export function wildcardRegexp(domain: string): string {
  const checked = routingDomain.parse(domain);
  if (!isWildcard(checked)) throw new Error("A wildcard domain is required.");
  return `^([a-z0-9-]+[.])+${checked.slice(2).replaceAll(".", "[.]")}$`;
}

/** Only prove non-overlap for our own narrow regex grammar; arbitrary DNS regex stays a conflict. */
export function wildcardRegexOverlaps(regexp: string, domain: string): boolean {
  const prefix = "^([a-z0-9-]+[.])+";
  if (!regexp.startsWith(prefix) || !regexp.endsWith("$")) return true;
  const base = regexp.slice(prefix.length, -1).replaceAll("[.]", ".");
  if (!routingDomain.safeParse(base).success || wildcardRegexp(`*.${base}`) !== regexp) return true;
  const candidate = domain.slice(2);
  return candidate === base || candidate.endsWith(`.${base}`) || base.endsWith(`.${candidate}`);
}
