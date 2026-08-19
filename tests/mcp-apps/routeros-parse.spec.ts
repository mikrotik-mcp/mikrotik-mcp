/**
 * RouterOS `print` parsers used to shape MCP App view data (Vitest).
 */
import { describe, it, expect } from "vite-plus/test";
import {
  parseKeyValues,
  parseLeadingNumber,
  parseSize,
  parseCertExpiry,
  parseRouterosDate,
  parseSizeToBytes,
  parseSystemResource,
  parsePercent,
  parseFlagLegend,
  parseRecords,
  parseDisks,
  buildRecordsView,
  filterDetailBlocks,
} from "../../src/core/routeros-parse";

describe("parseKeyValues", () => {
  it("parses padded `key: value` print output, preserving hyphenated keys", () => {
    const text = [
      "                   uptime: 1w2d3h4m",
      "                  version: 7.16.1 (stable)",
      "                 cpu-load: 7%",
      "              free-memory: 124.5MiB",
      "             total-memory: 256.0MiB",
      "               board-name: RB5009UG+S+",
    ].join("\n");
    const kv = parseKeyValues(text);
    expect(kv.uptime).toBe("1w2d3h4m");
    expect(kv.version).toBe("7.16.1 (stable)");
    expect(kv["cpu-load"]).toBe("7%");
    expect(kv["free-memory"]).toBe("124.5MiB");
    expect(kv["board-name"]).toBe("RB5009UG+S+");
  });

  it("skips blank lines and non key:value lines", () => {
    const kv = parseKeyValues("\nFlags: X - disabled\n  name: home\n");
    expect(kv.name).toBe("home");
    // "Flags: X - disabled" looks key-ish but is kept as a value — acceptable;
    // what matters is real fields parse and blanks don't crash.
    expect(Object.keys(kv)).toContain("name");
  });

  it("returns an empty object for empty input", () => {
    expect(parseKeyValues("")).toEqual({});
  });

  it("tolerates CRLF line endings (RouterOS SSH exec channel)", () => {
    const text = "  uptime: 1w2d3h\r\n  version: 7.16.1 (stable)\r\n  cpu-load: 5%\r\n";
    const kv = parseKeyValues(text);
    expect(kv.uptime).toBe("1w2d3h");
    expect(kv.version).toBe("7.16.1 (stable)");
    expect(kv["cpu-load"]).toBe("5%");
  });
});

describe("parseLeadingNumber", () => {
  it("extracts the leading number, ignoring units/suffixes", () => {
    expect(parseLeadingNumber("7%")).toBe(7);
    expect(parseLeadingNumber("41.5C")).toBe(41.5);
    expect(parseLeadingNumber("24.1V")).toBe(24.1);
  });
  it("returns null for non-numeric or missing values", () => {
    expect(parseLeadingNumber("n/a")).toBeNull();
    expect(parseLeadingNumber(undefined)).toBeNull();
  });
});

describe("parseSizeToBytes", () => {
  it("converts RouterOS binary sizes to bytes", () => {
    expect(parseSizeToBytes("1024B")).toBe(1024);
    expect(parseSizeToBytes("2KiB")).toBe(2048);
    expect(parseSizeToBytes("1MiB")).toBe(1024 * 1024);
    expect(parseSizeToBytes("1.5GiB")).toBe(1.5 * 1024 ** 3);
  });
  it("treats a bare number as bytes and rejects junk", () => {
    expect(parseSizeToBytes("500")).toBe(500);
    expect(parseSizeToBytes("abc")).toBeNull();
    expect(parseSizeToBytes(undefined)).toBeNull();
  });
});

