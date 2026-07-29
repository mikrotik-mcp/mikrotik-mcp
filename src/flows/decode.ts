/**
 * NetFlow v5 / v9 and IPFIX decoder — PURE, takes a `Uint8Array`, no I/O.
 *
 * RouterOS's `/ip traffic-flow` exports one of three wire formats:
 *
 *   • **v5**  — fixed 48-byte records, IPv4 only, no templates. Simple, legacy.
 *   • **v9**  — template-based; header carries `sysUpTime` + `unixSecs`, and flow
 *               timestamps are RELATIVE to the exporter's boot time.
 *   • **IPFIX** (v10) — template-based, absolute millisecond timestamps.
 *
 * Two things make this fiddly, and both are handled explicitly:
 *
 * 1. **Data before template.** A data record cannot be decoded until its
 *    template has been seen. Rather than dropping it, the set is buffered in the
 *    {@link TemplateRegistry} and replayed when the template arrives.
 * 2. **Timestamps are not wall clock.** v5/v9 report `first`/`last` as
 *    milliseconds since the exporter booted; converting needs the header's
 *    `sysUpTime` and `unixSecs` (`wall = unixSecs*1000 - sysUpTime + relative`).
 *    IPFIX usually carries absolute milliseconds instead.
 *
 * Robustness rule: a malformed packet is REJECTED with an error, never thrown —
 * a collector must not die because one exporter sent 40 bytes of noise to its
 * port. Unknown field ids are skipped by length, not treated as fatal, so a
 * vendor extension in the middle of a template doesn't cost the whole record.
 */
import { TemplateRegistry } from "./templates";
import type { PacketContext, Template, TemplateField } from "./templates";

/** One decoded flow — the unit everything downstream aggregates. */
export interface FlowRecord {
  /** Exporter address; filled in by the collector, which knows the sender. */
  exporter?: string;
  /** Flow start / end as wall-clock epoch ms. */
  start: number;
  end: number;
  src: string;
  dst: string;
  srcPort: number;
  dstPort: number;
  /** IP protocol number (6 = TCP, 17 = UDP, 1 = ICMP). */
  protocol: number;
  bytes: number;
  packets: number;
  tos?: number;
  tcpFlags?: number;
  inputIf?: number;
  outputIf?: number;
  /** 5, 9 or 10 (IPFIX). */
  version: number;
}

export interface DecodeResult {
  records: FlowRecord[];
  /** Templates learned from this packet. */
  templatesLearned: number;
  /** Data sets buffered because their template is not known yet. */
  buffered: number;
  /** Non-fatal problems worth surfacing on the collector-health strip. */
  warnings: string[];
  /** Set when the packet was rejected outright (nothing was decoded). */
  error?: string;
}

// ── Information Element ids (v9 and IPFIX share the low numbers) ────────────

const IE = {
  IN_BYTES: 1,
  IN_PKTS: 2,
  PROTOCOL: 4,
  TOS: 5,
  TCP_FLAGS: 6,
  L4_SRC_PORT: 7,
  IPV4_SRC_ADDR: 8,
  INPUT_SNMP: 10,
  L4_DST_PORT: 11,
  IPV4_DST_ADDR: 12,
  OUTPUT_SNMP: 14,
  LAST_SWITCHED: 21,
  FIRST_SWITCHED: 22,
  IPV6_SRC_ADDR: 27,
  IPV6_DST_ADDR: 28,
  /** IPFIX absolute timestamps (ms since epoch). */
  FLOW_START_MS: 152,
  FLOW_END_MS: 153,
  /** IPFIX 64-bit counters — RouterOS uses these for long-lived flows. */
  OCTET_DELTA_COUNT: 231,
  PACKET_DELTA_COUNT: 232,
} as const;

const V5_HEADER = 24;
const V5_RECORD = 48;
const V9_HEADER = 20;
const IPFIX_HEADER = 16;
/** IPFIX marks a variable-length field with this template length. */
const VARIABLE_LENGTH = 65535;

