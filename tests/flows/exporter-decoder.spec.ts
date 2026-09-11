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