describe("parseFlagLegend", () => {
  it("maps each flag letter to its meaning", () => {
    const legend = parseFlagLegend("Flags: X - disabled, R - running, D - dynamic ");
    expect(legend).toEqual({ X: "disabled", R: "running", D: "dynamic" });
  });
  it("returns an empty map when there is no legend", () => {
    expect(parseFlagLegend("0 name=ether1")).toEqual({});
  });

  it("splits the v7 legend that mixes `;` and `,` separators", () => {
    const legend = parseFlagLegend("Flags: D - DYNAMIC; X - DISABLED, R - RUNNING; S - SLAVE");
    expect(legend).toEqual({ D: "DYNAMIC", X: "DISABLED", R: "RUNNING", S: "SLAVE" });
  });
});

describe("parseRecords — detail (key=value) format", () => {
  it("parses indexed records with flags and quoted values, wrapping continuations", () => {
    const text = [
      "Flags: X - disabled, R - running ",
      ' 0 R  name="ether1" type="ether" mtu=1500 comment="up link"',
      "      mac-address=AA:BB:CC:DD:EE:FF",
      ' 1  X name="ether2" type="ether" mtu=1500',
    ].join("\n");
    const { format, columns, rows } = parseRecords(text);
    expect(format).toBe("detail");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      "#": "0",
      flags: "R",
      name: "ether1",
      type: "ether",
      comment: "up link",
      "mac-address": "AA:BB:CC:DD:EE:FF",
    });
    expect(rows[1]).toMatchObject({ "#": "1", flags: "X", name: "ether2" });
    expect(columns).toContain("name");
    expect(columns).toContain("mac-address");
  });

  it("captures uppercase flags and a `;;;` comment on v7 detail rows", () => {
    const text = [
      "Flags: D - DYNAMIC; X - DISABLED, R - RUNNING; S - SLAVE",
      " 0  RS ;;; defconf",
      '        name="ether1" default-name="ether1" type="ether" mtu=1500',
      ' 1  R  name="ether2" type="ether" mtu=1500',
    ].join("\n");
    const { format, rows } = parseRecords(text);
    expect(format).toBe("detail");
    expect(rows[0]).toMatchObject({
      "#": "0",
      flags: "RS",
      comment: "defconf",
      name: "ether1",
      type: "ether",
    });
    expect(rows[1]).toMatchObject({ "#": "1", flags: "R", name: "ether2" });
  });

  it("parses a single detail record with no index line", () => {
    const { format, rows } = parseRecords('name="home" ttl="1d" address=1.2.3.4');
    expect(format).toBe("detail");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "home", ttl: "1d", address: "1.2.3.4" });
  });

  it("re-expands RouterOS abbreviated dotted-prefix continuations (`.band` → `channel.band`)", () => {
    // Real `/interface wifi print detail` output (RouterOS 7.23, wifi-qcom).
    const text = [
      "Flags: M - MASTER; D - DYNAMIC, N - NETWORK; B - BOUND;",
      ' 0 M B  default-name="wifi2" name="wifi 5GHz" mac-address=04:F4:1C:EF:B7:B4',
      "        radio-mac=04:F4:1C:EF:B7:B4",
      '        configuration.country=Taiwan .chains=0,1 .ssid="useStrict" .mode=ap',
      "        security.authentication-types=wpa2-psk,wpa3-psk .ft=no .ft-over-ds=no",
      "        channel.frequency=5745 .band=5ghz-ax .width=20/40/80mhz",
    ].join("\n");
    const { rows } = parseRecords(text);
    expect(rows[0]).toMatchObject({
      name: "wifi 5GHz",
      "radio-mac": "04:F4:1C:EF:B7:B4",
      "configuration.country": "Taiwan",
      "configuration.ssid": "useStrict", // abbreviated `.ssid`
      "configuration.mode": "ap",
      "security.ft": "no", // abbreviated `.ft`
      "security.ft-over-ds": "no",
      "channel.frequency": "5745",
      "channel.band": "5ghz-ax", // abbreviated `.band`
      "channel.width": "20/40/80mhz",
    });
  });
});

