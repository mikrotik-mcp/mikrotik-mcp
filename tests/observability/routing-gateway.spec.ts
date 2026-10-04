import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vite-plus/test";
import { RoutingGateway } from "../../ui/observability/routing-gateway";

test.each([
  "45.87.6.145%ether1",
  "fe80::1%bridge",
  "::ffff:192.0.2.1%ether2",
  "10.64.61.2%wg-fiber-nl",
])("separates IP and interface for %s", (value) => {
  const html = renderToStaticMarkup(h(RoutingGateway, { value }));
  const [ip, iface] = value.split("%");
  expect(html).toContain(`<code dir="ltr">${ip}</code>`);
  expect(html).toContain(`Interface: ${iface}`);
  expect(html).toContain(`Gateway ${ip}, interface ${iface}`);
  expect(html).not.toContain("%");
});
test.each([
  "ether1",
  "192.0.2.1",
  "2001:db8::1",
  "Blackhole",
  "No gateway reported",
  "interface%name",
  "10.1.1.1%",
  "10.1.1.1%ether%1",
])("preserves unscoped or unknown values: %s", (value) => {
  expect(renderToStaticMarkup(h(RoutingGateway, { value }))).toBe(`<code>${value}</code>`);
});
test("keeps separate interfaces for multiple gateways without merging them", () => {
  const html = renderToStaticMarkup(
    h(RoutingGateway, { value: "192.0.2.1%ether1,198.51.100.1%ether2" }),
  );
  expect(html.match(/class="routing-gateway__member"/g)).toHaveLength(2);
  expect(html).toContain("Interface: ether1");
  expect(html).toContain("Interface: ether2");
  expect(html).not.toContain("%");
});
test("escapes interface text", () => {
  const html = renderToStaticMarkup(
    h(RoutingGateway, { value: "192.0.2.1%<script>alert(1)</script>" }),
  );
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
});
