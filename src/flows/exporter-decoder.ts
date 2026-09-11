/** Template IDs are local to an exporter AND wire version, not globally unique. */
import { decodeFlowPacket } from "./decode";
import type { DecodeResult } from "./decode";
import { TemplateRegistry } from "./templates";

export class ExporterFlowDecoder {
  private registries = new Map<string, TemplateRegistry>();
  decode(packet: Uint8Array, exporter: string, now: number): DecodeResult {
    const version = ((packet[0] ?? 0) << 8) | (packet[1] ?? 0);
    const key = `${exporter}/${version}`;
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
    return decodeFlowPacket(packet, registry, now);
  }
  clear(): void {
    this.registries.clear();
  }
  stats(): { templates: number; templatesPending: number; templatesDropped: number } {
    return [...this.registries.values()].reduce(
      (sum, r) => ({
        templates: sum.templates + r.size,
        templatesPending: sum.templatesPending + r.pendingCount,
        templatesDropped: sum.templatesDropped + r.droppedCount,
      }),
      { templates: 0, templatesPending: 0, templatesDropped: 0 },
    );
  }
}
