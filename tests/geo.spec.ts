/**
 * Guards the public/private IP classification the geo lookup uses — private,
 * loopback, link-local and CGNAT addresses (and hostnames) must never be sent to
 * the third-party geo API, and real public IPs must pass.
 */
import { describe, expect, test } from "vite-plus/test";
import { isPublicIpLiteral } from "../src/observability/geo";

describe("isPublicIpLiteral", () => {
  test("accepts real public IPv4 literals", () => {
    for (const ip of ["1.1.1.1", "8.8.8.8", "136.243.249.195", "203.0.113.10"]) {
      expect(isPublicIpLiteral(ip)).toBe(true);
    }
  });

  test("rejects private / loopback / link-local / CGNAT ranges", () => {
    for (const ip of [
      "10.0.0.1",
      "192.168.1.1",
      "172.16.0.1",
      "172.31.255.255",
      "127.0.0.1",
      "169.254.1.1",
      "100.64.0.1", // CGNAT
      "0.0.0.0",
      "::1",
      "::",
      "0:0:0:0:0:0:0:1",
      "fc00::1",
      "fd12::1",
      "fe80::1",
      "febf::1",
      "ff02::1",
      "::ffff:192.168.1.1",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isPublicIpLiteral(ip)).toBe(false);
    }
  });

  test("rejects non-IP hosts (a hostname is not a literal)", () => {
    expect(isPublicIpLiteral("router.example.com")).toBe(false);
    expect(isPublicIpLiteral("localhost")).toBe(false);
    expect(isPublicIpLiteral("")).toBe(false);
    expect(isPublicIpLiteral("999.1.1.1")).toBe(false);
    expect(isPublicIpLiteral("not:an:ip")).toBe(false);
  });

  test("accepts a public range just outside the private 172.16/12 block", () => {
    expect(isPublicIpLiteral("172.15.0.1")).toBe(true);
    expect(isPublicIpLiteral("172.32.0.1")).toBe(true);
  });

  test("accepts public IPv6 literals", () => {
    expect(isPublicIpLiteral("2606:4700:4700::1111")).toBe(true);
    expect(isPublicIpLiteral("::ffff:8.8.8.8")).toBe(true);
  });
});
