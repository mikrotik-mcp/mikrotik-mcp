/**
 * The `/export` parser — the foundation every later policy phase is built on, so
 * the cases here are the format's traps rather than its happy path: `\`
 * continuations, quoted values containing spaces and `=`, bare flags, a menu
 * opened twice, and line-number fidelity (a finding that points at the wrong
 * line is worse than no finding).
 */
import { describe, expect, test } from "vite-plus/test";
import { normalizeSection, parseExport, recordsOf, settingsOf } from "../../src/policy/parse";

const EXPORT = `# 2026-07-29 10:30:05 by RouterOS 7.14.3
# software id = ABCD-1234
#
/interface bridge
add name=bridge1 protocol-mode=rstp
add name=bridge2 comment="guest network"
/ip address
add address=192.168.88.1/24 interface=bridge1 network=192.168.88.0
/ip firewall filter
add action=accept chain=input comment="allow established" connection-state=established,related
add action=drop chain=input comment="drop the rest"
/ip ssh
set strong-crypto=yes
`;

describe("section paths", () => {
  test("space and slash forms normalise to the same path", () => {
    expect(normalizeSection("/ip firewall filter")).toBe("/ip/firewall/filter");
    expect(normalizeSection("/ip/firewall/filter")).toBe("/ip/firewall/filter");
    expect(normalizeSection("ip firewall filter")).toBe("/ip/firewall/filter");
    expect(normalizeSection("/ip/firewall/filter/")).toBe("/ip/firewall/filter");
  });

  test("a section is found under either form", () => {
    const model = parseExport(EXPORT);
    expect(recordsOf(model, "/ip firewall filter")).toHaveLength(2);
    expect(recordsOf(model, "/ip/firewall/filter")).toHaveLength(2);
  });

  test("an absent section yields no records rather than throwing", () => {
    expect(recordsOf(parseExport(EXPORT), "/ppp/secret")).toEqual([]);
  });
});

describe("records", () => {
  test("parses key=value pairs into fields", () => {
    const [first] = recordsOf(parseExport(EXPORT), "/interface/bridge");
    expect(first).toMatchObject({
      op: "add",
      section: "/interface/bridge",
      fields: { name: "bridge1", "protocol-mode": "rstp" },
    });
  });

  test("counts every record across the export", () => {
    // 2 bridges + 1 address + 2 filter rules + 1 ssh set
    expect(parseExport(EXPORT).recordCount).toBe(6);
  });

  test("keeps the verb, so `set` and `add` can be told apart", () => {
    const model = parseExport(EXPORT);
    expect(recordsOf(model, "/ip/ssh").map((r) => r.op)).toEqual(["set"]);
    expect(recordsOf(model, "/interface/bridge").every((r) => r.op === "add")).toBe(true);
  });

  test("the comment header is skipped, not treated as config", () => {
    const model = parseExport(EXPORT);
    expect(model.unparsed).toEqual([]);
    expect(model.sections.map((s) => s.path)).toEqual([
      "/interface/bridge",
      "/ip/address",
      "/ip/firewall/filter",
      "/ip/ssh",
    ]);
  });
});

describe("quoted values", () => {
  test("a value with spaces stays one field", () => {
    const [, second] = recordsOf(parseExport(EXPORT), "/interface/bridge");
    expect(second.fields.comment).toBe("guest network");
  });

  test("a value containing `=` is not split", () => {
    const model = parseExport(`/ip firewall filter\nadd action=drop comment="a=b c=d" chain=input`);
    const [record] = recordsOf(model, "/ip/firewall/filter");
    expect(record.fields).toEqual({ action: "drop", comment: "a=b c=d", chain: "input" });
  });

  test("escaped quotes and backslashes survive", () => {
    const model = parseExport(`/system script\nadd name=s source="put \\"hi\\"; :put c:\\\\dir"`);
    const [record] = recordsOf(model, "/system/script");
    expect(record.fields.source).toBe(`put "hi"; :put c:\\dir`);
  });

  test("an empty quoted value is kept as an empty string", () => {
    const model = parseExport(`/ip firewall filter\nadd chain=input comment="" action=drop`);
    expect(recordsOf(model, "/ip/firewall/filter")[0].fields.comment).toBe("");
  });
});

describe("bare flags", () => {
  test("a flag with no `=` is visible as yes", () => {
    const model = parseExport(`/ip route\nadd dst-address=0.0.0.0/0 blackhole distance=250`);
    const [record] = recordsOf(model, "/ip/route");
    expect(record.fields.blackhole).toBe("yes");
    expect(record.flags).toEqual(["blackhole"]);
    expect(record.fields["dst-address"]).toBe("0.0.0.0/0");
  });

  test("the negated `!flag` form reads as no", () => {
    const model = parseExport(`/ip route\nset 0 !blackhole`);
    expect(recordsOf(model, "/ip/route")[0].fields.blackhole).toBe("no");
  });
});

