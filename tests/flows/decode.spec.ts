/**
 * NetFlow v5/v9 + IPFIX decoding, entirely from fixture buffers — no socket, no
 * device. Template decoding is the fiddliest part of flow collection, so the
 * cases here cover the traps: data arriving before its template, a re-sent
 * template with a new layout, unknown field ids, IPv6 layouts, variable-length
 * IPFIX fields, truncation, and the sysUpTime → wall-clock conversion.
 */
import { describe, expect, test } from "vite-plus/test";
import { decodeFlowPacket, ipv6 } from "../../src/flows/decode";
import { TemplateRegistry } from "../../src/flows/templates";

// ── Fixture builders ────────────────────────────────────────────────────────

class Writer {
  private bytes: number[] = [];
  u8(v: number): this {
    this.bytes.push(v & 0xff);
    return this;
  }
  u16(v: number): this {
    this.bytes.push((v >>> 8) & 0xff, v & 0xff);
    return this;
  }
  u32(v: number): this {
    this.bytes.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
    return this;
  }
  u64(v: number): this {
    const high = Math.floor(v / 2 ** 32);
    return this.u32(high).u32(v >>> 0);
  }
  ip(addr: string): this {
    for (const part of addr.split(".")) this.u8(Number(part));
    return this;
  }
  raw(values: number[]): this {
    this.bytes.push(...values.map((v) => v & 0xff));
    return this;
  }
  get length(): number {
    return this.bytes.length;
  }
  done(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

const V9_HEADER_LENGTH = 20;
const UNIX_SECS = 1_700_000_000;
const SYS_UPTIME = 3_600_000; // exporter up one hour
const BOOT = UNIX_SECS * 1000 - SYS_UPTIME;

interface V5Flow {
  src: string;
  dst: string;
  packets: number;
  bytes: number;
  first: number;
  last: number;
  srcPort: number;
  dstPort: number;
  protocol: number;
  tcpFlags?: number;
  tos?: number;
}

function v5Packet(flows: V5Flow[], opts: { count?: number; unixSecs?: number } = {}): Uint8Array {
  const w = new Writer();
  w.u16(5)
    .u16(opts.count ?? flows.length)
    .u32(SYS_UPTIME)
    .u32(opts.unixSecs ?? UNIX_SECS)
    .u32(0) // unix nsecs
    .u32(1) // flow sequence
    .u8(0)
    .u8(0)
    .u16(0);
  for (const f of flows) {
    w.ip(f.src)
      .ip(f.dst)
      .ip("0.0.0.0") // nexthop
      .u16(1) // input
      .u16(2) // output
      .u32(f.packets)
      .u32(f.bytes)
      .u32(f.first)
      .u32(f.last)
      .u16(f.srcPort)
      .u16(f.dstPort)
      .u8(0) // pad
      .u8(f.tcpFlags ?? 0)
      .u8(f.protocol)
      .u8(f.tos ?? 0)
      .u16(0) // src as
      .u16(0) // dst as
      .u8(24)
      .u8(24)
      .u16(0);
  }
  return w.done();
}

/** A v9/IPFIX template set body: [templateId, [id, len]…]. */
function templateSetBody(templateId: number, fields: [number, number][]): number[] {
  const w = new Writer();
  w.u16(templateId).u16(fields.length);
  for (const [id, len] of fields) w.u16(id).u16(len);
  return [...w.done()];
}

function v9Packet(
  sets: { id: number; body: number[] }[],
  opts: { sourceId?: number; unixSecs?: number; sysUpTime?: number } = {},
): Uint8Array {
  const w = new Writer();
  const count = sets.length;
  w.u16(9)
    .u16(count)
    .u32(opts.sysUpTime ?? SYS_UPTIME)
    .u32(opts.unixSecs ?? UNIX_SECS)
    .u32(1) // sequence
    .u32(opts.sourceId ?? 42);
  for (const set of sets) {
    w.u16(set.id)
      .u16(set.body.length + 4)
      .raw(set.body);
  }
  return w.done();
}

function ipfixPacket(
  sets: { id: number; body: number[] }[],
  opts: { domain?: number; exportTime?: number; declaredLength?: number } = {},
): Uint8Array {
  const bodyLength = sets.reduce((n, s) => n + s.body.length + 4, 0);
  const w = new Writer();
  w.u16(10)
    .u16(opts.declaredLength ?? 16 + bodyLength)
    .u32(opts.exportTime ?? UNIX_SECS)
    .u32(1)
    .u32(opts.domain ?? 7);
  for (const set of sets) {
    w.u16(set.id)
      .u16(set.body.length + 4)
      .raw(set.body);
  }
  return w.done();
}

/** The common v9 layout RouterOS exports for IPv4 flows. */
const V4_FIELDS: [number, number][] = [
  [8, 4], // src
  [12, 4], // dst
  [7, 2], // src port
  [11, 2], // dst port
  [4, 1], // protocol
  [1, 4], // bytes
  [2, 4], // packets
  [22, 4], // first switched
  [21, 4], // last switched
];

function v4DataBody(f: {
  src: string;
  dst: string;
  srcPort: number;
  dstPort: number;
  protocol: number;
  bytes: number;
  packets: number;
  first: number;
  last: number;
}): number[] {
  const w = new Writer();
  w.ip(f.src)
    .ip(f.dst)
    .u16(f.srcPort)
    .u16(f.dstPort)
    .u8(f.protocol)
    .u32(f.bytes)
    .u32(f.packets)
    .u32(f.first)
    .u32(f.last);
  return [...w.done()];
}

const FLOW = {
  src: "192.168.88.10",
  dst: "1.1.1.1",
  srcPort: 51234,
  dstPort: 443,
  protocol: 6,
  bytes: 15_000,
  packets: 12,
  first: 3_000_000,
  last: 3_060_000,
};

// ── v5 ──────────────────────────────────────────────────────────────────────

describe("NetFlow v5", () => {
  test("decodes a single flow", () => {
    const result = decodeFlowPacket(
      v5Packet([
        {
          src: "10.0.0.1",
          dst: "8.8.8.8",
          packets: 5,
          bytes: 640,
          first: 1000,
          last: 2000,
          srcPort: 1234,
          dstPort: 53,
          protocol: 17,
        },
      ]),
      new TemplateRegistry(),
    );

    expect(result.error).toBeUndefined();
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      src: "10.0.0.1",
      dst: "8.8.8.8",
      srcPort: 1234,
      dstPort: 53,
      protocol: 17,
      bytes: 640,
      packets: 5,
      version: 5,
    });
  });

  test("converts sysUpTime-relative timestamps to wall clock", () => {
    const [record] = decodeFlowPacket(
      v5Packet([
        {
          src: "10.0.0.1",
          dst: "8.8.8.8",
          packets: 1,
          bytes: 64,
          first: 1_000_000,
          last: 1_500_000,
          srcPort: 1,
          dstPort: 2,
          protocol: 6,
        },
      ]),
      new TemplateRegistry(),
    ).records;

    expect(record.start).toBe(BOOT + 1_000_000);
    expect(record.end).toBe(BOOT + 1_500_000);
    // Sanity: that lands near the exporter's export time, not in 1970.
    expect(record.end).toBeLessThan(UNIX_SECS * 1000);
  });

  test("decodes several flows in one packet", () => {
    const flows = [1, 2, 3].map((i) => ({
      src: `10.0.0.${i}`,
      dst: "8.8.8.8",
      packets: i,
      bytes: i * 100,
      first: 1000,
      last: 2000,
      srcPort: 1000 + i,
      dstPort: 53,
      protocol: 17,
    }));
    const result = decodeFlowPacket(v5Packet(flows), new TemplateRegistry());
    expect(result.records.map((r) => r.src)).toEqual(["10.0.0.1", "10.0.0.2", "10.0.0.3"]);
  });

  test("a count larger than the payload decodes what is there and warns", () => {
    const packet = v5Packet(
      [
        {
          src: "10.0.0.1",
          dst: "8.8.8.8",
          packets: 1,
          bytes: 64,
          first: 1,
          last: 2,
          srcPort: 1,
          dstPort: 2,
          protocol: 6,
        },
      ],
      { count: 30 },
    );
    const result = decodeFlowPacket(packet, new TemplateRegistry());
    expect(result.records).toHaveLength(1);
    expect(result.warnings[0]).toContain("claims 30 records");
  });

  test("an exporter with an unset clock falls back to arrival time", () => {
    const packet = v5Packet(
      [
        {
          src: "10.0.0.1",
          dst: "8.8.8.8",
          packets: 1,
          bytes: 64,
          first: 10,
          last: 20,
          srcPort: 1,
          dstPort: 2,
          protocol: 6,
        },
      ],
      { unixSecs: 0 },
    );
    const result = decodeFlowPacket(packet, new TemplateRegistry(), 1_800_000_000_000);
    expect(result.records[0].start).toBe(1_800_000_000_000);
    expect(result.warnings.join(" ")).toContain("clock unset");
  });

  test("tcp flags and tos survive", () => {
    const [record] = decodeFlowPacket(
      v5Packet([
        {
          src: "10.0.0.1",
          dst: "8.8.8.8",
          packets: 1,
          bytes: 64,
          first: 1,
          last: 2,
          srcPort: 1,
          dstPort: 2,
          protocol: 6,
          tcpFlags: 0x12,
          tos: 0x28,
        },
      ]),
      new TemplateRegistry(),
    ).records;
    expect(record.tcpFlags).toBe(0x12);
    expect(record.tos).toBe(0x28);
  });
});

