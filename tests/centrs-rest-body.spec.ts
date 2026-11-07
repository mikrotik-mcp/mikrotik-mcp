/// <reference types="node" />
import { Buffer } from "node:buffer";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { createProtocolAdapter } from "@tikoci/centrs/protocols";

afterEach(() => vi.unstubAllGlobals());

test.each([
  undefined,
  { contents: String.fromCharCode(...Array.from({ length: 256 }, (_, i) => i)) },
])(
  "centrs binary REST body preserves every byte in a DOM-compatible buffer",
  async (attributes) => {
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://router.invalid/rest/file/set");
      expect(init.body).toBeInstanceOf(Uint8Array);
      expect(Buffer.isBuffer(init.body)).toBe(false);
      const bytes = new Uint8Array(await new Request(url, init).arrayBuffer());
      expect(bytes).toEqual(
        new Uint8Array(Buffer.from(JSON.stringify(attributes ?? {}), "latin1")),
      );
      return new Response("[]", { headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetcher);
    const adapter = createProtocolAdapter({
      protocol: "rest-api",
      host: "router.invalid",
      port: 443,
      tls: true,
      baseUrl: "https://router.invalid/rest",
      password: "",
      timeoutMs: 1000,
    });
    await expect(
      adapter.execute({ path: "/file", command: "set", binary: true, attributes }),
    ).resolves.toEqual({ records: [] });
    expect(fetcher).toHaveBeenCalledOnce();
  },
);