describe("line continuations", () => {
  test("a wrapped line becomes ONE record", () => {
    const model = parseExport(
      `/ip firewall filter
add action=accept chain=input comment="a long comment" \\
    connection-state=established,related in-interface-list=LAN`,
    );
    const records = recordsOf(model, "/ip/firewall/filter");
    expect(records).toHaveLength(1);
    expect(records[0].fields["in-interface-list"]).toBe("LAN");
    expect(records[0].fields["connection-state"]).toBe("established,related");
  });

  test("a record's line number is where it STARTS", () => {
    const model = parseExport(
      `/ip firewall filter
add action=drop chain=input \\
    comment="wrapped"
add action=accept chain=forward`,
    );
    const records = recordsOf(model, "/ip/firewall/filter");
    expect(records[0].line).toBe(2);
    // The second record starts after the two-line first one.
    expect(records[1].line).toBe(4);
  });

  test("three-line continuations join correctly", () => {
    const model = parseExport(
      `/ip firewall nat
add action=dst-nat chain=dstnat \\
    dst-port=443 \\
    protocol=tcp to-addresses=10.0.0.5`,
    );
    const [record] = recordsOf(model, "/ip/firewall/nat");
    expect(record.fields).toMatchObject({
      action: "dst-nat",
      "dst-port": "443",
      protocol: "tcp",
      "to-addresses": "10.0.0.5",
    });
  });

  test("an export ending mid-continuation still yields the record", () => {
    const model = parseExport(`/ip dns\nset servers=1.1.1.1 \\`);
    expect(recordsOf(model, "/ip/dns")[0].fields.servers).toBe("1.1.1.1");
  });
});

describe("line numbers", () => {
  test("every record points at its own source line", () => {
    const model = parseExport(EXPORT);
    expect(recordsOf(model, "/interface/bridge").map((r) => r.line)).toEqual([5, 6]);
    expect(recordsOf(model, "/ip/firewall/filter").map((r) => r.line)).toEqual([10, 11]);
    expect(recordsOf(model, "/ip/ssh").map((r) => r.line)).toEqual([13]);
  });

  test("CRLF input does not shift line numbers", () => {
    const model = parseExport(EXPORT.replace(/\n/g, "\r\n"));
    expect(recordsOf(model, "/ip/ssh")[0].line).toBe(13);
    expect(recordsOf(model, "/ip/ssh")[0].fields["strong-crypto"]).toBe("yes");
  });

  test("blank lines are skipped without disturbing numbering", () => {
    const model = parseExport(`/ip dns\n\n\nset servers=9.9.9.9\n`);
    expect(recordsOf(model, "/ip/dns")[0].line).toBe(4);
  });
});

describe("sections", () => {
  test("an empty section is still present, with no records", () => {
    const model = parseExport(
      `/ip firewall filter\n/ip firewall nat\nadd chain=srcnat action=masquerade`,
    );
    expect(model.byPath.has("/ip/firewall/filter")).toBe(true);
    expect(recordsOf(model, "/ip/firewall/filter")).toEqual([]);
    expect(recordsOf(model, "/ip/firewall/nat")).toHaveLength(1);
  });

  test("a menu opened twice contributes to ONE section", () => {
    const model = parseExport(
      `/ip firewall filter
add chain=input action=accept
/ip firewall nat
add chain=srcnat action=masquerade
/ip firewall filter
add chain=forward action=drop`,
    );
    const section = model.byPath.get("/ip/firewall/filter");
    expect(section?.records).toHaveLength(2);
    expect(section?.lines).toEqual([1, 5]);
    expect(model.sections).toHaveLength(2);
  });

  test("an inline command on the menu line is a record of that section", () => {
    const model = parseExport(`/ip dns set servers=1.1.1.1,8.8.8.8 allow-remote-requests=no`);
    const [record] = recordsOf(model, "/ip/dns");
    expect(record).toMatchObject({
      op: "set",
      fields: { servers: "1.1.1.1,8.8.8.8", "allow-remote-requests": "no" },
      line: 1,
    });
  });

  test("records following an inline command belong to the same section", () => {
    const model = parseExport(
      `/ip firewall address-list add list=LAN address=10.0.0.0/8\nadd list=LAN address=192.168.0.0/16`,
    );
    expect(recordsOf(model, "/ip/firewall/address-list")).toHaveLength(2);
  });
});

describe("settingsOf", () => {
  test("merges several `set` lines into one record, later wins", () => {
    const model = parseExport(
      `/ip settings
set rp-filter=loose
set tcp-syncookies=yes
set rp-filter=strict`,
    );
    const settings = settingsOf(model, "/ip/settings");
    expect(settings?.fields).toEqual({ "rp-filter": "strict", "tcp-syncookies": "yes" });
  });

  test("is undefined for a section with no `set` lines", () => {
    expect(settingsOf(parseExport(EXPORT), "/interface/bridge")).toBeUndefined();
    expect(settingsOf(parseExport(EXPORT), "/nope")).toBeUndefined();
  });
});

describe("robustness", () => {
  test("an unrecognised line is recorded, not silently dropped", () => {
    const model = parseExport(`/ip dns\nset servers=1.1.1.1\nthis is not routeros`);
    expect(model.unparsed).toEqual([{ line: 3, text: "this is not routeros" }]);
    expect(model.recordCount).toBe(1);
  });

  test("a record before any menu path is reported as unparsed", () => {
    const model = parseExport(`add chain=input action=drop`);
    expect(model.unparsed).toHaveLength(1);
    expect(model.recordCount).toBe(0);
  });

  test("an empty export parses to an empty model", () => {
    const model = parseExport("");
    expect(model.sections).toEqual([]);
    expect(model.recordCount).toBe(0);
    expect(model.unparsed).toEqual([]);
  });

  test("a header-only export has no sections", () => {
    expect(parseExport("# 2026-07-29 10:30:05 by RouterOS 7.14.3\n#\n").sections).toEqual([]);
  });

  test("every RouterOS verb is recognised as a record", () => {
    const model = parseExport(
      `/ip firewall filter
add chain=input action=drop
set 0 disabled=yes
remove 1
move 0 destination=2
enable 0
disable 0
unset 0 comment`,
    );
    expect(recordsOf(model, "/ip/firewall/filter").map((r) => r.op)).toEqual([
      "add",
      "set",
      "remove",
      "move",
      "enable",
      "disable",
      "unset",
    ]);
    expect(model.unparsed).toEqual([]);
  });
});