// ── v9 ──────────────────────────────────────────────────────────────────────

describe("NetFlow v9", () => {
  test("template then data in one packet", () => {
    const registry = new TemplateRegistry();
    const result = decodeFlowPacket(
      v9Packet([
        { id: 0, body: templateSetBody(256, V4_FIELDS) },
        { id: 256, body: v4DataBody(FLOW) },
      ]),
      registry,
    );

    expect(result.templatesLearned).toBe(1);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      src: FLOW.src,
      dst: FLOW.dst,
      srcPort: FLOW.srcPort,
      dstPort: FLOW.dstPort,
      protocol: 6,
      bytes: FLOW.bytes,
      packets: FLOW.packets,
      version: 9,
    });
    expect(result.records[0].start).toBe(BOOT + FLOW.first);
  });

  test("a template in one packet decodes data in the next", () => {
    const registry = new TemplateRegistry();
    decodeFlowPacket(v9Packet([{ id: 0, body: templateSetBody(256, V4_FIELDS) }]), registry);
    const result = decodeFlowPacket(v9Packet([{ id: 256, body: v4DataBody(FLOW) }]), registry);

    expect(result.records).toHaveLength(1);
    expect(result.buffered).toBe(0);
  });

  test("DATA BEFORE TEMPLATE is buffered, then decoded when the template lands", () => {
    const registry = new TemplateRegistry();
    const first = decodeFlowPacket(v9Packet([{ id: 256, body: v4DataBody(FLOW) }]), registry);

    expect(first.records).toHaveLength(0);
    expect(first.buffered).toBe(1);
    expect(registry.pendingCount).toBe(1);

    const second = decodeFlowPacket(
      v9Packet([{ id: 0, body: templateSetBody(256, V4_FIELDS) }]),
      registry,
    );
    expect(second.records).toHaveLength(1);
    expect(second.records[0].src).toBe(FLOW.src);
    expect(registry.pendingCount).toBe(0);
  });

  test("a buffered set keeps ITS OWN header context for timestamps", () => {
    const registry = new TemplateRegistry();
    // Exported an hour before the template packet: the flow must be dated from
    // the packet it arrived in, not from whichever packet taught us the layout.
    decodeFlowPacket(
      v9Packet([{ id: 256, body: v4DataBody(FLOW) }], { unixSecs: UNIX_SECS - 3600 }),
      registry,
    );
    const result = decodeFlowPacket(
      v9Packet([{ id: 0, body: templateSetBody(256, V4_FIELDS) }]),
      registry,
    );
    expect(result.records[0].start).toBe((UNIX_SECS - 3600) * 1000 - SYS_UPTIME + FLOW.first);
  });

  test("templates from different exporters with the same id do not collide", () => {
    const registry = new TemplateRegistry();
    // Exporter 1: the normal layout. Exporter 2: ports swapped in the layout.
    const swapped: [number, number][] = [
      [8, 4],
      [12, 4],
      [11, 2],
      [7, 2],
      [4, 1],
      [1, 4],
      [2, 4],
      [22, 4],
      [21, 4],
    ];
    decodeFlowPacket(
      v9Packet([{ id: 0, body: templateSetBody(256, V4_FIELDS) }], { sourceId: 1 }),
      registry,
    );
    decodeFlowPacket(
      v9Packet([{ id: 0, body: templateSetBody(256, swapped) }], { sourceId: 2 }),
      registry,
    );

    const a = decodeFlowPacket(
      v9Packet([{ id: 256, body: v4DataBody(FLOW) }], { sourceId: 1 }),
      registry,
    );
    const b = decodeFlowPacket(
      v9Packet([{ id: 256, body: v4DataBody(FLOW) }], { sourceId: 2 }),
      registry,
    );

    expect(a.records[0].srcPort).toBe(FLOW.srcPort);
    expect(b.records[0].dstPort).toBe(FLOW.srcPort); // decoded with ITS template
    expect(registry.size).toBe(2);
  });

  test("a re-sent template replaces the previous layout", () => {
    const registry = new TemplateRegistry();
    decodeFlowPacket(v9Packet([{ id: 0, body: templateSetBody(256, V4_FIELDS) }]), registry);
    const shorter: [number, number][] = [
      [8, 4],
      [12, 4],
      [1, 4],
      [2, 4],
    ];
    decodeFlowPacket(v9Packet([{ id: 0, body: templateSetBody(256, shorter) }]), registry);

    const w = new Writer();
    w.ip("10.1.1.1").ip("10.2.2.2").u32(999).u32(9);
    const result = decodeFlowPacket(v9Packet([{ id: 256, body: [...w.done()] }]), registry);
    expect(result.records[0]).toMatchObject({ src: "10.1.1.1", bytes: 999, packets: 9 });
    expect(registry.size).toBe(1);
  });

  test("several data records in one set", () => {
    const registry = new TemplateRegistry();
    const bodies = [1, 2, 3].flatMap((i) =>
      v4DataBody({ ...FLOW, src: `10.0.0.${i}`, bytes: i * 1000 }),
    );
    const result = decodeFlowPacket(
      v9Packet([
        { id: 0, body: templateSetBody(256, V4_FIELDS) },
        { id: 256, body: bodies },
      ]),
      registry,
    );
    expect(result.records.map((r) => r.bytes)).toEqual([1000, 2000, 3000]);
  });

  test("an unknown field id is skipped by length, not fatal", () => {
    const registry = new TemplateRegistry();
    const withVendorField: [number, number][] = [
      [8, 4],
      [12, 4],
      [9999, 6], // nothing knows this one
      [1, 4],
      [2, 4],
    ];
    const w = new Writer();
    w.ip("10.0.0.5").ip("10.0.0.6").raw([1, 2, 3, 4, 5, 6]).u32(4321).u32(7);

    const result = decodeFlowPacket(
      v9Packet([
        { id: 0, body: templateSetBody(256, withVendorField) },
        { id: 256, body: [...w.done()] },
      ]),
      registry,
    );
    expect(result.records[0]).toMatchObject({ src: "10.0.0.5", bytes: 4321, packets: 7 });
  });

  test("an IPv6 flow decodes with the v6 field ids", () => {
    const registry = new TemplateRegistry();
    const v6Fields: [number, number][] = [
      [27, 16],
      [28, 16],
      [7, 2],
      [11, 2],
      [4, 1],
      [1, 4],
      [2, 4],
    ];
    const w = new Writer();
    // 2001:db8::1 → 2606:4700:4700::1111
    w.u16(0x2001).u16(0x0db8).u16(0).u16(0).u16(0).u16(0).u16(0).u16(1);
    w.u16(0x2606).u16(0x4700).u16(0x4700).u16(0).u16(0).u16(0).u16(0).u16(0x1111);
    w.u16(40000).u16(443).u8(6).u32(2048).u32(4);

    const result = decodeFlowPacket(
      v9Packet([
        { id: 0, body: templateSetBody(256, v6Fields) },
        { id: 256, body: [...w.done()] },
      ]),
      registry,
    );
    expect(result.records[0].src).toBe("2001:db8::1");
    expect(result.records[0].dst).toBe("2606:4700:4700::1111");
    expect(result.records[0].dstPort).toBe(443);
  });

  test("an options template set is skipped without error", () => {
    const registry = new TemplateRegistry();
    const result = decodeFlowPacket(
      v9Packet([
        { id: 1, body: [0, 0, 0, 8, 0, 4, 0, 1, 0, 4] },
        { id: 0, body: templateSetBody(256, V4_FIELDS) },
        { id: 256, body: v4DataBody(FLOW) },
      ]),
      registry,
    );
    expect(result.error).toBeUndefined();
    expect(result.records).toHaveLength(1);
  });

  test("interface indices are captured", () => {
    const registry = new TemplateRegistry();
    const fields: [number, number][] = [
      [8, 4],
      [12, 4],
      [10, 2],
      [14, 2],
      [1, 4],
      [2, 4],
    ];
    const w = new Writer();
    w.ip("10.0.0.1").ip("10.0.0.2").u16(3).u16(5).u32(100).u32(2);
    const result = decodeFlowPacket(
      v9Packet([
        { id: 0, body: templateSetBody(256, fields) },
        { id: 256, body: [...w.done()] },
      ]),
      registry,
    );
    expect(result.records[0]).toMatchObject({ inputIf: 3, outputIf: 5 });
  });
});

