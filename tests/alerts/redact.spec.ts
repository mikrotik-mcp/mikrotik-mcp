/**
 * A webhook URL must never appear in any output path.
 *
 * For Slack, Discord and ntfy the secret *is* the URL path — anyone who reads it
 * off a screenshot, a log line or an API response can post as you. It is a live
 * write primitive, not merely an identifier.
 */
import { describe, expect, test } from "vite-plus/test";
import { maskUrl, redactChannels } from "../../src/alerts/channels";
import type { ChannelConfig } from "../../src/alerts/channels";
import { redact } from "../../src/observability/event";

const SLACK = "https://hooks.slack.com/services/T00000000/B00000000/abcdefghijklmnopqrst";
const SECRET_PATH = "abcdefghijklmnopqrst";

describe("maskUrl", () => {
  test("keeps scheme and host, drops the authenticating path", () => {
    expect(maskUrl(SLACK)).toBe("https://hooks.slack.com/…");
    expect(maskUrl(SLACK)).not.toContain(SECRET_PATH);
  });

  test("keeps a non-default port, since that identifies the endpoint", () => {
    expect(maskUrl("https://ntfy.example.com:8443/mytopic")).toBe(
      "https://ntfy.example.com:8443/…",
    );
  });

  test("query strings are dropped — tokens hide there too", () => {
    expect(maskUrl("https://example.com/hook?token=supersecret")).not.toContain("supersecret");
  });

  test("an unparseable value reveals nothing rather than guessing", () => {
    expect(maskUrl("not a url at all")).toBe("«redacted»");
    expect(maskUrl("")).toBe("«redacted»");
  });
});

describe("redactChannels", () => {
  const cfg: ChannelConfig = {
    slack: { url: SLACK },
    ntfy: { url: "https://ntfy.sh/mytopic", token: "tk_live_secret" },
    webhook: { url: "https://example.com/hook/secret-path", method: "PUT" },
  };

  test("no channel URL survives in the redacted output", () => {
    const json = JSON.stringify(redactChannels(cfg));
    expect(json).not.toContain(SECRET_PATH);
    expect(json).not.toContain("mytopic");
    expect(json).not.toContain("secret-path");
  });

  test("no token survives", () => {
    expect(JSON.stringify(redactChannels(cfg))).not.toContain("tk_live_secret");
  });

  test("enough survives to be useful — which channel, which host, which method", () => {
    const out = redactChannels(cfg) as Record<string, { url?: string; method?: string }>;
    expect(out.slack.url).toBe("https://hooks.slack.com/…");
    expect(out.webhook.method).toBe("PUT");
    expect(Object.keys(out).sort()).toEqual(["ntfy", "slack", "webhook"]);
  });

  test("an absent config redacts to nothing rather than throwing", () => {
    expect(redactChannels(undefined)).toEqual({});
  });
});

describe("why the generic redact() is not enough on its own", () => {
  test("the observability redactor does NOT mask a webhook url", () => {
    // Documents the gap that `redactChannels` exists to close: SENSITIVE_KEY has
    // no `url`/`webhook` term, and widening it would redact the many legitimate
    // non-secret URLs elsewhere in the config. If this test ever starts failing
    // because `redact()` grew a url rule, re-check that it did not also start
    // masking device or release URLs.
    const out = redact({ slack: { url: SLACK } }) as { slack: { url: string } };
    expect(out.slack.url).toBe(SLACK);
  });

  test("but it DOES mask a token key, so both layers are needed", () => {
    const out = redact({ ntfy: { token: "tk_live_secret" } }) as { ntfy: { token: string } };
    expect(out.ntfy.token).not.toContain("tk_live_secret");
  });
});
