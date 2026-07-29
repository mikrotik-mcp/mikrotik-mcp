import { describe, expect, test } from "vite-plus/test";
import { isYes, isYesDefaultTrue } from "../../src/utils/yes";

describe("isYes", () => {
  test("accepts both spellings RouterOS uses", () => {
    // Console prints say yes/no; `print as-value`, REST and :put say true/false.
    expect(isYes("yes")).toBe(true);
    expect(isYes("true")).toBe(true);
    expect(isYes("no")).toBe(false);
    expect(isYes("false")).toBe(false);
  });

  test("trims and lowercases", () => {
    expect(isYes("  YES  ")).toBe(true);
    expect(isYes("\tTrue\n")).toBe(true);
  });

  test("absent or empty reads as false", () => {
    expect(isYes(undefined)).toBe(false);
    expect(isYes(null)).toBe(false);
    expect(isYes("")).toBe(false);
    expect(isYes("   ")).toBe(false);
  });

  test("an unrelated value is not true", () => {
    expect(isYes("enabled")).toBe(false);
    expect(isYes("1")).toBe(false);
  });
});

describe("isYesDefaultTrue", () => {
  test("absent means enabled, for menus that omit a permissive default", () => {
    expect(isYesDefaultTrue(undefined)).toBe(true);
    expect(isYesDefaultTrue(null)).toBe(true);
    expect(isYesDefaultTrue("")).toBe(true);
    expect(isYesDefaultTrue("  ")).toBe(true);
  });

  test("an explicit no still denies", () => {
    expect(isYesDefaultTrue("no")).toBe(false);
    expect(isYesDefaultTrue("false")).toBe(false);
    expect(isYesDefaultTrue(" NO ")).toBe(false);
  });

  test("an explicit yes allows", () => {
    expect(isYesDefaultTrue("yes")).toBe(true);
    expect(isYesDefaultTrue("true")).toBe(true);
  });

  test("an unrecognised value is not treated as permission", () => {
    // Differs from the absent case on purpose: a value we cannot read is a
    // parse problem, not a documented default.
    expect(isYesDefaultTrue("maybe")).toBe(false);
  });
});
