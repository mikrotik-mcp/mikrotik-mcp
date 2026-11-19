/** sign_certificate: a self-sign that RouterOS refuses is explained by its real cause. */
import { beforeEach, expect, test, vi } from "vite-plus/test";
import { certificateTools } from "../src/tools/certificate";

const execute = vi.hoisted(() => vi.fn());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: execute }));

const ctx = { device: "lab", info: vi.fn(), error: vi.fn() };
const sign = (args: Record<string, unknown>) =>
  certificateTools
    .find((tool) => tool.name === "sign_certificate")!
    .handler(args as never, ctx as never);

// The exact answer of RouterOS 7.25.1 to `/certificate sign <server template>` with no ca.
const CA_NOT_FOUND = "failure: CA not found (/certificate/sign; line 1)";

beforeEach(() => execute.mockReset());

test("a self-sign refused for a template without key-cert-sign says so, and how to go on", async () => {
  execute
    .mockResolvedValueOnce("1")
    .mockResolvedValueOnce(CA_NOT_FOUND)
    .mockResolvedValueOnce(
      '0 name="sstp" common-name="192.0.2.1" key-usage=digital-signature,key-encipherment,tls-server days-valid=3650',
    );
  const out = String(await sign({ name: "sstp" }));
  expect(execute.mock.calls[1]![0]).toBe("/certificate sign sstp");
  expect(out).toContain("RouterOS cannot self-sign 'sstp'");
  expect(out).toContain("digital-signature,key-encipherment,tls-server");
  expect(out).toContain("key-cert-sign");
  expect(out).toContain(CA_NOT_FOUND);
  // The old hint sent the caller to look for the template on another router.
  expect(out).not.toContain("different device");
});

test("the same device message for a template that may sign is passed on unchanged", async () => {
  execute
    .mockResolvedValueOnce("1")
    .mockResolvedValueOnce(CA_NOT_FOUND)
    .mockResolvedValueOnce('0 name="ca" key-usage=key-cert-sign,crl-sign');
  expect(await sign({ name: "ca" })).toBe(`Failed to sign certificate: ${CA_NOT_FOUND}`);
});

test("a CA template is self-signed, and a server template is signed with a CA", async () => {
  execute.mockResolvedValueOnce("1").mockResolvedValueOnce("progress: done");
  expect(String(await sign({ name: "ca" }))).toContain("(self-signed)");

  execute
    .mockResolvedValueOnce("1")
    .mockResolvedValueOnce("1")
    .mockResolvedValueOnce("progress: done");
  expect(String(await sign({ name: "sstp", ca: "ca" }))).toContain("with CA 'ca'");
  expect(execute.mock.calls.at(-1)![0]).toBe("/certificate sign sstp ca=ca");
});
