// @vitest-environment happy-dom
import { expect, test } from "vite-plus/test";
import { maskDocumentationScreenshot } from "../docs/scripts/screenshot-privacy.js";

test("documentation captures blur IPs, backup names and complete AAA/VPN usernames", () => {
  document.body.innerHTML = `<main data-view="openvpn">
    <p id="readable">Alice · 12:30:45 · 42 Mbps · IranCell</p>
    <p>1.1.1.1</p><p>2001:db8::1234</p><p>149.154.166…</p>
    <p>2606:4700:4…</p><p>pre-maintenance</p><p>nightly.rsc</p>
    <input placeholder="e.g. 1.1.1.1" />
    <p id="users">ali · &lt;ovpn-ali&gt; · fereshteh · ابراهیم</p>
    <p id="boundary">validity · Alice · alias · alison · alice_user · خابراهیم</p>
  </main>`;
  maskDocumentationScreenshot(["pre-maintenance", "nightly.rsc"], ["ali", "fereshteh", "ابراهیم"]);
  expect(
    [...document.querySelectorAll("[data-doc-private]")].map((node) => node.textContent),
  ).toEqual([
    "1.1.1.1",
    "2001:db8::1234",
    "149.154.166…",
    "2606:4700:4…",
    "pre-maintenance",
    "nightly.rsc",
    "ali",
    "ali",
    "fereshteh",
    "ابراهیم",
  ]);
  expect(document.querySelector("#readable span")).toBeNull();
  expect(document.querySelector("#readable")?.textContent).toBe(
    "Alice · 12:30:45 · 42 Mbps · IranCell",
  );
  expect(document.querySelector("input")?.style.filter).toBe("blur(12px)");
  expect(document.querySelector("#boundary span")).toBeNull();
});
