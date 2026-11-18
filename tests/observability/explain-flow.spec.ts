/** The Explain document: its Mermaid diagram is parsed and laid out, its Markdown set as a page. */
import { expect, test } from "vite-plus/test";
import { readDoc } from "../../ui/observability/explain-doc";
import { layoutFlow, parseFlow, related } from "../../ui/observability/explain-flow-lib";
import { renderMarkdown } from "../../ui/observability/markdown";

const SOURCE = `graph LR
  router["Home"]
  internet(("Internet"))
  n1_ether1["ether1<br/>192.168.70.0/24"]
  internet ---|"dhcp"| n1_ether1
  n1_ether1 ---|"masquerade"| router
  n2_bridge["bridge<br/>10.10.10.0/24"]
  router --- n2_bridge
  n3_ether2["ether2<br/>disabled"]
  n2_bridge --- n3_ether2
  n4_wg{{"wg-rw<br/>10.78.78.0/24"}}
  router --- n4_wg
  peer1["peer &quot;a&quot;"]
  n4_wg -.-|"wireguard"| peer1`;

test("reads the nodes and edges the server writes", () => {
  const graph = parseFlow(SOURCE);
  expect(graph.nodes.map((n) => n.id)).toEqual([
    "router",
    "internet",
    "n1_ether1",
    "n2_bridge",
    "n3_ether2",
    "n4_wg",
    "peer1",
  ]);
  expect(graph.nodes[2]).toMatchObject({ lines: ["ether1", "192.168.70.0/24"], shape: "box" });
  expect(graph.nodes[4]).toMatchObject({ lines: ["ether2"], disabled: true });
  expect(graph.nodes[6]!.lines).toEqual(['peer "a"']);
  expect(graph.edges[0]).toEqual({
    from: "internet",
    to: "n1_ether1",
    label: "dhcp",
    dashed: false,
  });
  expect(graph.edges.at(-1)).toMatchObject({ dashed: true, label: "wireguard" });
  // A node defined on an edge line, and text that is not a diagram at all.
  expect(parseFlow('graph LR\n  router --- empty["nothing"]').nodes).toHaveLength(2);
  expect(layoutFlow(parseFlow("not a diagram")).nodes).toEqual([]);
});

test("lays the graph out left to right around the router", () => {
  const graph = parseFlow(SOURCE);
  const layout = layoutFlow(graph);
  const at = (id: string) => layout.nodes.find((n) => n.id === id)!;
  const order = ["internet", "n1_ether1", "router", "n2_bridge", "n3_ether2"].map((id) => at(id).x);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(new Set(order).size).toBe(order.length);
  // The way in is level with the router; the router is centred on its interfaces.
  expect(at("internet").y).toBe(at("router").y);
  expect(at("router").y).toBe((at("n2_bridge").y + at("n4_wg").y) / 2);
  expect(layout.nodes.map((n) => n.kind)).toEqual([
    "router",
    "internet",
    "wan",
    "bridge",
    "port",
    "tunnel",
    "peer",
  ]);
  for (const node of layout.nodes) {
    expect(node.x + node.w).toBeLessThanOrEqual(layout.width);
    expect(node.y + node.h / 2).toBeLessThanOrEqual(layout.height);
  }
  expect(Array.from(related(graph, "n2_bridge")).sort()).toEqual(
    ["internet", "n1_ether1", "n2_bridge", "n3_ether2", "router"].sort(),
  );
});

test("document mode joins wrapped lines, nests sub-items and reads _emphasis_", () => {
  const html = renderMarkdown("_Device: `a_b`_\n\nOne\ntwo.\n\n- **Edge** (score 9)\n  - reason", {
    document: true,
  });
  expect(html).toContain("<em>Device: <code>a_b</code></em>");
  expect(html).toContain("<p>One two.</p>");
  expect(html).toContain(
    '<ul><li><strong>Edge</strong> (score 9)</li>\n<li class="md-sub">reason</li></ul>',
  );
  // The release-body mode is unchanged.
  expect(renderMarkdown("One\ntwo.\n_x_")).toBe("<p>One</p>\n<p>two.</p>\n<p>_x_</p>");
});

test("the document is split into sections, with the diagram and severity chips", () => {
  const doc = readDoc(
    `# R\n\n_meta_\n\n## Exposed\n\n| a | b |\n| - | - |\n| <b>x</b> | 🔴 critical |\n\n## Topology\n\nBefore.\n\n\`\`\`mermaid\n${SOURCE}\n\`\`\`\n\nAfter.\n`,
  );
  expect(doc.sections.map((s) => s.title)).toEqual(["Exposed", "Topology"]);
  expect(doc.head).toContain("<h2>R</h2>");
  expect(doc.sections[0]!.parts[0]).toContain(
    '<span class="md-sev" data-sev="critical">critical</span>',
  );
  // Markup in the source stays text.
  expect(doc.sections[0]!.parts[0]).toContain("&lt;b&gt;x&lt;/b&gt;");
  expect(doc.sections[1]!.parts).toHaveLength(2);
  expect(doc.flow).toBe(SOURCE);
});
