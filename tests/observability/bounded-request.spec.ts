import { describe, expect, test } from "vite-plus/test";
import { readOperationBody } from "../../src/observability/bounded-request";

describe("bounded operation bodies", () => {
  test("allows same-origin JSON", async () => {
    const req = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { origin: "http://localhost" },
      body: '{"ok":true}',
    });
    expect(await readOperationBody(req)).toBe('{"ok":true}');
  });
  test("rejects cross-origin requests", async () => {
    const req = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { origin: "https://attacker.example" },
      body: "{}",
    });
    await expect(readOperationBody(req)).rejects.toMatchObject({ status: 403 });
  });
  test("limits bytes rather than JavaScript characters without relying on content-length", async () => {
    const req = new Request("http://localhost/api/test", {
      method: "POST",
      body: "آ".repeat(5000),
    });
    await expect(readOperationBody(req)).rejects.toMatchObject({ status: 413 });
  });
});
