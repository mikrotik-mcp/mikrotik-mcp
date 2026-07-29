/**
 * Transport parity: the same device state must render identically whether it
 * arrived as REST JSON or as SSH console text.
 *
 * This is the guarantee that makes `executeMikrotikJson` safe to build tools on.
 * Without it, a tool would quietly produce different output depending on a
 * per-device config flag — the worst kind of bug, because it only appears on
 * some deployments and looks like a device difference rather than a code one.
 *
 * NOTE: these fixtures are hand-written from the documented RouterOS API shape.
 * They pin the CODE's behaviour, not the device's. A live smoke test against a
 * real RouterOS 7.9+ box is still outstanding — see the task tracker.
 */
import { describe, expect, test } from "vite-plus/test";
import { toRecords } from "../../src/core/connector";
import { parseRecords } from "../../src/core/routeros-parse";
import { toConsoleText } from "../../src/rest/bridge";

/**
 * One scenario expressed twice: as the JSON a REST reply would carry, and as
 * the console text the same `print detail` would produce over SSH.
 */
const CASES = [
  {
    name: "ip addresses",
    json: [
      { ".id": "*1", address: "192.168.1.1/24", network: "192.168.1.0", interface: "bridge" },
      { ".id": "*2", address: "10.0.0.1/8", network: "10.0.0.0", interface: "ether1" },
    ],
    text: [
      " 0 .id=*1 address=192.168.1.1/24 network=192.168.1.0 interface=bridge",
      " 1 .id=*2 address=10.0.0.1/8 network=10.0.0.0 interface=ether1",
    ].join("\n"),
  },
  {
    name: "interfaces with a quoted comment",
    json: [{ ".id": "*1", name: "ether1", type: "ether", comment: "uplink to ISP" }],
    text: ' 0 .id=*1 name=ether1 type=ether comment="uplink to ISP"',
  },
  {
    name: "routes",
    json: [{ ".id": "*0", "dst-address": "0.0.0.0/0", gateway: "192.168.1.254", distance: "1" }],
    text: " 0 .id=*0 dst-address=0.0.0.0/0 gateway=192.168.1.254 distance=1",
  },
  {
    name: "empty result",
    json: [],
    text: "",
  },
] as const;

describe("REST JSON and SSH text produce the same records", () => {
  test.each(CASES.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const fromRest = toRecords(c.json);
    const fromSsh = parseRecords(c.text);
    expect(fromRest.rows).toEqual(fromSsh.rows);
  });

  test("numeric and boolean JSON values become strings, matching the text path", () => {
    // RouterOS REST types some fields; the console gives everything as text. A
    // tool switching on `typeof` would otherwise behave differently per
    // transport — coercing here removes the whole class of bug.
    const rest = toRecords([{ name: "ether1", mtu: 1500, running: true, disabled: false }]);
    expect(rest.rows[0]).toEqual({
      "#": "0",
      name: "ether1",
      mtu: "1500",
      running: "true",
      disabled: "false",
    });
    for (const v of Object.values(rest.rows[0])) expect(typeof v).toBe("string");
  });

  test("null and undefined properties are dropped, not stringified", () => {
    // `String(null)` would put the literal text "null" in a rendered table.
    const rest = toRecords([{ name: "ether1", comment: null, mtu: undefined }]);
    expect(rest.rows[0]).toEqual({ "#": "0", name: "ether1" });
  });

  test("a single settings object is treated as one record", () => {
    // `/ip/dns` and friends reply with an object, not an array.
    const rest = toRecords({ servers: "1.1.1.1", "allow-remote-requests": true });
    expect(rest.rows).toEqual([{ "#": "0", servers: "1.1.1.1", "allow-remote-requests": "true" }]);
  });

  test("an empty reply reports the empty format, so callers can branch on it", () => {
    expect(toRecords([]).format).toBe("empty");
    expect(toRecords([]).rows).toEqual([]);
  });

  test("column order follows first appearance across rows", () => {
    const rest = toRecords([
      { a: "1", b: "2" },
      { b: "9", c: "3" },
    ]);
    // `#` leads because parseRecords surfaces the console's row index first.
    expect(rest.columns).toEqual(["#", "a", "b", "c"]);
  });
});

describe("the bridge's text rendering round-trips through parseRecords", () => {
  // Phase 2 renders REST JSON back to console text for the 819 unmigrated
  // handlers. That text must parse back to the same records, or a migrated and
  // an unmigrated tool would disagree about the same device.
  test.each(CASES.filter((c) => c.json.length > 0).map((c) => [c.name, c] as const))(
    "%s",
    (_name, c) => {
      const rendered = toConsoleText(c.json);
      expect(parseRecords(rendered).rows).toEqual(toRecords(c.json).rows);
    },
  );
});