// ── IPFIX ───────────────────────────────────────────────────────────────────

describe("IPFIX", () => {
  const IPFIX_FIELDS: [number, number][] = [
    [8, 4],
    [12, 4],
    [7, 2],
    [11, 2],
    [4, 1],
    [231, 8], // octetDeltaCount, 64-bit
    [232, 8], // packetDeltaCount
    [152, 8], // flowStartMilliseconds (absolute)
    [153, 8], // flowEndMilliseconds
  ];

  function ipfixData(bytes: number, packets: number, start: number, end: number): number[] {
    const w = new Writer();
    w.ip("172.16.0.9")
      .ip("93.184.216.34")
      .u16(33333)
      .u16(80)
      .u8(6)
      .u64(bytes)
      .u64(packets)
      .u64(start)
      .u64(end);
    return [...w.done()];
  }

  test("template (set id 2) then data decodes with absolute timestamps", () => {
    const registry = new TemplateRegistry();
    const start = 1_700_000_123_000;
    const result = decodeFlowPacket(
      ipfixPacket([
        { id: 2, body: templateSetBody(300, IPFIX_FIELDS) },
        { id: 300, body: ipfixData(9_000_000, 6000, start, start + 5000) },
      ]),
      registry,
    );

    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      src: "172.16.0.9",
      dst: "93.184.216.34",
      dstPort: 80,
      bytes: 9_000_000,
      packets: 6000,
      version: 10,
    });
    // Absolute ms — no sysUpTime arithmetic applied.
    expect(result.records[0].start).toBe(start);
    expect(result.records[0].end).toBe(start + 5000);
  });

  test("64-bit counters beyond 2^32 survive", () => {
    const registry = new TemplateRegistry();
    const big = 8_000_000_000; // 8 GB in one flow
    const result = decodeFlowPacket(
      ipfixPacket([
        { id: 2, body: templateSetBody(300, IPFIX_FIELDS) },
        { id: 300, body: ipfixData(big, 1, 1_700_000_000_000, 1_700_000_001_000) },
      ]),
      registry,
    );
    expect(result.records[0].bytes).toBe(big);
  });

  test("a variable-length field is consumed correctly", () => {
    const registry = new TemplateRegistry();
    const fields: [number, number][] = [
      [8, 4],
      [12, 4],
      [82, 65535], // interfaceName, variable length
      [1, 4],
      [2, 4],
    ];
    const w = new Writer();
    w.ip("10.0.0.1")
      .ip("10.0.0.2")
      .u8(6)
      .raw([...new TextEncoder().encode("ether1")])
      .u32(555)
      .u32(3);

    const result = decodeFlowPacket(
      ipfixPacket([
        { id: 2, body: templateSetBody(300, fields) },
        { id: 300, body: [...w.done()] },
      ]),
      registry,
    );
    expect(result.records[0]).toMatchObject({ src: "10.0.0.1", bytes: 555, packets: 3 });
  });

  test("an enterprise-specific field is skipped", () => {
    const registry = new TemplateRegistry();
    // Template with one vendor field: high bit set, 4-byte enterprise number.
    const w = new Writer();
    w.u16(300).u16(4);
    w.u16(8).u16(4);
    w.u16(12).u16(4);
    w.u16(0x8000 | 1000)
      .u16(4)
      .u32(9);
    w.u16(1).u16(4);

    const data = new Writer();
    data.ip("10.0.0.7").ip("10.0.0.8").u32(0xdeadbeef).u32(777);

    const result = decodeFlowPacket(
      ipfixPacket([
        { id: 2, body: [...w.done()] },
        { id: 300, body: [...data.done()] },
      ]),
      registry,
    );
    expect(result.records[0]).toMatchObject({ src: "10.0.0.7", dst: "10.0.0.8", bytes: 777 });
  });

  test("data before template is buffered for IPFIX too", () => {
    const registry = new TemplateRegistry();
    const start = 1_700_000_500_000;
    const first = decodeFlowPacket(
      ipfixPacket([{ id: 300, body: ipfixData(1234, 5, start, start) }]),
      registry,
    );
    expect(first.buffered).toBe(1);

    const second = decodeFlowPacket(
      ipfixPacket([{ id: 2, body: templateSetBody(300, IPFIX_FIELDS) }]),
      registry,
    );
    expect(second.records[0].bytes).toBe(1234);
  });

  test("a declared length longer than the datagram is warned about, not fatal", () => {
    const registry = new TemplateRegistry();
    const result = decodeFlowPacket(
      ipfixPacket([{ id: 2, body: templateSetBody(300, IPFIX_FIELDS) }], {
        declaredLength: 9999,
      }),
      registry,
    );
    expect(result.error).toBeUndefined();
    expect(result.warnings.join(" ")).toContain("exceeds");
    expect(result.templatesLearned).toBe(1);
  });
});

