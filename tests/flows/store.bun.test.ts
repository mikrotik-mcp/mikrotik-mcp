/// <reference types="bun" />
/** Real SQLite migration smoke test: bun test tests/flows/store.bun.test.ts (offline). */
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFlowStore } from "../../src/flows/store";

test("additive migration preserves old flows and round-trips new interface indexes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mikrotik-flow-migration-"));
  const path = join(directory, "flows.db");
  let store: Awaited<ReturnType<typeof openFlowStore>> | undefined;
  try {
    const old = new Database(path);
    old.run(
      "CREATE TABLE flows (id INTEGER PRIMARY KEY AUTOINCREMENT, start INTEGER NOT NULL, end INTEGER NOT NULL, exporter TEXT, src TEXT NOT NULL, dst TEXT NOT NULL, src_port INTEGER NOT NULL, dst_port INTEGER NOT NULL, protocol INTEGER NOT NULL, bytes INTEGER NOT NULL, packets INTEGER NOT NULL, tcp_flags INTEGER, version INTEGER NOT NULL)",
    );
    old.run(
      "INSERT INTO flows (start,end,exporter,src,dst,src_port,dst_port,protocol,bytes,packets,version) VALUES (1,2,'192.0.2.1','192.0.2.10','203.0.113.1',55000,443,6,60,1,9)",
    );
    old.close();
    store = await openFlowStore(path);
    const legacy = store.query({ from: 0, to: 10 });
    expect(legacy).toHaveLength(1);
    expect(legacy[0].inputIf).toBeUndefined();
    expect(legacy[0].outputIf).toBeUndefined();
    store.insert([{ ...legacy[0], start: 3, end: 4, srcPort: 55001, inputIf: 3, outputIf: 91 }]);
    const query = {
      exporter: "192.0.2.1",
      from: 0,
      to: 10,
      tuple: { src: "192.0.2.10", dst: "203.0.113.1", srcPort: 55001, dstPort: 443, protocol: 6 },
    };
    expect(store.query(query)).toHaveLength(1);
    expect(store.query(query)[0]).toMatchObject({ inputIf: 3, outputIf: 91 });
    expect(store.query({ ...query, exporter: "192.0.2.2" })).toHaveLength(0);
    store.close();
    store = await openFlowStore(path);
    expect(store.query(query)[0].outputIf).toBe(91);
    expect(store.query({ from: 0, to: 10 })).toHaveLength(2);
  } finally {
    store?.close();
    rmSync(directory, { recursive: true });
  }
});
