/**
 * NetFlow v9 / IPFIX template registry — PURE, no I/O.
 *
 * v9 and IPFIX are template-based: the exporter periodically sends template
 * records describing the field layout, and data records reference a template by
 * id. **A collector that has not yet seen the template cannot decode the data
 * records that reference it** — and RouterOS resends templates only every few
 * minutes, so a collector started mid-stream would otherwise silently discard
 * everything until the next template refresh. That is the single biggest
 * correctness trap in flow collection, so it is handled explicitly here:
 * undecodable data sets are BUFFERED (bounded) and replayed the moment their
 * template arrives.
 *
 * Templates are keyed by `(sourceId, templateId)` — the same template id means
 * different things from different exporters (v9's `sourceId` / IPFIX's
 * observation domain), so a single-key registry would decode one router's flows
 * with another's layout and produce plausible garbage.
 */

/** One field of a template: an information-element id and its wire length. */
export interface TemplateField {
  /** Information Element id (e.g. 8 = IPV4_SRC_ADDR). */
  id: number;
  /** Wire length in bytes; 65535 means IPFIX variable-length. */
  length: number;
  /** IPFIX enterprise number, when the field is vendor-specific. */
  enterprise?: number;
}

export interface Template {
  sourceId: number;
  templateId: number;
  fields: TemplateField[];
  /** Total wire length of one record, or null when any field is variable-length. */
  recordLength: number | null;
  /** When this template was learned (epoch ms), for diagnostics. */
  learnedAt: number;
}

/** Header facts a buffered data set needs in order to be decoded later. */
export interface PacketContext {
  version: 9 | 10;
  sourceId: number;
  /** Exporter uptime in ms at export (v9 only; 0 for IPFIX). */
  sysUpTime: number;
  /** Export wall-clock, epoch seconds. */
  unixSecs: number;
  /** Received wall-clock (epoch ms) — the fallback when the exporter's clock is wrong. */
  receivedAt: number;
}

/** A data set held back until its template shows up. */
export interface PendingSet {
  sourceId: number;
  templateId: number;
  payload: Uint8Array;
  ctx: PacketContext;
}

/**
 * How many undecodable data sets to hold. RouterOS refreshes templates on the
 * order of minutes, so this only has to cover one refresh interval of a busy
 * link; past that, dropping the oldest is the honest behaviour (and it is
 * counted, never silent).
 */
const DEFAULT_MAX_PENDING = 256;

export class TemplateRegistry {
  private readonly templates = new Map<string, Template>();
  private pending: PendingSet[] = [];
  private droppedPending = 0;
  private readonly maxPending: number;

  constructor(maxPending = DEFAULT_MAX_PENDING) {
    this.maxPending = maxPending;
  }

  private static key(sourceId: number, templateId: number): string {
    return `${sourceId}/${templateId}`;
  }

  /**
   * Record a template. A re-sent template REPLACES the old one: exporters do
   * reuse ids with a new layout after a config change, and keeping the stale
   * definition would decode every later record incorrectly.
   */
  learn(template: Template): void {
    this.templates.set(TemplateRegistry.key(template.sourceId, template.templateId), template);
  }

  get(sourceId: number, templateId: number): Template | undefined {
    return this.templates.get(TemplateRegistry.key(sourceId, templateId));
  }

  get size(): number {
    return this.templates.size;
  }

  /** Buffer a data set whose template has not arrived yet. */
  hold(set: PendingSet): void {
    if (this.pending.length >= this.maxPending) {
      this.pending.shift();
      this.droppedPending++;
    }
    this.pending.push(set);
  }

  /**
   * Remove and return every buffered set that the given template can now
   * decode. Called right after `learn()`, so a data-before-template packet is
   * decoded as soon as the template lands rather than being lost.
   */
  drain(sourceId: number, templateId: number): PendingSet[] {
    if (this.pending.length === 0) return [];
    const ready: PendingSet[] = [];
    const rest: PendingSet[] = [];
    for (const set of this.pending) {
      if (set.sourceId === sourceId && set.templateId === templateId) ready.push(set);
      else rest.push(set);
    }
    this.pending = rest;
    return ready;
  }

  /** Sets still waiting for a template — the diagnostic for an empty Flows page. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** Sets discarded because the pending buffer was full. */
  get droppedCount(): number {
    return this.droppedPending;
  }

  /** Every known template, for the collector-health view. */
  list(): Template[] {
    return [...this.templates.values()];
  }

  /** Forget everything (a collector restart, or an exporter that changed layout). */
  clear(): void {
    this.templates.clear();
    this.pending = [];
    this.droppedPending = 0;
  }
}
