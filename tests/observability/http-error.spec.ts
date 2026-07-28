import { homedir } from "node:os";
import { describe, expect, test } from "vite-plus/test";
import { clientError, logError } from "../../src/observability/http-error";

describe("clientError", () => {
  test("keeps the first line and drops appended stack frames", () => {
    const e = new Error("boom\n    at handler (/app/src/x.ts:12:3)\n    at run (/app/src/y.ts:4:1)");
    expect(clientError(e)).toBe("boom");
  });

  test("masks the home directory so the OS account name isn't exposed", () => {
    const e = new Error(`ENOENT: no such file, open '${homedir()}/.mikrotik-mcp/events.db'`);
    const msg = clientError(e);
    expect(msg.includes(homedir())).toBe(false);
    expect(msg).toBe("ENOENT: no such file, open '~/.mikrotik-mcp/events.db'");
  });

  test("caps the length so device/S3 output can't be dumped to the client", () => {
    expect(clientError(new Error("x".repeat(5000))).length).toBe(301); // 300 + ellipsis
  });

  test("falls back when the error carries no message", () => {
    const blank = new Error("placeholder");
    blank.message = "   ";
    expect(clientError(blank)).toBe("unknown error");
    expect(clientError(blank, "fetch failed")).toBe("fetch failed");
    expect(clientError(undefined)).toBe("undefined");
  });

  test("logError keeps the full stack for stderr", () => {
    const e = new Error("boom");
    expect(logError(e).startsWith("Error: boom")).toBe(true);
    expect(logError("plain string")).toBe("plain string");
  });
});
