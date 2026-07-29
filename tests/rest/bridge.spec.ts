import { describe, expect, test } from "vite-plus/test";
import { toConsoleText, toRequest, tokenize, unquote } from "../../src/rest/bridge";

describe("tokenize / unquote", () => {
  test("splits on whitespace outside quotes", () => {
    expect(tokenize("/ip address print")).toEqual(["/ip", "address", "print"]);
  });

  test("keeps a quoted value with spaces as one token", () => {
    expect(tokenize('/ip address add comment="my lan link"')).toEqual([
      "/ip",
      "address",
      "add",
      'comment="my lan link"',
    ]);
  });

  test("an unterminated quote is malformed, not a partial parse", () => {
    expect(tokenize('/ip address add comment="oops')).toEqual([]);
  });

  test("unquote inverts quoteValue escaping", () => {
    expect(unquote('"a\\"b"')).toBe('a"b');
    expect(unquote('"C:\\\\path"')).toBe("C:\\path");
    expect(unquote('"line\\nbreak"')).toBe("line\nbreak");
    expect(unquote("bare")).toBe("bare");
  });
});

describe("toRequest — print", () => {
  test("plain print → GET on the menu path", () => {
    expect(toRequest("/ip address print")).toEqual({
      method: "GET",
      path: "ip/address",
      query: {},
      countOnly: false,
    });
  });

  test("slash-separated menu spelling maps identically", () => {
    expect(toRequest("/ip/address/print")?.path).toBe("ip/address");
  });

  test("deep menu path", () => {
    expect(toRequest("/interface wifi registration-table print")?.path).toBe(
      "interface/wifi/registration-table",
    );
  });

  test("`detail` is a rendering hint, not a filter", () => {
    expect(toRequest("/ip address print detail")).toEqual({
      method: "GET",
      path: "ip/address",
      query: {},
      countOnly: false,
    });
  });

  test("where with equality becomes a query filter", () => {
    expect(toRequest("/ip address print where interface=ether1")).toEqual({
      method: "GET",
      path: "ip/address",
      query: { interface: "ether1" },
      countOnly: false,
    });
  });

  test("a quoted filter value is unquoted into the query", () => {
    expect(toRequest('/ip address print where comment="my lan"')?.query).toEqual({
      comment: "my lan",
    });
  });

  test("filters without an explicit `where` still map", () => {
    expect(toRequest("/ip address print interface=ether1")?.query).toEqual({
      interface: "ether1",
    });
  });

  test("count-only is flagged for the renderer", () => {
    expect(toRequest("/ip address print count-only")?.countOnly).toBe(true);
  });

  test("regex match (~) has no REST equivalent → null", () => {
    expect(toRequest('/log print where message~"failed"')).toBeNull();
  });

  test("an `or` clause is console-side query syntax → null", () => {
    expect(toRequest("/ip address print where interface=ether1 or interface=ether2")).toBeNull();
  });
});

describe("toRequest — writes", () => {
  test("add → PUT with a body", () => {
    expect(toRequest("/ip address add address=192.168.1.1/24 interface=ether1")).toEqual({
      method: "PUT",
      path: "ip/address",
      query: {},
      body: { address: "192.168.1.1/24", interface: "ether1" },
    });
  });

  test("add with no properties is meaningless → null", () => {
    expect(toRequest("/ip address add")).toBeNull();
  });

  test("set by .id → PATCH on the record", () => {
    expect(toRequest("/ip address set .id=*1 comment=updated")).toEqual({
      method: "PATCH",
      path: "ip/address/*1",
      query: {},
      body: { comment: "updated" },
    });
  });

  test("set on a singleton menu → PATCH on the bare path", () => {
    expect(toRequest("/ip dns set servers=1.1.1.1")).toEqual({
      method: "PATCH",
      path: "ip/dns",
      query: {},
      body: { servers: "1.1.1.1" },
    });
  });

  test("remove by .id → DELETE", () => {
    expect(toRequest("/ip address remove .id=*3")).toEqual({
      method: "DELETE",
      path: "ip/address/*3",
      query: {},
    });
  });

  test("remove without a target → null (never delete a whole menu)", () => {
    expect(toRequest("/ip address remove")).toBeNull();
  });

  test("enable/disable become a disabled= patch", () => {
    expect(toRequest("/ip firewall filter disable .id=*2")).toEqual({
      method: "PATCH",
      path: "ip/firewall/filter/*2",
      query: {},
      body: { disabled: "yes" },
    });
    expect(toRequest("/ip firewall filter enable .id=*2")?.body).toEqual({ disabled: "no" });
  });
});

describe("toRequest — unmappable by design", () => {
  test("a [find] selector resolves console-side → null", () => {
    expect(toRequest("/ip address remove [find interface=ether1]")).toBeNull();
    expect(toRequest("/ip firewall filter set [find chain=input] comment=x")).toBeNull();
  });

  test("/export has no REST equivalent", () => {
    expect(toRequest("/export")).toBeNull();
    expect(toRequest("/ip firewall export")).toBeNull();
  });

  test("backup, scripting and interactive tools are console-only", () => {
    expect(toRequest("/system backup save name=x")).toBeNull();
    expect(toRequest("/tool ping 8.8.8.8")).toBeNull();
    expect(toRequest(":put 1")).toBeNull();
    expect(toRequest("/ip address print; /ip route print")).toBeNull();
    expect(toRequest("/system script run name=$var")).toBeNull();
  });

  test("an unknown verb is not guessed at", () => {
    expect(toRequest("/ip address monitor")).toBeNull();
    expect(toRequest("/interface ethernet reset-counters")).toBeNull();
  });

  test("a non-absolute command is rejected", () => {
    expect(toRequest("ip address print")).toBeNull();
    expect(toRequest("")).toBeNull();
  });
});

describe("toConsoleText", () => {
  test("an array renders as numbered print-detail records", () => {
    const json = [
      { ".id": "*1", address: "192.168.1.1/24", interface: "ether1" },
      { ".id": "*2", address: "10.0.0.1/8", interface: "ether2" },
    ];
    expect(toConsoleText(json)).toBe(
      " 0 .id=*1 address=192.168.1.1/24 interface=ether1\n" +
        " 1 .id=*2 address=10.0.0.1/8 interface=ether2",
    );
  });

  test("a value needing quotes gets them back", () => {
    expect(toConsoleText([{ comment: "my lan link" }])).toBe(' 0 comment="my lan link"');
  });

  test("an empty array is empty text, so isEmpty() still reports nothing found", () => {
    expect(toConsoleText([])).toBe("");
  });

  test("count-only renders the length, not the records", () => {
    expect(toConsoleText([{ a: 1 }, { a: 2 }], { countOnly: true })).toBe("2");
    expect(toConsoleText([], { countOnly: true })).toBe("0");
  });

  test("a settings object renders as key: value lines", () => {
    expect(toConsoleText({ servers: "1.1.1.1", "allow-remote-requests": "true" })).toBe(
      "  servers: 1.1.1.1\n  allow-remote-requests: true",
    );
  });

  test("null and undefined render as empty, never as the string 'null'", () => {
    expect(toConsoleText(null)).toBe("");
    expect(toConsoleText(undefined)).toBe("");
  });

  test("null-valued properties are dropped from a record", () => {
    expect(toConsoleText([{ a: "1", b: null }])).toBe(" 0 a=1");
  });
});