// ── Malformed input ─────────────────────────────────────────────────────────

describe("malformed packets are rejected, never thrown", () => {
  test("an empty datagram", () => {
    const result = decodeFlowPacket(new Uint8Array(0), new TemplateRegistry());
    expect(result.error).toContain("too short");
    expect(result.records).toEqual([]);
  });

  test("a truncated v9 header", () => {
    const result = decodeFlowPacket(new Uint8Array([0, 9, 0, 1, 0, 0]), new TemplateRegistry());
    expect(result.error).toContain("truncated NetFlow v9");
  });

  test("a truncated v5 header", () => {
    const result = decodeFlowPacket(new Uint8Array([0, 5, 0, 1]), new TemplateRegistry());
    expect(result.error).toContain("truncated NetFlow v5");
  });

  test("v1 is rejected with the fix in the message", () => {
    const result = decodeFlowPacket(
      new Uint8Array(30).fill(0).map((_, i) => (i === 1 ? 1 : 0)),
      new TemplateRegistry(),
    );
    expect(result.error).toContain("version=9 or ipfix");
  });

  test("an unknown version", () => {
    const result = decodeFlowPacket(new Uint8Array([0, 77, 0, 1]), new TemplateRegistry());
    expect(result.error).toContain("unknown flow export version 77");
  });

  test("a set that runs past the end of the packet stops decoding cleanly", () => {
    const registry = new TemplateRegistry();
    const packet = v9Packet([{ id: 0, body: templateSetBody(256, V4_FIELDS) }]);
    // Claim the set is far longer than the bytes present.
    packet[V9_HEADER_LENGTH + 2] = 0xff;
    packet[V9_HEADER_LENGTH + 3] = 0xff;
    const result = decodeFlowPacket(packet, registry);
    expect(result.error).toBeUndefined();
    expect(result.warnings.join(" ")).toContain("truncated");
    expect(result.records).toEqual([]);
  });

  test("a set length below the 4-byte minimum is refused", () => {
    const registry = new TemplateRegistry();
    const packet = v9Packet([{ id: 256, body: [1, 2, 3, 4] }]);
    packet[V9_HEADER_LENGTH + 2] = 0;
    packet[V9_HEADER_LENGTH + 3] = 2;
    const result = decodeFlowPacket(packet, registry);
    expect(result.warnings.join(" ")).toContain("impossible length");
  });

  test("a truncated data record does not emit a half-decoded flow", () => {
    const registry = new TemplateRegistry();
    decodeFlowPacket(v9Packet([{ id: 0, body: templateSetBody(256, V4_FIELDS) }]), registry);
    const short = v4DataBody(FLOW).slice(0, 10);
    const result = decodeFlowPacket(v9Packet([{ id: 256, body: short }]), registry);
    expect(result.records).toEqual([]);
  });
});

