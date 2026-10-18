/** Template IDs are local to an exporter AND wire version, not globally unique. */
import { decodeFlowPacket } from "./decode";
import type { DecodeResult } from "./decode";
import { TemplateRegistry } from "./templates";

export interface ExporterHealth {
  exporter: string;
  version: number;
  domain: number;
  packets: number;
  records: number;
  errors: number;
  lastSeen: number;
  sequenceGaps: number;
  reordered: number;
  templateChanges: number;
  pending: number;
  stale: boolean;
}

export class ExporterFlowDecoder {
  private registries = new Map<string, TemplateRegistry>();
  private health = new Map<string, ExporterHealth>();
  private sequences = new Map<string, number>();
  decode(packet: Uint8Array, exporter: string, now: number): DecodeResult {
    const version = ((packet[0] ?? 0) << 8) | (packet[1] ?? 0);
    const headerSize = version === 5 ? 24 : version === 9 ? 20 : version === 10 ? 16 : 0;
    // Invalid senders must not consume the bounded exporter namespace.
    if (!headerSize || packet.length < headerSize)
      return decodeFlowPacket(packet, new TemplateRegistry(), now);
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    const domain =
      version === 9 ? view.getUint32(16) : version === 10 ? view.getUint32(12) : view.getUint16(20);
    const key = `${exporter}/${version}/${domain}`;
    let registry = this.registries.get(key);
    if (!registry) {
      if (this.registries.size >= 128)
        return {
          records: [],
          templatesLearned: 0,
          buffered: 0,
          warnings: [],
          error: "Exporter namespace limit reached",
        };
      registry = new TemplateRegistry();
      this.registries.set(key, registry);
    }
    const result = decodeFlowPacket(packet, registry, now);
    const state = this.health.get(key) ?? {
      exporter,
      version,
      domain,
      packets: 0,
      records: 0,
      errors: 0,
      lastSeen: now,
      sequenceGaps: 0,
      reordered: 0,
      templateChanges: 0,
      pending: 0,
      stale: false,
    };
    state.packets++;
    state.records += result.records.length;
    state.errors += result.error ? 1 : 0;
    state.lastSeen = now;
    state.templateChanges = registry.changedCount;
    state.pending = registry.pendingCount;
    // v9 counts datagrams; IPFIX counts data records (including options records).
    // Do not infer IPFIX loss from decoded flows, which exclude options and pending sets.
    if (version === 9 && !result.error) {
      const sequence = view.getUint32(12);
      const previous = this.sequences.get(key);
      const delta = previous === undefined ? 1 : (sequence - previous) >>> 0;
      if (delta === 0 || delta >= 0x80000000) state.reordered++;
      else {
        state.sequenceGaps += delta - 1;
        this.sequences.set(key, sequence);
      }
    }
    this.health.set(key, state);
    return result;
  }
  clear(): void {
    this.registries.clear();
    this.health.clear();
    this.sequences.clear();
  }
  stats(now = Date.now()) {
    const totals = [...this.registries.values()].reduce(
      (sum, r) => ({
        templates: sum.templates + r.size,
        templatesPending: sum.templatesPending + r.pendingCount,
        templatesDropped: sum.templatesDropped + r.droppedCount,
      }),
      { templates: 0, templatesPending: 0, templatesDropped: 0 },
    );
    return {
      ...totals,
      exporterHealth: [...this.health.values()].map((state) => ({
        ...state,
        stale: now - state.lastSeen > 300_000,
      })),
    };
  }
}
