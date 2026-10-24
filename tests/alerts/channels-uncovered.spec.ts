import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  deliver,
  discordPayload,
  maskUrl,
  redactChannels,
  setDeliverySleep,
  setMcpAlertSender,
  slackPayload,
  summarize,
} from "../../src/alerts/channels";
import type { AlertNotification } from "../../src/alerts/channels";

const notification: AlertNotification = {
  ruleId: "wan-down",
  severity: "critical",
  kind: "fire",
  title: "WAN down",
  body: "link lost",
  device: "edge",
  at: Date.UTC(2026, 0, 1),
};

afterEach(() => {
  vi.unstubAllGlobals();
  setDeliverySleep();
  setMcpAlertSender();
});

describe("alert channel uncovered behavior", () => {
  test("redacts malformed URLs and tokens while preserving safe method metadata", () => {
    expect(maskUrl("not a URL")).toBe("«redacted»");
    expect(redactChannels(undefined)).toEqual({});
    expect(
      redactChannels({
        webhook: {
          url: "https://example.test/secret",
          method: "PUT",
          headers: { authorization: "secret" },
        },
        ntfy: { url: "https://ntfy.test/topic", token: "secret" },
        mcp: {},
      }),
    ).toEqual({
      webhook: { url: "https://example.test/…", method: "PUT", configured: true },
      ntfy: { url: "https://ntfy.test/…", token: "«redacted»", configured: true },
      mcp: { configured: true },
    });
  });

  test("resolve notifications and oversized bodies render safely", () => {
    const resolved = { ...notification, kind: "resolve" as const, body: "x".repeat(20_000) };
    expect(summarize(resolved)).toContain("RESOLVED");
    expect(JSON.stringify(slackPayload(resolved))).toContain("…");
    expect(
      (discordPayload(resolved) as { embeds: { color: number; description: string }[] }).embeds[0],
    ).toMatchObject({ color: 0x57f287 });
    expect(
      (discordPayload(resolved) as { embeds: { description: string }[] }).embeds[0].description
        .length,
    ).toBe(4096);
  });

  test("ntfy sends bearer auth and webhook honors method and headers", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    expect(
      (
        await deliver(
          "ntfy",
          { ntfy: { url: "https://ntfy.test/topic", token: "secret" } },
          notification,
        )
      ).ok,
    ).toBe(true);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: "Bearer secret" });
    expect(
      (
        await deliver(
          "webhook",
          {
            webhook: {
              url: "https://example.test/hook",
              method: "PUT",
              headers: { "x-key": "abc" },
            },
          },
          notification,
        )
      ).ok,
    ).toBe(true);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "PUT",
      headers: { "x-key": "abc" },
    });
  });

  test("retries transient failures, but stops on client errors", async () => {
    const sleeps: number[] = [];
    setDeliverySleep(async (ms) => {
      sleeps.push(ms);
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("bad", { status: 503 }))
      .mockResolvedValueOnce(new Response("bad", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok"))
      .mockResolvedValueOnce(new Response("bad", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(
      (await deliver("slack", { slack: { url: "https://example.test/hook" } }, notification))
        .attempts,
    ).toBe(3);
    expect(sleeps).toEqual([250, 500]);
    expect(
      await deliver("discord", { discord: { url: "https://example.test/hook" } }, notification),
    ).toMatchObject({ ok: false, status: 401, attempts: 1 });
  });

  test("MCP sender failures become delivery results", async () => {
    expect(await deliver("mcp", {}, notification)).toMatchObject({ ok: false, attempts: 0 });
    setMcpAlertSender(() => {
      throw new Error("client closed");
    });
    expect(await deliver("mcp", {}, notification)).toMatchObject({
      ok: false,
      error: "client closed",
      attempts: 0,
    });
  });
});
