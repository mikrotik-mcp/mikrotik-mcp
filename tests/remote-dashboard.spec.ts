/**
 * `mikrotik-mcp dashboard --server <url>`: where a local request is sent on the
 * server, and which headers go with it. Pure helpers — no sockets.
 */
import { describe, expect, it } from "vite-plus/test";
import { serverOrigin, upstreamHeaders, upstreamUrl } from "../src/observability/remote.ts";

describe("remote dashboard", () => {
  it("reduces the server URL to its origin and rejects anything else", () => {
    expect(serverOrigin("http://192.0.2.10:9090")).toBe("http://192.0.2.10:9090");
    expect(serverOrigin("https://user:pw@mcp.example:9443/x?token=abc")).toBe(
      "https://mcp.example:9443",
    );
    expect(() => serverOrigin("192.0.2.10:9090")).toThrow("--server must");
    expect(() => serverOrigin("ftp://192.0.2.10")).toThrow("http or https");
    expect(() => serverOrigin("")).toThrow("--server must be a URL");
  });

  it("keeps path and query, and never lets a request leave the server", () => {
    const origin = "http://192.0.2.10:9090";
    expect(upstreamUrl(origin, "/api/events?limit=5")).toBe(
      "http://192.0.2.10:9090/api/events?limit=5",
    );
    expect(upstreamUrl(origin, "/api/stream?device=a", true)).toBe(
      "ws://192.0.2.10:9090/api/stream?device=a",
    );
    expect(upstreamUrl("https://mcp.example", "/api/stream", true)).toBe(
      "wss://mcp.example/api/stream",
    );
    // A request path is always origin-relative; `//host` must not switch hosts.
    expect(new URL(upstreamUrl(origin, "/%2F%2Fevil.example/x")).host).toBe("192.0.2.10:9090");
  });

  it("sends the server token and drops the client's own credentials and host", () => {
    const incoming = new Headers({
      host: "localhost:9090",
      authorization: "Bearer from-browser",
      "content-type": "application/json",
      "accept-encoding": "gzip",
    });
    const out = upstreamHeaders(incoming, "server-token");
    expect(out.get("authorization")).toBe("Bearer server-token");
    expect(out.get("host")).toBeNull();
    expect(out.get("accept-encoding")).toBeNull();
    expect(out.get("content-type")).toBe("application/json");
    expect(upstreamHeaders(incoming).get("authorization")).toBeNull();
  });
});
