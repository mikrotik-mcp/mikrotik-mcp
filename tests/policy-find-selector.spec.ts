/** An export selects built-in items with `[ find … ]`; that query is not a name. */
import { expect, test } from "vite-plus/test";
import { analyzeDevice } from "../src/narrative/analyze";
import { topologyMermaid } from "../src/narrative/mermaid";
import { parseExport, recordsOf } from "../src/policy/parse";

const EXPORT = `/interface ethernet
set [ find default-name=ether1 ] comment=uplink name=ether1-wan
set [ find default-name=ether2 ] disabled=yes
/ip service
set telnet disabled=yes
/ip address
add address=10.70.62.1/30 interface=*26 network=10.70.62.0
`;

test("a find query names the item by its default name, and leaves no flags", () => {
  const model = parseExport(EXPORT);
  const [renamed, plain] = recordsOf(model, "/interface/ethernet");
  expect(renamed!.fields).toEqual({
    "default-name": "ether1",
    comment: "uplink",
    name: "ether1-wan",
  });
  expect(plain!.fields).toEqual({ name: "ether2", "default-name": "ether2", disabled: "yes" });
  expect(plain!.flags).toEqual([]);
  // The plain positional selector still works.
  expect(recordsOf(model, "/ip/service")[0]!.fields.name).toBe("telnet");
});

test("the narrative has no interface named '[' and says what '*26' is", () => {
  const narrative = analyzeDevice(EXPORT);
  const names = narrative.interfaces.map((i) => i.name);
  expect(names).toEqual(["*26", "ether1-wan", "ether2"]);
  expect(narrative.interfaces[0]!.purpose).toContain("removed interface");
  expect(topologyMermaid(narrative)).toContain("*26 (removed interface)");
});

test("the document writes a removed interface's id as code, not as emphasis", async () => {
  const { renderNarrative } = await import("../src/narrative/render");
  expect(renderNarrative(analyzeDevice(EXPORT))).toContain("| `*26` |");
});
