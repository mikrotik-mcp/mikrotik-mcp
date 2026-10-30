import { expect, test } from "vite-plus/test";
import { dnsAnswers, proxyVisit, validSiteHost } from "../../src/observability/site-activity";
import { parseProxyLogRows } from "../../src/observability/site-activity-collector";

function response() {
  const q = [7, ...Buffer.from("example"), 3, ...Buffer.from("com"), 0];
  const dns = [
    0,
    1,
    0x81,
    0x80,
    0,
    1,
    0,
    1,
    0,
    0,
    0,
    0,
    ...q,
    0,
    1,
    0,
    1,
    0xc0,
    0x0c,
    0,
    1,
    0,
    1,
    0,
    0,
    0,
    60,
    0,
    4,
    93,
    184,
    215,
    14,
  ];
  const udp = [0, 53, 0x85, 0, 0, 8 + dns.length, 0, 0, ...dns];
  const ip = [0x45, 0, 0, 20 + udp.length, 0, 0, 0, 0, 64, 17, 0, 0, 10, 0, 0, 1, 10, 0, 0, 7];
  return Uint8Array.from([...Array.from({ length: 12 }, () => 0), 0x08, 0x00, ...ip, ...udp]);
}

test("DNS response attributes an A answer to its client only within TTL", () => {
  expect(dnsAnswers(response(), 1000)).toEqual([
    {
      client: "10.0.0.7",
      destination: "93.184.215.14",
      domain: "example.com",
      seen: 1000,
      expires: 61000,
    },
  ]);
  const query = response();
  query[14 + 20 + 8 + 2] = 1;
  expect(dnsAnswers(query, 1000)).toEqual([]);
  const truncated = response().subarray(0, 40);
  expect(dnsAnswers(truncated, 1000)).toEqual([]);
});

test("proxy parser keeps host only and rejects unsafe/malformed hosts", () => {
  expect(proxyVisit("from 10.10.6.3 CONNECT example.org:443 /secret?token=abc")).toEqual({
    client: "10.10.6.3",
    host: "example.org",
  });
  expect(proxyVisit("from 10.10.6.3 GET http://example.org/private?token=abc")).toEqual({
    client: "10.10.6.3",
    host: "example.org",
  });
  expect(proxyVisit("CONNECT example.org:443")).toBeNull();
  expect(validSiteHost("bad..host")).toBeNull();
  expect(
    parseProxyLogRows(
      '[{".id":"*A","message":"from 10.10.6.3 CONNECT example.org:443 /secret"}]',
      "home",
    )[0].id,
  ).not.toContain("secret");
});