// ── Small readers ───────────────────────────────────────────────────────────

function u16(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1];
}

function u32(b: Uint8Array, o: number): number {
  // `>>> 0` because the top bit set would otherwise read as negative.
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

/** Read an unsigned integer of 1–8 bytes. Widths > 6 go through Number, which is
 *  exact to 2^53 — far beyond any real byte counter. */
function uint(b: Uint8Array, o: number, len: number): number {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + b[o + i];
  return v;
}

function ipv4(b: Uint8Array, o: number): string {
  return `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
}

/** Compact an IPv6 address the way RouterOS prints it (longest run of zeros). */
export function ipv6(b: Uint8Array, o: number): string {
  const groups: number[] = [];
  for (let i = 0; i < 8; i++) groups.push(u16(b, o + i * 2));

  let bestStart = -1;
  let bestLen = 0;
  let start = -1;
  for (let i = 0; i <= groups.length; i++) {
    if (i < groups.length && groups[i] === 0) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      const len = i - start;
      if (len > bestLen) {
        bestLen = len;
        bestStart = start;
      }
      start = -1;
    }
  }
  // A single zero group is written out; only a run of 2+ is worth collapsing.
  if (bestLen < 2) return groups.map((g) => g.toString(16)).join(":");
  const head = groups.slice(0, bestStart).map((g) => g.toString(16));
  const tail = groups.slice(bestStart + bestLen).map((g) => g.toString(16));
  return `${head.join(":")}::${tail.join(":")}`;
}

// ── v5 ──────────────────────────────────────────────────────────────────────

function decodeV5(buf: Uint8Array, receivedAt: number): DecodeResult {
  const warnings: string[] = [];
  const count = u16(buf, 2);
  const sysUpTime = u32(buf, 4);
  const unixSecs = u32(buf, 8);
  const bootTime = unixSecs * 1000 - sysUpTime;

  const available = Math.floor((buf.length - V5_HEADER) / V5_RECORD);
  if (available < count) {
    // Truncated: decode what is actually present rather than reading past the
    // end (and say so — a consistently short packet means a broken exporter/MTU).
    warnings.push(`v5 packet claims ${count} records but carries ${available}`);
  }
  const usable = Math.min(count, available);

  const records: FlowRecord[] = [];
  for (let i = 0; i < usable; i++) {
    const o = V5_HEADER + i * V5_RECORD;
    records.push({
      src: ipv4(buf, o),
      dst: ipv4(buf, o + 4),
      inputIf: u16(buf, o + 12),
      outputIf: u16(buf, o + 14),
      packets: u32(buf, o + 16),
      bytes: u32(buf, o + 20),
      start: bootTime + u32(buf, o + 24),
      end: bootTime + u32(buf, o + 28),
      srcPort: u16(buf, o + 32),
      dstPort: u16(buf, o + 34),
      tcpFlags: buf[o + 37],
      protocol: buf[o + 38],
      tos: buf[o + 39],
      version: 5,
    });
  }
  // An exporter whose clock is unset reports 1970; fall back to arrival time so
  // the flow doesn't land 55 years in the past and vanish from every window.
  if (unixSecs === 0) {
    warnings.push("v5 exporter reported unixSecs=0 (clock unset); using arrival time");
    for (const r of records) {
      r.start = receivedAt;
      r.end = receivedAt;
    }
  }
  return { records, templatesLearned: 0, buffered: 0, warnings };
}

// ── Templates (v9 + IPFIX share the record shape, IPFIX adds enterprise ids) ─

/** Parse one template SET body into templates. Returns null when malformed. */
function parseTemplateSet(
  body: Uint8Array,
  sourceId: number,
  version: 9 | 10,
  learnedAt: number,
): Template[] | null {
  const templates: Template[] = [];
  let o = 0;
  while (o + 4 <= body.length) {
    const templateId = u16(body, o);
    const fieldCount = u16(body, o + 2);
    o += 4;
    // A template set is padded to a 4-byte boundary; trailing zeros are padding,
    // not a template with id 0.
    if (templateId === 0 && fieldCount === 0) break;

    const fields: TemplateField[] = [];
    let recordLength: number | null = 0;
    for (let f = 0; f < fieldCount; f++) {
      if (o + 4 > body.length) return null; // truncated template — reject the set
      let id = u16(body, o);
      const length = u16(body, o + 2);
      o += 4;
      let enterprise: number | undefined;
      // IPFIX: the high bit of the id marks a vendor field, whose 4-byte
      // enterprise number follows. v9 has no such concept.
      if (version === 10 && (id & 0x8000) !== 0) {
        if (o + 4 > body.length) return null;
        id &= 0x7fff;
        enterprise = u32(body, o);
        o += 4;
      }
      fields.push({ id, length, enterprise });
      if (length === VARIABLE_LENGTH) recordLength = null;
      else if (recordLength !== null) recordLength += length;
    }
    templates.push({ sourceId, templateId, fields, recordLength, learnedAt });
  }
  return templates;
}

// ── Data records ────────────────────────────────────────────────────────────

/**
 * Read one field value at `o`, returning the value and how many bytes it
 * consumed. IPFIX variable-length fields carry their own length prefix (1 byte,
 * or 0xFF followed by 2 bytes) — mis-handling that desynchronises the whole set,
 * so it is decoded even for fields we then ignore.
 */
function readField(
  buf: Uint8Array,
  o: number,
  field: TemplateField,
): { start: number; length: number; consumed: number } | null {
  if (field.length !== VARIABLE_LENGTH) {
    if (o + field.length > buf.length) return null;
    return { start: o, length: field.length, consumed: field.length };
  }
  if (o >= buf.length) return null;
  const first = buf[o];
  if (first < 255) {
    if (o + 1 + first > buf.length) return null;
    return { start: o + 1, length: first, consumed: 1 + first };
  }
  if (o + 3 > buf.length) return null;
  const len = u16(buf, o + 1);
  if (o + 3 + len > buf.length) return null;
  return { start: o + 3, length: len, consumed: 3 + len };
}

/** Warning emitted once per packet when the exporter's clock is unset. */
const CLOCK_WARNING = "exporter reported unixSecs=0 (clock unset); using arrival time";

/** Decode one data record against its template. */
function decodeRecord(
  buf: Uint8Array,
  offset: number,
  template: Template,
  ctx: PacketContext,
  warnings: string[],
): { record: FlowRecord; consumed: number } | null {
  const bootTime = ctx.unixSecs * 1000 - ctx.sysUpTime;
  const record: FlowRecord = {
    start: 0,
    end: 0,
    src: "",
    dst: "",
    srcPort: 0,
    dstPort: 0,
    protocol: 0,
    bytes: 0,
    packets: 0,
    version: ctx.version,
  };
  let relativeStart: number | undefined;
  let relativeEnd: number | undefined;
  let o = offset;

  for (const field of template.fields) {
    const slot = readField(buf, o, field);
    if (!slot) return null; // truncated record — the set is unusable from here
    const { start, length } = slot;
    o += slot.consumed;
    // Enterprise-specific fields have no portable meaning; skipping by length
    // keeps the rest of the record decodable.
    if (field.enterprise !== undefined) continue;

    switch (field.id) {
      case IE.IN_BYTES:
      case IE.OCTET_DELTA_COUNT:
        record.bytes = uint(buf, start, length);
        break;
      case IE.IN_PKTS:
      case IE.PACKET_DELTA_COUNT:
        record.packets = uint(buf, start, length);
        break;
      case IE.PROTOCOL:
        record.protocol = uint(buf, start, length);
        break;
      case IE.TOS:
        record.tos = uint(buf, start, length);
        break;
      case IE.TCP_FLAGS:
        record.tcpFlags = uint(buf, start, length);
        break;
      case IE.L4_SRC_PORT:
        record.srcPort = uint(buf, start, length);
        break;
      case IE.L4_DST_PORT:
        record.dstPort = uint(buf, start, length);
        break;
      case IE.IPV4_SRC_ADDR:
        if (length >= 4) record.src = ipv4(buf, start);
        break;
      case IE.IPV4_DST_ADDR:
        if (length >= 4) record.dst = ipv4(buf, start);
        break;
      case IE.IPV6_SRC_ADDR:
        if (length >= 16) record.src = ipv6(buf, start);
        break;
      case IE.IPV6_DST_ADDR:
        if (length >= 16) record.dst = ipv6(buf, start);
        break;
      case IE.INPUT_SNMP:
        record.inputIf = uint(buf, start, length);
        break;
      case IE.OUTPUT_SNMP:
        record.outputIf = uint(buf, start, length);
        break;
      case IE.FIRST_SWITCHED:
        relativeStart = uint(buf, start, length);
        break;
      case IE.LAST_SWITCHED:
        relativeEnd = uint(buf, start, length);
        break;
      case IE.FLOW_START_MS:
        record.start = uint(buf, start, length);
        break;
      case IE.FLOW_END_MS:
        record.end = uint(buf, start, length);
        break;
      default:
        // Unknown information element: skipped by its declared length. This is
        // the common case for vendor/rarely-used fields and must never be fatal.
        break;
    }
  }

  // Relative (sysUpTime-based) timestamps need the header to become wall clock;
  // IPFIX absolute milliseconds are already there.
  if (record.start === 0 && relativeStart !== undefined) record.start = bootTime + relativeStart;
  if (record.end === 0 && relativeEnd !== undefined) record.end = bootTime + relativeEnd;
  if (record.start === 0) record.start = ctx.unixSecs > 0 ? ctx.unixSecs * 1000 : ctx.receivedAt;
  if (record.end === 0) record.end = record.start;
  // An exporter with an unset clock would otherwise date every flow to 1970.
  if (ctx.unixSecs === 0 && ctx.version === 9) {
    if (warnings.length === 0 || !warnings.includes(CLOCK_WARNING)) warnings.push(CLOCK_WARNING);
    record.start = ctx.receivedAt;
    record.end = ctx.receivedAt;
  }

  return { record, consumed: o - offset };
}

/** Decode every record in a data set body. */
function decodeDataSet(
  body: Uint8Array,
  template: Template,
  ctx: PacketContext,
  warnings: string[],
): FlowRecord[] {
  const records: FlowRecord[] = [];
  let o = 0;
  // Padding: a set is 4-byte aligned, so a tail shorter than one record is not
  // an error. With variable-length templates the minimum is one field.
  const minimum = template.recordLength ?? 1;
  while (o + minimum <= body.length) {
    const decoded = decodeRecord(body, o, template, ctx, warnings);
    if (!decoded || decoded.consumed === 0) break;
    records.push(decoded.record);
    o += decoded.consumed;
  }
  return records;
}

// ── v9 / IPFIX ──────────────────────────────────────────────────────────────

function decodeTemplated(
  buf: Uint8Array,
  registry: TemplateRegistry,
  receivedAt: number,
  version: 9 | 10,
): DecodeResult {
  const warnings: string[] = [];
  const records: FlowRecord[] = [];
  let templatesLearned = 0;
  let buffered = 0;

  let ctx: PacketContext;
  let offset: number;
  if (version === 9) {
    ctx = {
      version: 9,
      sysUpTime: u32(buf, 4),
      unixSecs: u32(buf, 8),
      sourceId: u32(buf, 16),
      receivedAt,
    };
    offset = V9_HEADER;
  } else {
    // IPFIX has no sysUpTime — its timestamps are absolute — and the observation
    // domain plays the role of v9's source id.
    ctx = {
      version: 10,
      sysUpTime: 0,
      unixSecs: u32(buf, 4),
      sourceId: u32(buf, 12),
      receivedAt,
    };
    const declared = u16(buf, 2);
    if (declared > buf.length) {
      warnings.push(`IPFIX length ${declared} exceeds the ${buf.length}-byte datagram`);
    }
    offset = IPFIX_HEADER;
  }

  const templateSetId = version === 9 ? 0 : 2;
  const optionsSetId = version === 9 ? 1 : 3;

  while (offset + 4 <= buf.length) {
    const setId = u16(buf, offset);
    const setLength = u16(buf, offset + 2);
    if (setLength < 4) {
      warnings.push(`set ${setId} declares an impossible length ${setLength}`);
      break;
    }
    const end = offset + setLength;
    if (end > buf.length) {
      warnings.push(`set ${setId} runs past the end of the packet (truncated)`);
      break;
    }
    const body = buf.subarray(offset + 4, end);

    if (setId === templateSetId) {
      const parsed = parseTemplateSet(body, ctx.sourceId, version, receivedAt);
      if (!parsed) {
        warnings.push("malformed template set");
      } else {
        for (const template of parsed) {
          registry.learn(template);
          templatesLearned++;
          // Replay anything that arrived before this template — the whole point
          // of buffering. Their own header context is used, not this packet's.
          for (const held of registry.drain(template.sourceId, template.templateId)) {
            records.push(...decodeDataSet(held.payload, template, held.ctx, warnings));
          }
        }
      }
    } else if (setId === optionsSetId) {
      // Options templates describe exporter metadata (sampling, counters), not
      // flows. Skipping them is correct, not a gap.
    } else if (setId >= 256) {
      const template = registry.get(ctx.sourceId, setId);
      if (template) {
        records.push(...decodeDataSet(body, template, ctx, warnings));
      } else {
        // Copy: `buf` is the receive buffer and may be reused by the caller.
        registry.hold({
          sourceId: ctx.sourceId,
          templateId: setId,
          payload: new Uint8Array(body),
          ctx,
        });
        buffered++;
      }
    } else {
      warnings.push(`reserved set id ${setId} skipped`);
    }

    offset = end;
  }

  return { records, templatesLearned, buffered, warnings };
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Decode one exported datagram. Never throws: a packet that cannot be parsed
 * comes back with `error` set and no records, because a collector that dies on
 * malformed input is a collector that anyone can stop by sending it junk.
 *
 * `registry` carries template state across packets and MUST be the same instance
 * for the life of a collector — that is what makes data-before-template work.
 */
export function decodeFlowPacket(
  buf: Uint8Array,
  registry: TemplateRegistry,
  receivedAt: number = Date.now(),
): DecodeResult {
  const empty = { records: [], templatesLearned: 0, buffered: 0, warnings: [] };
  if (buf.length < 4) return { ...empty, error: "datagram too short to carry a flow header" };

  const version = u16(buf, 0);
  switch (version) {
    case 5:
      if (buf.length < V5_HEADER) return { ...empty, error: "truncated NetFlow v5 header" };
      return decodeV5(buf, receivedAt);
    case 9:
      if (buf.length < V9_HEADER) return { ...empty, error: "truncated NetFlow v9 header" };
      return decodeTemplated(buf, registry, receivedAt, 9);
    case 10:
      if (buf.length < IPFIX_HEADER) return { ...empty, error: "truncated IPFIX header" };
      return decodeTemplated(buf, registry, receivedAt, 10);
    case 1:
      return {
        ...empty,
        error: "NetFlow v1 is not supported — configure the target for version=9 or ipfix",
      };
    default:
      return { ...empty, error: `unknown flow export version ${version}` };
  }
}