describe("parseDisks", () => {
  it("parses an attached USB disk with space-grouped byte counts", () => {
    // Real `/disk print detail` output (hAP ax3, KIOXIA USB stick).
    const text = [
      "Flags: X - DISABLED; A - ACQUIRED, E - EMPTY, B - BLOCK-DEVICE;",
      "M - MOUNTED, F - FORMATTING, S - SWAP-ENABLED;",
      ' 0  BM         type=hardware slot="usb1" fs-label="mikrotik-ax3" fs=ext4',
      '               model="KIOXIA TransMemory" serial="B06EBF0AB44EE581A1433FA8"',
      "               size=124 948 316 160 free=122 382 983 168 use=0%",
      '               mount-point="usb1" mount-filesystem=yes',
    ].join("\n");
    const disks = parseDisks(text);
    expect(disks).toHaveLength(1);
    expect(disks[0]).toMatchObject({
      slot: "usb1",
      fs: "ext4",
      model: "KIOXIA TransMemory",
      size: 124948316160, // space grouping collapsed, full number kept
      free: 122382983168,
      mountPoint: "usb1",
      usedPct: 0,
    });
  });

  it("skips empty slots and rows with no size", () => {
    const text = [
      "Flags: E - EMPTY, B - BLOCK-DEVICE, M - MOUNTED",
      ' 0  E          slot="usb1" type="hardware"',
    ].join("\n");
    expect(parseDisks(text)).toEqual([]);
  });

  it("computes used percent from size/free when `use` is absent", () => {
    const text = ' 0  BM slot="nvme1" fs=ext4 size=1 000 000 000 free=250 000 000';
    expect(parseDisks(text)[0]).toMatchObject({ slot: "nvme1", usedPct: 75 });
  });
});

describe("parseRecords — columnar format", () => {
  it("slices rows at the header column positions, keeping spaced values intact", () => {
    const text = [
      "Flags: X - disabled, R - running ",
      " #   NAME      TYPE   ACTUAL-MTU",
      " 0 R ether1    ether  1500",
      " 1 X ether2    ether  1500",
    ].join("\n");
    const { format, columns, rows } = parseRecords(text);
    expect(format).toBe("columnar");
    expect(columns).toEqual(expect.arrayContaining(["#", "name", "type", "actual-mtu"]));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ "#": "0", flags: "R", name: "ether1", "actual-mtu": "1500" });
    expect(rows[1]).toMatchObject({ "#": "1", flags: "X", name: "ether2" });
  });

  it("ignores the v7 `Columns:` hint line instead of slicing on it", () => {
    const text = [
      "Flags: D - dynamic; X - disabled, R - running; S - slave",
      "Columns: NAME, TYPE, ACTUAL-MTU, L2MTU, MAC-ADDRESS",
      " #    NAME        TYPE    ACTUAL-MTU  L2MTU  MAC-ADDRESS",
      " 0  R ether1      ether   1500        1598   AA:BB:CC:DD:EE:01",
      " 1  R ether2      ether   1500        1598   AA:BB:CC:DD:EE:02",
    ].join("\n");
    const { format, columns, rows } = parseRecords(text);
    expect(format).toBe("columnar");
    expect(columns).toEqual(expect.arrayContaining(["#", "name", "type", "actual-mtu"]));
    expect(rows[0]).toMatchObject({ "#": "0", flags: "R", name: "ether1", type: "ether" });
    expect(rows).toHaveLength(2);
  });
});

describe("parseRecords — fallbacks", () => {
  it("treats single key:value output as one record", () => {
    const { format, rows } = parseRecords("  uptime: 1w2d\n  version: 7.16.1");
    expect(format).toBe("keyvalue");
    expect(rows[0]).toMatchObject({ uptime: "1w2d", version: "7.16.1" });
  });
  it("returns an empty result for prose (no records)", () => {
    expect(parseRecords("Interface 'x' not found.")).toEqual({
      format: "empty",
      columns: [],
      rows: [],
    });
  });
});

