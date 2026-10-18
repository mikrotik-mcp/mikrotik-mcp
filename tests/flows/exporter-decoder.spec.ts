import { expect, test } from "vite-plus/test";
import { ExporterFlowDecoder } from "../../src/flows/exporter-decoder";

function packet(template: boolean): Uint8Array {
  const out = new Uint8Array(template ? 32 : 28);
  const view = new DataView(out.buffer);
  view.setUint16(0, 9);
  view.setUint16(2, 1);
  view.setUint32(8, 1000);
  view.setUint16(20, template ? 0 : 256);
  view.setUint16(22, template ? 12 : 8);
  if (template) {
    view.setUint16(24, 256);
    view.setUint16(26, 1);
    view.setUint16(28, 8);
    view.setUint16(30, 4);
  } else out.set([192, 0, 2, 10], 24);
  return out;
}
test("different exporters with the same domain/template IDs cannot share templates or queued data", () => {
  const decoder = new ExporterFlowDecoder();
  expect(decoder.decode(packet(true), "192.0.2.1", 1000).templatesLearned).toBe(1);
  expect(decoder.decode(packet(false), "192.0.2.2", 1001).buffered).toBe(1);
  expect(decoder.decode(packet(false), "192.0.2.1", 1002).buffered).toBe(0);
  expect(decoder.stats().templatesPending).toBe(1);
  decoder.decode(packet(true), "192.0.2.2", 1003);
  expect(decoder.stats().templatesPending).toBe(0);
  expect(decoder.stats().templates).toBe(2);
  decoder.clear();
  expect(decoder.stats().templates).toBe(0);
});

test("v9 reports sequence gaps, wrap and reordering separately per domain", () => {
  const decoder = new ExporterFlowDecoder();
  const send = (sequence: number, domain = 0) => {
    const p = packet(true);
    const view = new DataView(p.buffer);
    view.setUint32(12, sequence);
    view.setUint32(16, domain);
    decoder.decode(p, "192.0.2.1", 1000);
  };
  send(0xfffffffe);
  send(1);
  send(0);
  send(2);
  send(100, 1);
  const [first, second] = decoder.stats(1001).exporterHealth;
  expect(first.sequenceGaps).toBe(2);
  expect(first.reordered).toBe(1);
  expect(second.sequenceGaps).toBe(0);
  expect(first.stale).toBe(false);
  expect(decoder.stats(301001).exporterHealth[0].stale).toBe(true);
});

test("counts layout changes, not identical template refreshes", () => {
  const decoder = new ExporterFlowDecoder();
  decoder.decode(packet(true), "192.0.2.1", 0);
  decoder.decode(packet(true), "192.0.2.1", 1);
  const changed = packet(true);
  new DataView(changed.buffer).setUint16(28, 12);
  decoder.decode(changed, "192.0.2.1", 2);
  expect(decoder.stats().exporterHealth[0].templateChanges).toBe(1);
  decoder.clear();
  expect(decoder.stats().exporterHealth).toEqual([]);
});

test("invalid datagrams cannot exhaust exporter slots", () => {
  const decoder = new ExporterFlowDecoder();
  for (let i = 0; i < 200; i++) decoder.decode(new Uint8Array([0, 9]), `bad-${i}`, 0);
  expect(decoder.decode(packet(true), "192.0.2.1", 1).error).toBeUndefined();
  expect(decoder.stats().exporterHealth).toHaveLength(1);
});
