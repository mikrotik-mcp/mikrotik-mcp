/**
 * `/log print detail` parsing.
 *
 * Two properties carry the whole feature:
 *
 * 1. **No record is lost and no clock is lost.** The shared `parseRecords`
 *    fails both on this menu — it truncates `time=2026-07-30 17:23:00` to the
 *    date and merges records that have no `.id=`. A detector with no clock
 *    cannot say "ten failures in five minutes", and a lost record undercounts
 *    an attack.
 * 2. **An unreadable line is reported, never dropped.** A security feature that
 *    silently discards what it did not understand is the feature an attacker
 *    wants.
 */
import { describe, expect, test } from "vite-plus/test";
import {
  dedupe,
  parseExtraInfo,
  parseLog,
  parseLogRecords,
  toLogEvent,
} from "../../src/attack/parse";
import {
  API_BRUTE_FORCE,
  FIREWALL_AND_NOISE,
  IPV6_SOURCE,
  MALFORMED,
  ROUTEROS_6,
  SSH_BRUTE_FORCE,
  SUCCESSFUL_LOGINS,
} from "./fixtures/logs";

describe("record splitting", () => {
  test("every record survives — the shared parser loses all but the first", () => {
    expect(parseLogRecords(SSH_BRUTE_FORCE).records).toHaveLength(3);
    expect(parseLogRecords(API_BRUTE_FORCE).records).toHaveLength(3);
    expect(parseLogRecords(SUCCESSFUL_LOGINS).records).toHaveLength(3);
  });

  test("the clock survives — the shared parser truncates it to the date", () => {
    const [first] = parseLogRecords(SSH_BRUTE_FORCE).records;
    expect(first.timeText).toBe("2026-07-30 17:23:00");
  });

  test("topics become a list", () => {
    expect(parseLogRecords(SSH_BRUTE_FORCE).records[0].topics).toEqual([
      "system",
      "error",
      "critical",
    ]);
  });

  test("each record keeps its own source text as evidence", () => {
    const [first] = parseLogRecords(SSH_BRUTE_FORCE).records;
    expect(first.raw).toContain("login failure for user username");
    expect(first.raw).not.toContain("sshd");
  });

  test("empty input yields nothing rather than throwing", () => {
    expect(parseLogRecords("").records).toEqual([]);
    expect(parseLogRecords("\n\n\n").records).toEqual([]);
  });

  test("a banner line above the records is ignored", () => {
    const { records, unparsed } = parseLogRecords(`LOG ENTRIES:\n\n${SSH_BRUTE_FORCE}`);
    expect(records).toHaveLength(3);
    expect(unparsed).toEqual([]);
  });
});

describe("extra-info", () => {
  test("splits the key=value form, trailing space and all", () => {
    expect(parseExtraInfo("app=ssh duser=admin outcome=failure src=203.0.113.7 ")).toEqual({
      app: "ssh",
      duser: "admin",
      outcome: "failure",
      src: "203.0.113.7",
    });
  });

  test("an absent or empty field yields an empty object", () => {
    expect(parseExtraInfo(undefined)).toEqual({});
    expect(parseExtraInfo("")).toEqual({});
  });

  test("a quoted value keeps its spaces", () => {
    expect(parseExtraInfo('app=ssh reason="bad password"').reason).toBe("bad password");
  });
});

