/**
 * Inputs that made a regular expression take quadratic time (code scanning:
 * js/polynomial-redos). Each must now be handled in well under a second.
 */
import { expect, test } from "vite-plus/test";
import { bypassesSafeMode } from "../src/core/connector";
import { parseVersion } from "../src/core/firmware-lifecycle";
import { extractCommandOutput } from "../src/mac-telnet/console";

const quick = (work: () => unknown): number => {
  const start = performance.now();
  work();
  return performance.now() - start;
};

test("a long command with many `print` words is classified at once", () => {
  const hostile = `/print ${" print ".repeat(40_000)};`;
  expect(quick(() => bypassesSafeMode(hostile, {}))).toBeLessThan(500);
  expect(bypassesSafeMode(hostile, {})).toBe(false);
  // The meaning is unchanged.
  expect(bypassesSafeMode("/ip address print detail", {})).toBe(true);
  expect(bypassesSafeMode("/export", {})).toBe(true);
  expect(bypassesSafeMode("/ip address add address=10.0.0.1/24", {})).toBe(false);
  expect(bypassesSafeMode("/ip address print; /system reboot", {})).toBe(false);
  expect(bypassesSafeMode("/system script run printer", {})).toBe(false);
});

test("a hostile version string from a device is parsed or refused at once", () => {
  expect(quick(() => parseVersion(`7.1${" ".repeat(60_000)}x`))).toBeLessThan(500);
  expect(quick(() => parseVersion(`0.0${"00".repeat(60_000)}`))).toBeLessThan(500);
  expect(parseVersion("7.16.2 (stable)")).toMatchObject({ major: 7, minor: 16 });
  expect(parseVersion("7.17rc1")).toMatchObject({ major: 7, minor: 17 });
});

test("console output with very many line ends is handled at once", () => {
  const raw = `[admin@r] > /x print\r\n${"\n".repeat(60_000)}value`;
  expect(quick(() => extractCommandOutput(raw, `/x print${"\n".repeat(60_000)}`))).toBeLessThan(
    500,
  );
});