describe("buildRecordsView", () => {
  const at = "2026-06-21T00:00:00.000Z";

  it("strips a banner, classifies a list, and carries the raw fallback", () => {
    const text = [
      "INTERFACES:",
      "",
      "Flags: R - running ",
      ' 0 R name="ether1" type="ether"',
      ' 1 R name="ether2" type="ether"',
    ].join("\n");
    const view = buildRecordsView("list_interfaces", "List Interfaces", text, at);
    expect(view.__mikrotikView).toBe("records");
    expect(view.kind).toBe("list");
    expect(view.count).toBe(2);
    expect(view.flags).toEqual({ R: "running" });
    expect(view.raw).not.toMatch(/^INTERFACES:/);
    expect(view.generatedAt).toBe(at);
  });

  it("classifies a single detail record as `record`", () => {
    const view = buildRecordsView(
      "get_interface",
      "Get Interface",
      'INTERFACE DETAILS:\n\nname="ether1" type="ether" mtu=1500',
      at,
    );
    expect(view.kind).toBe("record");
    expect(view.rows[0]).toMatchObject({ name: "ether1" });
  });

  it("never throws on prose, leaving rows empty with raw text preserved", () => {
    const view = buildRecordsView("get_interface", "Get Interface", "Interface 'x' not found.", at);
    expect(view.rows).toEqual([]);
    expect(view.raw).toBe("Interface 'x' not found.");
  });
});

describe("parseSize / parsePercent", () => {
  it("parses RouterOS sizes with binary/SI units and bare bytes", () => {
    expect(parseSize("256.0MiB")).toBe(256 * 1024 ** 2);
    expect(parseSize("1.0GiB")).toBe(1024 ** 3);
    expect(parseSize("1280KiB")).toBe(1280 * 1024);
    expect(parseSize("16252928")).toBe(16252928); // bare bytes
    expect(parseSize("188.5 MiB")).toBe(188.5 * 1024 ** 2); // space before unit
    expect(parseSize(undefined)).toBeUndefined();
  });
  it("parses percentages with or without a sign", () => {
    expect(parsePercent("0%")).toBe(0);
    expect(parsePercent("12")).toBe(12);
    expect(parsePercent("7 %")).toBe(7);
    expect(parsePercent(undefined)).toBeUndefined();
  });
});

describe("parseSystemResource", () => {
  it("extracts cpu/memory/disk from a real v7 `/system resource print`", () => {
    const text = [
      "                   uptime: 2d3h4m5s",
      "                  version: 7.15.3 (stable)",
      "              free-memory: 184.6MiB",
      "             total-memory: 256.0MiB",
      "                cpu-count: 4",
      "                 cpu-load: 12%",
      "           free-hdd-space: 1167.0MiB",
      "          total-hdd-space: 1280.0MiB",
      "        architecture-name: x86_64",
      "               board-name: CHR",
    ].join("\n");
    const r = parseSystemResource(text);
    expect(r).not.toBeNull();
    expect(r?.cpuLoad).toBe(12);
    expect(r?.cpuCount).toBe(4);
    expect(r?.totalMemory).toBe(256 * 1024 ** 2);
    expect(Math.round(r?.memUsedPct ?? -1)).toBe(28); // (256-184.6)/256
    expect(Math.round(r?.hddUsedPct ?? -1)).toBe(9); // (1280-1167)/1280
    expect(r?.version).toBe("7.15.3 (stable)");
    expect(r?.boardName).toBe("CHR");
  });
  it("handles an idle device reporting cpu-load 0% (a real 0, not missing)", () => {
    const r = parseSystemResource("cpu-load: 0%\nfree-memory: 100MiB\ntotal-memory: 256MiB");
    expect(r?.cpuLoad).toBe(0);
    expect(r?.memUsedPct).toBeGreaterThan(0);
  });
  it("returns null when the output carries no usable metric (empty/error)", () => {
    expect(parseSystemResource("")).toBeNull();
    expect(parseSystemResource("bad command name (line 1 column 9)")).toBeNull();
  });
  it("parses metrics from CRLF output (the dashboard health-probe regression)", () => {
    const text =
      "  uptime: 2d3h\r\n  version: 7.16.1 (stable)\r\n  free-memory: 184.6MiB\r\n" +
      "  total-memory: 256.0MiB\r\n  cpu-load: 12%\r\n";
    const r = parseSystemResource(text);
    expect(r).not.toBeNull();
    expect(r?.cpuLoad).toBe(12);
    expect(r?.totalMemory).toBe(256 * 1024 ** 2);
    expect(r?.version).toBe("7.16.1 (stable)");
  });
});

