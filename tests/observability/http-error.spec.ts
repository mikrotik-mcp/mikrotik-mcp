import { describe, expect, test } from "vite-plus/test";
import { clientError, logError, sanitizeMessage } from "../../src/observability/http-error";

// A stand-in home directory, so these assertions don't depend on the machine
// running them (and the test file needs no node:os import).
const HOME = "/Users/tester";
const sanitize = (raw: string, fallback = "unknown error"): string =>
  sanitizeMessage(raw, HOME, fallback);

describe("sanitizeMessage", () => {
  test("keeps the first line and drops appended stack frames", () => {
    expect(sanitize("boom\n    at handler (/app/src/x.ts:12:3)\n    at run (/app/y.ts:4:1)")).toBe(
      "boom",
    );
  });

  test("masks the home directory so the OS account name isn't exposed", () => {
    const raw = `ENOENT: no such file, open '${HOME}/.mikrotik-mcp/events.db'`;
    expect(sanitize(raw)).toBe("ENOENT: no such file, open '~/.mikrotik-mcp/events.db'");
    expect(sanitize(raw).includes(HOME)).toBe(false);
  });

  test("caps the length so device/S3 output can't be dumped to the client", () => {
    expect(sanitize("x".repeat(5000)).length).toBe(301); // 300 + ellipsis
  });

  test("falls back when the message is empty or whitespace", () => {
    expect(sanitize("   ")).toBe("unknown error");
    expect(sanitize("", "fetch failed")).toBe("fetch failed");
  });
});

describe("clientError / logError", () => {
  test("clientError sanitises a thrown Error and stringifies anything else", () => {
    expect(clientError(new Error("boom\n    at x (/a/b.ts:1:1)"))).toBe("boom");
    expect(clientError(undefined)).toBe("undefined");
  });

  test("logError keeps the full stack for stderr", () => {
    expect(logError(new Error("boom")).startsWith("Error: boom")).toBe(true);
    expect(logError("plain string")).toBe("plain string");
  });
});
