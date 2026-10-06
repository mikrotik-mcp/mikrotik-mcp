import { expect, test } from "vite-plus/test";
import { getAsnOrganizationLabel } from "../src/core/asn-organization";
import iranAsns from "../src/data/iran-asns.json";

test("keeps all 588 source ASN/name pairs with provenance and decoded names", () => {
  expect(iranAsns.source).toBe("https://whois.ipip.net/iso/IR");
  expect(iranAsns.sourceBuild).toBe("2026-09-06");
  expect(iranAsns.retrievedAt).toBe("2026-10-06");
  expect(iranAsns.countryCode).toBe("IR");
  expect(iranAsns.entries).toHaveLength(588);
  expect(new Set(iranAsns.entries.map(({ asn }) => asn)).size).toBe(588);
  for (const { asn, name } of iranAsns.entries) {
    expect(asn).toMatch(/^AS[1-9]\d*$/);
    expect(Number(asn.slice(2))).toBeLessThanOrEqual(0xffffffff);
    expect(name).toMatch(/\S/);
    expect(name).not.toMatch(/&(?:amp|#39|#34);/);
    expect(getAsnOrganizationLabel(asn, undefined)).toBe(name.split(" - ", 1)[0].trim());
  }
  expect(iranAsns.entries.find(({ asn }) => asn === "AS58224")).toEqual({
    asn: "AS58224",
    name: "TCI - Iran Telecommunication Company PJS, IR",
  });
  expect(iranAsns.entries.at(-1)?.asn).toBe("AS219466");
});

test("prefers the local label, preserves name hyphens and safely falls back for unknown ASNs", () => {
  expect(getAsnOrganizationLabel("AS58224", "Iran Telecommunication Company PJS")).toBe("TCI");
  expect(getAsnOrganizationLabel("AS58224", null)).toBe("TCI");
  expect(getAsnOrganizationLabel("AS44244", undefined)).toBe("IranCell-AS");
  expect(getAsnOrganizationLabel("AS34369", undefined)).toBe("AS-SHATELMOBILE");
  expect(getAsnOrganizationLabel("AS13335", " Example\nNetwork ")).toBe("Example Network");
  expect(getAsnOrganizationLabel(undefined, "x".repeat(500))).toHaveLength(256);
  for (const organization of [undefined, null, {}, [], 123, " \n\t "])
    expect(getAsnOrganizationLabel("AS13335", organization)).toBeUndefined();
  expect(getAsnOrganizationLabel("toString", undefined)).toBeUndefined();
});