describe("parseRouterosDate / parseCertExpiry", () => {
  it("parses v7 ISO-ish and v6 month/day dates", () => {
    expect(parseRouterosDate("2026-06-01 12:00:00")).toBe(Date.UTC(2026, 5, 1, 12, 0, 0));
    expect(parseRouterosDate("2026-06-01")).toBe(Date.UTC(2026, 5, 1));
    expect(parseRouterosDate("jun/01/2026 12:00:00")).toBe(Date.UTC(2026, 5, 1, 12, 0, 0));
    expect(parseRouterosDate("not a date")).toBeNull();
    expect(parseRouterosDate(undefined)).toBeNull();
  });
  it("computes days-left per certificate, including expired ones", () => {
    const now = Date.UTC(2026, 0, 1);
    const detail = [
      ' 0 K   name="server" digest-algorithm=sha256',
      "       invalid-before=2025-01-01 00:00:00 invalid-after=2026-01-31 00:00:00",
      ' 1 K   name="old-ca" invalid-after=2025-12-01 00:00:00',
      ' 2     name="unsigned-template" common-name="x"',
    ].join("\n");
    const certs = parseCertExpiry(detail, now);
    const byName = Object.fromEntries(certs.map((c) => [c.name, c.daysLeft]));
    expect(byName.server).toBe(30); // Jan 31 − Jan 1
    expect(byName["old-ca"]).toBe(-31); // expired
    expect(byName["unsigned-template"]).toBeNull(); // no invalid-after
  });
});

describe("filterDetailBlocks", () => {
  // A realistic `/ip firewall filter print detail` reply: the interface fields
  // are absent on rules that don't match on them, which is exactly why the
  // device-side `where` could not express this search.
  const RULES = [
    "Flags: X - disabled, I - invalid, D - dynamic",
    " 0    chain=input action=accept connection-state=established,related log=no",
    " 1    chain=forward action=drop in-interface=ether1 protocol=tcp dst-port=23 log=no",
    " 2    chain=forward action=accept out-interface=ether1 protocol=udp log=no",
    " 3    chain=forward action=drop in-interface-list=WAN log=no",
  ].join("\n");

  it("keeps only matching records and preserves their original text", () => {
    const out = filterDetailBlocks(RULES, (r) => r.protocol === "tcp");
    expect(out).toContain("dst-port=23");
    expect(out).not.toContain("protocol=udp");
    // The flag legend is context for whatever survived, so it rides along.
    expect(out).toContain("Flags: X - disabled");
  });

  it("matches either interface direction, including the list forms", () => {
    const onEther1 = filterDetailBlocks(RULES, (r) =>
      [r["in-interface"], r["out-interface"]].some((v) => (v ?? "").includes("ether1")),
    );
    expect(onEther1).toContain("dst-port=23"); // in-interface
    expect(onEther1).toContain("protocol=udp"); // out-interface
    expect(onEther1).not.toContain("in-interface-list=WAN");

    const onWan = filterDetailBlocks(RULES, (r) => (r["in-interface-list"] ?? "").includes("WAN"));
    expect(onWan).toContain("in-interface-list=WAN");
  });

  it("returns empty (not the whole list) when nothing matches", () => {
    // The failure mode this guards: a filter that silently degrades to "no
    // filter" is far worse than one that honestly returns nothing.
    expect(filterDetailBlocks(RULES, (r) => r.protocol === "icmp")).toBe("");
  });

  it("passes through output that has no indexed records", () => {
    expect(filterDetailBlocks("no such item", () => false)).toBe("no such item");
  });
});
