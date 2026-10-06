import iranAsns from "../data/iran-asns.json";

// Split the name/description separator, not hyphens inside names such as IranCell-AS.
const labels = new Map(
  iranAsns.entries.map(({ asn, name }) => [asn, name.split(" - ", 1)[0].trim()]),
);

/** Offline dashboard label by ASN; unknown networks retain the sanitized provider name. */
export function getAsnOrganizationLabel(
  asn: string | undefined,
  organization: unknown,
): string | undefined {
  const label = asn ? labels.get(asn) : undefined;
  if (label) return label;
  if (typeof organization !== "string") return undefined;
  return (
    organization
      .replace(/\p{Cc}/gu, " ")
      .trim()
      .slice(0, 256) || undefined
  );
}
