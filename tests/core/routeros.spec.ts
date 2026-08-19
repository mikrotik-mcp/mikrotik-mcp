/**
 * Unit tests for the RouterOS command/error helpers — the parts that turn
 * device output into success/failure signals.
 */
import { describe, expect, test } from "vite-plus/test";
import {
  commandUnsupported,
  containsRawParserError,
  extractCreatedId,
  indicatesFailure,
  placeBeforeError,
  portConflictError,
  readBackUnavailable,
  routeTypeArg,
  splitHostPort,
} from "../../src/core/routeros";

describe("commandUnsupported", () => {
  test("matches a missing/unknown command path", () => {
    expect(commandUnsupported("bad command name (line 1 column 5)")).toBe(true);
    expect(commandUnsupported("no such command prefix")).toBe(true);
    expect(commandUnsupported("invalid command name")).toBe(true);
  });
  test("does NOT treat an argument syntax error as unsupported", () => {
    // "expected end of command" means the path was recognized but trailing
    // tokens were rejected — a real syntax error, not a missing feature.
    expect(commandUnsupported("expected end of command (line 1 column 14)")).toBe(false);
  });
});

describe("indicatesFailure", () => {
  test('flags the handler "Failed to …:" error convention', () => {
    expect(
      indicatesFailure("Failed to add route: bad parameter routing-mark (line 1 column 79)"),
    ).toBe(true);
    expect(
      indicatesFailure(
        "Failed to create SSTP client: failure: bad address or dns name (/interface/sstp-client/add; line 1)",
      ),
    ).toBe(true);
  });
  test("flags a parser coordinate embedded anywhere in the output", () => {
    expect(indicatesFailure("ROUTES:\n\nsomething (line 2 column 3)")).toBe(true);
  });
  test("does not flag successful output", () => {
    expect(indicatesFailure("Route added successfully:\n\n 0 dst-address=0.0.0.0/0")).toBe(false);
    expect(indicatesFailure("SSTP CLIENTS:\n\n 0 name=sstp1 running=yes")).toBe(false);
    // The word "failed" mid-sentence (not at the start of the first line) is fine.
    expect(indicatesFailure("LOGS:\n\nlogin failed for user admin")).toBe(false);
  });
});

describe("containsRawParserError", () => {
  test("still catches a bare parser error under a success header", () => {
    expect(containsRawParserError("POE:\n\nbad command name poe (line 1 column 21)")).toBe(true);
  });
});

describe("splitHostPort", () => {
  test("splits host:port for IPv4 / hostnames", () => {
    expect(splitHostPort("191.101.113.113:443")).toEqual({ host: "191.101.113.113", port: 443 });
    expect(splitHostPort("vpn.example.com:1194")).toEqual({ host: "vpn.example.com", port: 1194 });
  });
  test("returns host only when no port is present", () => {
    expect(splitHostPort("191.101.113.113")).toEqual({ host: "191.101.113.113" });
    expect(splitHostPort("vpn.example.com")).toEqual({ host: "vpn.example.com" });
  });
  test("leaves a bare IPv6 literal intact (no port to split)", () => {
    expect(splitHostPort("2001:db8::1")).toEqual({ host: "2001:db8::1" });
  });
  test("splits a bracketed IPv6 with a port", () => {
    expect(splitHostPort("[2001:db8::1]:443")).toEqual({ host: "2001:db8::1", port: 443 });
    expect(splitHostPort("[2001:db8::1]")).toEqual({ host: "2001:db8::1" });
  });
});

describe("placeBeforeError", () => {
  const err =
    "item referred by 'place-before' does not exist (11) (/ip/firewall/filter/add; line 1)";
  test("explains a non-existent *N .id and suggests the bare ordinal", () => {
    const msg = placeBeforeError(err, "*13");
    expect(msg).toBeDefined();
    expect(msg).toContain("*13");
    expect(msg).toContain(".id");
    expect(msg).toContain("'13'"); // suggests the bare ordinal
  });
  test("handles a bare-number place_before that was rejected", () => {
    const msg = placeBeforeError(err, "13");
    expect(msg).toContain("ordinal");
  });
  test("returns undefined when place_before was not supplied or the error is unrelated", () => {
    expect(placeBeforeError(err, undefined)).toBeUndefined();
    expect(placeBeforeError("failure: already have such entry", "*13")).toBeUndefined();
  });
});