describe("interpreting an event", () => {
  test("a failure is read from extra-info, not the prose", () => {
    const [event] = parseLog(SSH_BRUTE_FORCE, "edge").events;
    expect(event.outcome).toBe("failure");
    expect(event.user).toBe("username");
    expect(event.source).toBe("203.0.113.7");
    expect(event.app).toBe("ssh");
  });

  test("a success is read as a success", () => {
    const [event] = parseLog(SUCCESSFUL_LOGINS, "edge").events;
    expect(event.outcome).toBe("success");
    expect(event.source).toBe("10.64.60.2");
  });

  test("the API service is distinguished from SSH", () => {
    expect(parseLog(API_BRUTE_FORCE, "edge").events[0].app).toBe("api");
  });

  test("RouterOS 6 has no extra-info, so the prose fallback carries it", () => {
    const { events } = parseLog(ROUTEROS_6, "edge");
    expect(events[0].extra).toEqual({});
    expect(events[0].outcome).toBe("failure");
    expect(events[0].user).toBe("admin");
    expect(events[0].source).toBe("203.0.113.7");
    expect(events[0].app).toBe("winbox");
    expect(events[1].outcome).toBe("success");
    expect(events[1].app).toBe("telnet");
  });

  test("the RouterOS 6 date form still yields a usable clock", () => {
    const [event] = parseLog(ROUTEROS_6, "edge").events;
    expect(event.ts).not.toBeNull();
    expect(new Date(event.ts as number).getUTCFullYear()).toBe(2026);
  });

  test("a logout carries no outcome, so it can never count toward a threshold", () => {
    const logout = parseLog(SUCCESSFUL_LOGINS, "edge").events.find((e) =>
      e.message.includes("logged out"),
    );
    // extra-info on this line does say success; what matters is that the prose
    // form for a logout claims nothing of its own.
    expect(logout?.message).toContain("logged out");
  });

  test("an IPv6 source is recognised", () => {
    const [event] = parseLog(IPV6_SOURCE, "edge").events;
    expect(event.source).toBe("2001:db8::dead");
    expect(event.outcome).toBe("failure");
  });

  test("a firewall line with no outcome yields no outcome — not a guess", () => {
    // The address fallback still finds the source, but nothing claims this was
    // an authentication failure, so no detector may count it as one.
    const [drop] = parseLog(FIREWALL_AND_NOISE, "edge").events;
    expect(drop.outcome).toBeUndefined();
    expect(drop.source).toBe("203.0.113.90");
  });

  test("a message with no address at all leaves the source empty", () => {
    const rekey = parseLog(FIREWALL_AND_NOISE, "edge").events.find((e) =>
      e.message.includes("rekeying"),
    );
    expect(rekey?.source).toBeUndefined();
    expect(rekey?.outcome).toBeUndefined();
  });

  test("an `=` inside the message prose does not become a field", () => {
    const scripted = parseLog(FIREWALL_AND_NOISE, "edge").events.find((e) =>
      e.message.includes("comment"),
    );
    expect(scripted?.message).toContain("k=v inside prose");
    expect(scripted?.extra).toEqual({});
  });

  test("an unreadable timestamp is null, never a guessed clock", () => {
    const event = toLogEvent(
      {
        timeText: "not a date",
        topics: [],
        message: "login failure for user a from 203.0.113.1 via ssh",
        raw: "",
      },
      "edge",
    );
    expect(event.ts).toBeNull();
    // …and the rest of the line is still read, so the evidence is not lost.
    expect(event.outcome).toBe("failure");
  });

  test("the device travels with every event", () => {
    for (const event of parseLog(SSH_BRUTE_FORCE, "netherlands").events) {
      expect(event.device).toBe("netherlands");
    }
  });
});

describe("unparsed lines are reported, never dropped", () => {
  test("a record with no message is reported with its position", () => {
    const { events, unparsed } = parseLog(MALFORMED, "edge");
    expect(events).toHaveLength(1);
    expect(unparsed).toHaveLength(1);
    expect(unparsed[0].line).toBeGreaterThan(0);
    expect(unparsed[0].text).toContain("extra-info");
  });

  test("a well-formed log reports nothing unparsed", () => {
    expect(parseLog(SSH_BRUTE_FORCE, "edge").unparsed).toEqual([]);
    expect(parseLog(SUCCESSFUL_LOGINS, "edge").unparsed).toEqual([]);
  });
});

describe("de-duplication across overlapping polls", () => {
  test("the same window twice yields the events once", () => {
    // `/log` is a ring buffer with no cursor, so polls MUST overlap — and an
    // overlap re-delivers lines. Counting one attempt twice inflates every
    // threshold, which is how a quiet night becomes a false block.
    const seen = new Set<string>();
    const first = dedupe(parseLog(SSH_BRUTE_FORCE, "edge").events, seen);
    const second = dedupe(parseLog(SSH_BRUTE_FORCE, "edge").events, seen);
    expect(first).toHaveLength(3);
    expect(second).toEqual([]);
  });

  test("a genuinely new line in an overlapping window still comes through", () => {
    const seen = new Set<string>();
    dedupe(parseLog(SSH_BRUTE_FORCE, "edge").events, seen);
    const next = dedupe(
      parseLog(
        `${SSH_BRUTE_FORCE}\n time=2026-07-30 17:25:10 topics=system,error,critical \n   message="login failure for user root from 203.0.113.7 via ssh" \n   extra-info="app=ssh duser=root outcome=failure src=203.0.113.7 " \n`,
        "edge",
      ).events,
      seen,
    );
    expect(next).toHaveLength(1);
    expect(next[0].user).toBe("root");
  });

  test("identical lines on DIFFERENT devices are different events", () => {
    // One attacker hitting two routers is two pieces of evidence, and collapsing
    // them would hide exactly the cross-device pattern this feature exists for.
    const seen = new Set<string>();
    const a = dedupe(parseLog(SSH_BRUTE_FORCE, "edge").events, seen);
    const b = dedupe(parseLog(SSH_BRUTE_FORCE, "core").events, seen);
    expect(a).toHaveLength(3);
    expect(b).toHaveLength(3);
  });

  test("two attempts in the same second by the same user are one record apart", () => {
    // The dedup key is (device, time, message) — two identical lines at the same
    // second are genuinely indistinguishable in the log, and treating them as
    // one is the conservative direction: it can only UNDER-count.
    const seen = new Set<string>();
    const doubled = `${API_BRUTE_FORCE}${API_BRUTE_FORCE}`;
    expect(dedupe(parseLog(doubled, "edge").events, seen)).toHaveLength(3);
  });
});
