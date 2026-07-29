/**
 * Flow aggregation — top-N ranking, conversations, application naming, the
 * timeline's time-spreading, and the anomaly check. All pure, all from fixture
 * records: no socket, no store, no device.
 */
import { describe, expect, test } from "vite-plus/test";
import {
  applicationName,
  conversations,
  detectAnomalies,
  humanBytes,
  inWindow,
  protocolMix,
  protocolName,
  summarize,
  timeline,
  topTalkers,
} from "../../src/flows/aggregate";
import type { FlowRecord } from "../../src/flows/decode";

const T0 = 1_700_000_000_000;

function flow(over: Partial<FlowRecord> = {}): FlowRecord {
  return {
    start: T0,
    end: T0 + 1000,
    src: "192.168.88.10",
    dst: "1.1.1.1",
    srcPort: 51234,
    dstPort: 443,
    protocol: 6,
    bytes: 1000,
    packets: 10,
    version: 9,
    ...over,
  };
}

describe("top talkers", () => {
  test("ranks by bytes and reports each share of the total", () => {
    const top = topTalkers(
      [
        flow({ src: "10.0.0.1", bytes: 300 }),
        flow({ src: "10.0.0.2", bytes: 600 }),
        flow({ src: "10.0.0.1", bytes: 100 }),
      ],
      "source",
    );

    expect(top.map((t) => t.key)).toEqual(["10.0.0.2", "10.0.0.1"]);
    expect(top[0]).toMatchObject({ bytes: 600, flows: 1, share: 0.6 });
    expect(top[1]).toMatchObject({ bytes: 400, flows: 2, share: 0.4 });
  });

  test("ties break by key so re-rendering the same window is stable", () => {
    const first = topTalkers(
      [flow({ src: "10.0.0.9", bytes: 500 }), flow({ src: "10.0.0.2", bytes: 500 })],
      "source",
    );
    const reversed = topTalkers(
      [flow({ src: "10.0.0.2", bytes: 500 }), flow({ src: "10.0.0.9", bytes: 500 })],
      "source",
    );
    expect(first.map((t) => t.key)).toEqual(["10.0.0.2", "10.0.0.9"]);
    expect(reversed.map((t) => t.key)).toEqual(first.map((t) => t.key));
  });

  test("limit truncates and `other` folds the tail so shares still sum to 1", () => {
    const records = [1, 2, 3, 4, 5].map((i) => flow({ src: `10.0.0.${i}`, bytes: i * 100 }));
    const capped = topTalkers(records, "source", 2, true);

    expect(capped.map((t) => t.key)).toEqual(["10.0.0.5", "10.0.0.4", "other"]);
    expect(capped.at(-1)).toMatchObject({ bytes: 600, flows: 3 });
    const total = capped.reduce((n, t) => n + t.share, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  test("without `other`, the tail is simply dropped", () => {
    const records = [1, 2, 3].map((i) => flow({ src: `10.0.0.${i}`, bytes: i * 100 }));
    expect(topTalkers(records, "source", 2)).toHaveLength(2);
  });

  test("groups by destination, conversation and application", () => {
    const records = [
      flow({ src: "a", dst: "b", dstPort: 443, bytes: 100 }),
      flow({ src: "a", dst: "c", dstPort: 53, protocol: 17, bytes: 50 }),
    ];
    expect(topTalkers(records, "destination").map((t) => t.key)).toEqual(["b", "c"]);
    expect(topTalkers(records, "conversation").map((t) => t.key)).toEqual(["a → b", "a → c"]);
    expect(topTalkers(records, "application").map((t) => t.key)).toEqual(["https", "dns"]);
  });

  test("an empty window yields no rows and no division by zero", () => {
    expect(topTalkers([], "source")).toEqual([]);
    expect(topTalkers([flow({ bytes: 0 })], "source")[0].share).toBe(0);
  });
});

describe("application naming", () => {
  test("names by the well-known side, not the ephemeral port", () => {
    expect(applicationName({ srcPort: 51234, dstPort: 443, protocol: 6 })).toBe("https");
    expect(applicationName({ srcPort: 443, dstPort: 51234, protocol: 6 })).toBe("https");
    expect(applicationName({ srcPort: 33333, dstPort: 22, protocol: 6 })).toBe("ssh");
  });

  test("knows the MikroTik-specific ports", () => {
    expect(applicationName({ srcPort: 1000, dstPort: 8291, protocol: 6 })).toBe("winbox");
    expect(applicationName({ srcPort: 1000, dstPort: 13231, protocol: 17 })).toBe("wireguard");
  });

  test("an unknown port is labelled, never guessed", () => {
    expect(applicationName({ srcPort: 40000, dstPort: 9999, protocol: 6 })).toBe("tcp/9999");
  });

  test("a portless protocol is named by protocol alone", () => {
    expect(applicationName({ srcPort: 0, dstPort: 0, protocol: 1 })).toBe("icmp");
    expect(protocolName(47)).toBe("gre");
    expect(protocolName(200)).toBe("proto-200");
  });
});

describe("conversations", () => {
  test("folds both directions into one row by default", () => {
    const rows = conversations([
      flow({ src: "a", dst: "b", bytes: 1000 }),
      flow({ src: "b", dst: "a", bytes: 250 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ src: "a", dst: "b", bytes: 1250, flows: 2 });
  });

  test("directional mode keeps them apart", () => {
    const rows = conversations(
      [flow({ src: "a", dst: "b", bytes: 1000 }), flow({ src: "b", dst: "a", bytes: 250 })],
      20,
      false,
    );
    expect(rows).toHaveLength(2);
  });

  test("lists the applications of a conversation, busiest first", () => {
    const rows = conversations([
      flow({ src: "a", dst: "b", dstPort: 443, bytes: 100 }),
      flow({ src: "a", dst: "b", dstPort: 22, bytes: 900 }),
    ]);
    expect(rows[0].applications).toEqual(["ssh", "https"]);
  });

  test("limit applies after ranking", () => {
    const rows = conversations(
      [1, 2, 3].map((i) => flow({ src: `s${i}`, dst: "zz", bytes: i * 10 })),
      2,
    );
    expect(rows.map((r) => r.src)).toEqual(["s3", "s2"]);
    expect(rows.map((r) => r.bytes)).toEqual([30, 20]);
  });

  test("a folded pair is keyed with the lower address first, either way round", () => {
    const [row] = conversations([flow({ src: "zz", dst: "aa", bytes: 5 })]);
    expect(row).toMatchObject({ src: "aa", dst: "zz" });
  });
});

describe("protocol mix", () => {
  test("shares by protocol name, busiest first", () => {
    const mix = protocolMix([
      flow({ protocol: 6, bytes: 750 }),
      flow({ protocol: 17, bytes: 250 }),
    ]);
    expect(mix).toEqual([
      { protocol: "tcp", bytes: 750, share: 0.75 },
      { protocol: "udp", bytes: 250, share: 0.25 },
    ]);
  });
});

describe("windows", () => {
  test("a flow is in the window when it OVERLAPS it, not when it starts in it", () => {
    const spanning = flow({ start: T0 - 60_000, end: T0 + 60_000 });
    expect(inWindow([spanning], T0, T0 + 1000)).toHaveLength(1);
  });

  test("boundaries: `from` is inclusive, `to` exclusive", () => {
    const endsAtFrom = flow({ start: T0 - 1000, end: T0 });
    const startsAtTo = flow({ start: T0 + 1000, end: T0 + 2000 });
    expect(inWindow([endsAtFrom], T0, T0 + 1000)).toHaveLength(1);
    expect(inWindow([startsAtTo], T0, T0 + 1000)).toHaveLength(0);
  });

  test("a flow entirely before the window is excluded", () => {
    expect(inWindow([flow({ start: T0 - 5000, end: T0 - 4000 })], T0, T0 + 1000)).toEqual([]);
  });
});

describe("timeline", () => {
  test("spreads a long flow across every bucket it spans", () => {
    // One 4-minute flow of 4000 bytes → 1000 bytes in each 1-minute bucket,
    // rather than a spike in the first.
    const buckets = timeline(
      [flow({ src: "a", start: T0, end: T0 + 4 * 60_000 - 1, bytes: 4000 })],
      T0,
      T0 + 4 * 60_000,
      60_000,
    );
    expect(buckets).toHaveLength(4);
    for (const b of buckets) expect(b.series.a).toBeCloseTo(1000, 6);
  });

  test("keeps top-N keys separate and folds the rest into `other`", () => {
    const records = [
      flow({ src: "big", bytes: 10_000, start: T0, end: T0 + 1000 }),
      flow({ src: "small1", bytes: 10, start: T0, end: T0 + 1000 }),
      flow({ src: "small2", bytes: 10, start: T0, end: T0 + 1000 }),
    ];
    const [bucket] = timeline(records, T0, T0 + 60_000, 60_000, "source", 1);
    expect(bucket.series.big).toBe(10_000);
    expect(bucket.series.other).toBe(20);
  });

  test("clips a flow that starts before the window", () => {
    const buckets = timeline(
      [flow({ src: "a", start: T0 - 120_000, end: T0 + 60_000, bytes: 900 })],
      T0,
      T0 + 120_000,
      60_000,
    );
    // Only the part inside the window is drawn, and a flow ending exactly on a
    // bucket boundary does not paint the bucket that starts as it stops.
    expect(buckets[0].series.a).toBeGreaterThan(0);
    expect(Object.keys(buckets[1].series)).toHaveLength(0);
  });

  test("rejects a nonsensical window or bucket size instead of looping", () => {
    expect(timeline([flow()], T0, T0, 60_000)).toEqual([]);
    expect(timeline([flow()], T0, T0 + 1000, 0)).toEqual([]);
  });
});

describe("anomalies", () => {
  const window = [flow({ src: "10.0.0.5", bytes: 50_000_000 })];

  test("flags a talker well above its baseline", () => {
    const baseline = [flow({ src: "10.0.0.5", bytes: 5_000_000 })];
    const found = detectAnomalies(window, baseline, { ratio: 3 });
    expect(found).toHaveLength(1);
    expect(found[0].ratio).toBeCloseTo(10, 6);
    expect(found[0].reason).toContain("10.0×");
  });

  test("does not flag a talker inside the threshold", () => {
    const baseline = [flow({ src: "10.0.0.5", bytes: 25_000_000 })];
    expect(detectAnomalies(window, baseline, { ratio: 3 })).toEqual([]);
  });

  test("a talker absent from the baseline is flagged as new", () => {
    const found = detectAnomalies(window, [], {});
    expect(found[0]).toMatchObject({ ratio: Infinity, baseline: 0 });
    expect(found[0].reason).toContain("not seen in the baseline");
  });

  test("small talkers are suppressed — 10× of nothing is not an incident", () => {
    const tiny = [flow({ src: "10.0.0.6", bytes: 20_000 })];
    expect(detectAnomalies(tiny, [], { minBytes: 1_000_000 })).toEqual([]);
    expect(detectAnomalies(tiny, [], { minBytes: 1000 })).toHaveLength(1);
  });

  test("a multi-window baseline is averaged, not summed", () => {
    // 24 h of baseline compared against a 1 h window: without dividing, every
    // talker would look 24× quieter than usual and nothing would ever fire.
    const baseline = [flow({ src: "10.0.0.5", bytes: 240_000_000 })];
    expect(detectAnomalies(window, baseline, { ratio: 3, baselineWindows: 24 })).toHaveLength(1);
    expect(detectAnomalies(window, baseline, { ratio: 3, baselineWindows: 1 })).toEqual([]);
  });

  test("results are ordered by volume", () => {
    const records = [flow({ src: "a", bytes: 10_000_000 }), flow({ src: "b", bytes: 90_000_000 })];
    expect(detectAnomalies(records, [], {}).map((x) => x.key)).toEqual(["b", "a"]);
  });
});

describe("summaries", () => {
  test("counts flows, bytes and distinct endpoints", () => {
    const s = summarize([
      flow({ src: "a", dst: "x", bytes: 100, packets: 1 }),
      flow({ src: "a", dst: "y", bytes: 200, packets: 2 }),
      flow({ src: "b", dst: "x", bytes: 300, packets: 3 }),
    ]);
    expect(s).toEqual({ flows: 3, bytes: 600, packets: 6, sources: 2, destinations: 2 });
  });

  test("humanBytes scales and stays short", () => {
    expect(humanBytes(512)).toBe("512 B");
    expect(humanBytes(1536)).toBe("1.5 KB");
    expect(humanBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(humanBytes(3.5 * 1024 ** 3)).toBe("3.5 GB");
  });
});