describe("portConflictError", () => {
  const err =
    "failure: this is configured elsewhere (/ip/service/set *0 = telnet) (/ip/service/set; line 1)";
  test("names the conflicting service and suggests the fix", () => {
    const msg = portConflictError(err, 1996);
    expect(msg).toBeDefined();
    expect(msg).toContain("port 1996");
    expect(msg).toContain("'telnet'");
  });
  // With no port in play the failure cannot BE a port collision — most often it
  // is a `[find …]` selector that matched several rows. Saying "port" there sent
  // callers hunting for a conflict that does not exist.
  test("does not blame a port when no port was being set", () => {
    const msg = portConflictError("failure: this is configured elsewhere");
    expect(msg).toContain("more than one row");
    expect(msg).toContain("not a port collision");
    expect(msg).not.toContain("that port");
  });
  test("still names the row RouterOS pointed at when no port was set", () => {
    expect(portConflictError(err)).toContain("'telnet'");
  });
  test("returns undefined for unrelated errors", () => {
    expect(portConflictError("failure: already have such entry", 22)).toBeUndefined();
  });
});

describe("extractCreatedId", () => {
  test("pulls the *N hex id RouterOS echoes after add", () => {
    expect(extractCreatedId("*1A")).toBe("*1A");
    expect(extractCreatedId("*f")).toBe("*f");
  });
  test("ignores a trailing warning/whitespace and returns just the id", () => {
    // The concrete trigger for the original bug: the raw add output, used
    // verbatim as a `where .id=` key, yields "no such item".
    expect(extractCreatedId("*1A\nwarning: rule may lock you out")).toBe("*1A");
    expect(extractCreatedId("  *2b  ")).toBe("*2b");
  });
  test("accepts a bare ordinal id", () => {
    expect(extractCreatedId("5")).toBe("5");
  });
  test("returns undefined when no id is present", () => {
    expect(extractCreatedId("")).toBeUndefined();
    expect(extractCreatedId("failure: something")).toBeUndefined();
  });
});

describe("readBackUnavailable", () => {
  test("flags the 'no such item (…; line N)' form isEmpty misses", () => {
    expect(readBackUnavailable("no such item (/ip/firewall/filter/print; line 1)")).toBe(true);
  });
  test("flags empty / plain no-such-item / parser errors", () => {
    expect(readBackUnavailable("")).toBe(true);
    expect(readBackUnavailable("no such item")).toBe(true);
    expect(readBackUnavailable("no such item (4)")).toBe(true);
    expect(readBackUnavailable("syntax error (line 1 column 5)")).toBe(true);
  });
  test("returns false for a real record body", () => {
    expect(readBackUnavailable(" 0  chain=input action=accept dst-port=443 .id=*1A")).toBe(false);
  });
});

describe("routeTypeArg", () => {
  // Verified on RouterOS 7: `type=blackhole` → "bad parameter type",
  // `blackhole=yes` → "expected end of command", bare `blackhole` works, and
  // `!blackhole` on `set` turns the route back into a unicast one.
  test("emits the bare keyword for blackhole", () => {
    expect(routeTypeArg("blackhole")).toBe("blackhole");
    expect(routeTypeArg("blackhole", true)).toBe("blackhole");
  });
  test("omits unicast on add but negates it on set", () => {
    expect(routeTypeArg("unicast")).toBeUndefined();
    expect(routeTypeArg("unicast", true)).toBe("!blackhole");
  });
  test("emits nothing when no type was requested", () => {
    expect(routeTypeArg(undefined)).toBeUndefined();
    expect(routeTypeArg(undefined, true)).toBeUndefined();
  });
});
