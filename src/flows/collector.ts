/**
 * Flow collector — the UDP receiver that feeds the pure decoder.
 *
 * RouterOS exports NetFlow/IPFIX to a collector address:port; this binds that
 * port, hands each datagram to {@link decodeFlowPacket}, and batches the decoded
 * records into the store. One process-wide session, exactly like
 * `src/observability/capture.ts` — and it uses the same `node:dgram` API that
 * module already proves works under the vendored Bun runtime, rather than
 * introducing a second UDP mechanism.
 *
 * Importing this module never binds anything; the socket opens only when
 * `start()` is called, so the test import graph stays inert.
 *
 * Health counters are first-class rather than debug noise: "templates pending"
 * is the number that explains an empty Flows page (data arrived before the
 * template that decodes it), and decode errors distinguish "nothing is being
 * sent" from "something is being sent that we can't read".
 */
import { createSocket } from "node:dgram";
import type { Socket } from "node:dgram";
import { logger } from "../logger";
import { decodeFlowPacket } from "./decode";
import type { FlowRecord } from "./decode";
import { TemplateRegistry } from "./templates";
import type { FlowStore } from "./store";

export const DEFAULT_FLOW_PORT = 2055;

/** Records are written in batches; a busy link exports far faster than one row per insert. */
const FLUSH_INTERVAL_MS = 2000;
const FLUSH_THRESHOLD = 500;
/** How often expired rows are pruned. */
const PRUNE_INTERVAL_MS = 15 * 60_000;

export interface CollectorStats {
  running: boolean;
  port: number;
  startedAt: number | null;
  /** Datagrams received. */
  packets: number;
  /** Flow records decoded. */
  flows: number;
  /** Datagrams that could not be decoded at all. */
  decodeErrors: number;
  /** Most recent decode error, for the health strip. */
  lastError?: string;
  /** Templates learned, and data sets still waiting for one. */
  templates: number;
  templatesPending: number;
  /** Data sets dropped because the pending buffer was full. */
  templatesDropped: number;
  /** Exporter address → datagrams received. */
  exporters: Record<string, number>;
  /** Records buffered in memory, not yet written. */
  queued: number;
}

class FlowCollector {
  private socket: Socket | null = null;
  private port = DEFAULT_FLOW_PORT;
  private startedAt: number | null = null;
  private readonly registry = new TemplateRegistry();
  private store: FlowStore | null = null;
  private queue: FlowRecord[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  private packets = 0;
  private flows = 0;
  private decodeErrors = 0;
  private lastError: string | undefined;
  private exporters = new Map<string, number>();

  get running(): boolean {
    return this.socket !== null;
  }

  /** Bind the collector port and start decoding. Resolves once bound (or on error). */
  start(
    store: FlowStore,
    port = DEFAULT_FLOW_PORT,
  ): Promise<{ ok: boolean; error?: string; port: number }> {
    if (this.socket) return Promise.resolve({ ok: true, port: this.port });
    this.reset();
    this.store = store;
    this.port = port;

    return new Promise((resolve) => {
      const socket = createSocket({ type: "udp4", reuseAddr: true });
      socket.on("error", (e) => {
        // Before bind resolves, an error IS the result (port in use, no perms);
        // after, it means the socket died and the session should stop cleanly.
        if (!this.socket) resolve({ ok: false, error: e.message, port });
        else {
          logger.error(`Flow collector socket error: ${e.message}`);
          this.stop();
        }
      });
      socket.on("message", (msg, rinfo) => this.ingest(new Uint8Array(msg), rinfo.address));
      socket.bind(port, () => {
        this.socket = socket;
        this.startedAt = Date.now();
        this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
        this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
        logger.info(`Flow collector listening on UDP ${port}`);
        resolve({ ok: true, port });
      });
    });
  }

  /** Stop receiving. Flushes what is already decoded — those flows really happened. */
  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.flushTimer = null;
    this.pruneTimer = null;
    this.flush();
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // already closed
      }
      this.socket = null;
    }
    this.startedAt = null;
    logger.info("Flow collector stopped");
  }

  private reset(): void {
    this.registry.clear();
    this.queue = [];
    this.packets = 0;
    this.flows = 0;
    this.decodeErrors = 0;
    this.lastError = undefined;
    this.exporters = new Map();
  }

  private ingest(datagram: Uint8Array, from: string): void {
    this.packets++;
    this.exporters.set(from, (this.exporters.get(from) ?? 0) + 1);

    const result = decodeFlowPacket(datagram, this.registry, Date.now());
    if (result.error) {
      this.decodeErrors++;
      this.lastError = `${from}: ${result.error}`;
      return;
    }
    for (const warning of result.warnings) {
      // Warnings are per-packet and repeat; log at debug volume via info once
      // the counter shows there is something to look at.
      this.lastError = `${from}: ${warning}`;
    }
    for (const record of result.records) {
      record.exporter = from;
      this.queue.push(record);
    }
    this.flows += result.records.length;
    if (this.queue.length >= FLUSH_THRESHOLD) this.flush();
  }

  /** Write queued records. Failure must not kill the collector — flows keep coming. */
  private flush(): void {
    if (this.queue.length === 0 || !this.store) return;
    const batch = this.queue;
    this.queue = [];
    try {
      this.store.insert(batch);
    } catch (e) {
      logger.error(`Flow store insert failed (${batch.length} records dropped): ${String(e)}`);
    }
  }

  private prune(): void {
    if (!this.store) return;
    try {
      const { rawDeleted, rollupDeleted } = this.store.prune(Date.now());
      if (rawDeleted > 0 || rollupDeleted > 0) {
        logger.info(
          `Flow retention: pruned ${rawDeleted} raw flow(s) and ${rollupDeleted} rollup row(s)`,
        );
      }
    } catch (e) {
      logger.error(`Flow prune failed: ${String(e)}`);
    }
  }

  stats(): CollectorStats {
    return {
      running: this.running,
      port: this.port,
      startedAt: this.startedAt,
      packets: this.packets,
      flows: this.flows,
      decodeErrors: this.decodeErrors,
      lastError: this.lastError,
      templates: this.registry.size,
      templatesPending: this.registry.pendingCount,
      templatesDropped: this.registry.droppedCount,
      exporters: Object.fromEntries(this.exporters),
      queued: this.queue.length,
    };
  }

  /** Force a write — used by the read tools so a query sees the newest flows. */
  drain(): void {
    this.flush();
  }
}

// One collector per process: the port can only be bound once, and the dashboard
// and the tools run in the same process (like the capture session).
const collector = new FlowCollector();

export function getFlowCollector(): FlowCollector {
  return collector;
}