// ── Registry behaviour ──────────────────────────────────────────────────────

describe("template registry", () => {
  test("the pending buffer is bounded and counts what it drops", () => {
    const registry = new TemplateRegistry(2);
    for (let i = 0; i < 5; i++) {
      decodeFlowPacket(v9Packet([{ id: 256, body: v4DataBody(FLOW) }]), registry);
    }
    expect(registry.pendingCount).toBe(2);
    expect(registry.droppedCount).toBe(3);
  });

  test("clear() forgets templates and pending sets", () => {
    const registry = new TemplateRegistry();
    decodeFlowPacket(v9Packet([{ id: 0, body: templateSetBody(256, V4_FIELDS) }]), registry);
    decodeFlowPacket(v9Packet([{ id: 999, body: v4DataBody(FLOW) }]), registry);
    expect(registry.size).toBe(1);
    expect(registry.pendingCount).toBe(1);

    registry.clear();
    expect(registry.size).toBe(0);
    expect(registry.pendingCount).toBe(0);
    expect(registry.list()).toEqual([]);
  });

  test("list() exposes what has been learned, for the health strip", () => {
    const registry = new TemplateRegistry();
    decodeFlowPacket(v9Packet([{ id: 0, body: templateSetBody(256, V4_FIELDS) }]), registry);
    const [template] = registry.list();
    expect(template).toMatchObject({ sourceId: 42, templateId: 256, recordLength: 29 });
    expect(template.fields).toHaveLength(9);
  });
});

describe("ipv6 formatting", () => {
  test("compacts the longest zero run", () => {
    const buf = new Uint8Array(16);
    buf[0] = 0x20;
    buf[1] = 0x01;
    buf[2] = 0x0d;
    buf[3] = 0xb8;
    buf[15] = 1;
    expect(ipv6(buf, 0)).toBe("2001:db8::1");
  });

  test("all zeros is ::", () => {
    expect(ipv6(new Uint8Array(16), 0)).toBe("::");
  });

  test("a single zero group is not collapsed", () => {
    const buf = new Uint8Array(16);
    for (let i = 0; i < 8; i++) {
      if (i !== 3) {
        buf[i * 2] = 0x20;
        buf[i * 2 + 1] = i + 1;
      }
    }
    expect(ipv6(buf, 0)).toContain(":0:");
  });
});
