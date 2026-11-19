import { expect, test } from "vite-plus/test";
import { factSubject, questionTerms } from "../src/memory/insight";

test("a fact's subject and value are read from three plain forms", () => {
  expect(factSubject("WAN IP: 203.0.113.7")).toEqual({
    subject: "wan ip",
    value: "203.0.113.7",
    sure: true,
  });
  expect(factSubject("The WAN IP is 198.51.100.4.")).toEqual({
    subject: "wan ip",
    value: "198.51.100.4",
    sure: true,
  });
  expect(factSubject("bridge mtu = 1500")?.subject).toBe("bridge mtu");
  // One word is a subject, but not a sure one.
  expect(factSubject("DNS: 1.1.1.1")).toEqual({ subject: "dns", value: "1.1.1.1", sure: false });
});

test("prose, addresses with a port and generic labels are not a subject", () => {
  expect(factSubject("Forward 10.0.0.1:8080 to the NAS")).toBeNull();
  expect(factSubject("See https://example.test/a for the plan")).toBeNull();
  expect(factSubject("Note: the switch reboots at night")).toBeNull();
  expect(factSubject("Rebooted the router after the upgrade")).toBeNull();
  expect(factSubject("")).toBeNull();
});

test("a question keeps the words that carry its meaning", () => {
  expect(questionTerms("What is the WAN provider of edge?")).toEqual(["wan", "provider", "edge"]);
  // An address, a prefix and an interface name each stay one word.
  expect(questionTerms("Is 10.0.0.1/24 on ether2-wan?")).toEqual(["10.0.0.1/24", "ether2-wan"]);
  expect(questionTerms("what is it?")).toEqual([]);
  expect(questionTerms("wan WAN Wan")).toEqual(["wan"]);
  expect(questionTerms(Array.from({ length: 60 }, (_, i) => `w${i}x`).join(" "))).toHaveLength(24);
});
