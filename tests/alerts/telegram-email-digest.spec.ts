/// <reference types="bun" />
/** The Telegram and email alert channels, and the daily digest. No real network. */
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { deliver, redactChannels, setDeliverySleep } from "../../src/alerts/channels";
import type { AlertNotification } from "../../src/alerts/channels";
import { buildDigest, digestDue, resetDigest, runDigest } from "../../src/alerts/digest";
import { buildMessage, recipients, sendMail } from "../../src/alerts/smtp";
import type { AlertRecord } from "../../src/alerts/store";

const alert: AlertNotification = {
  ruleId: "wan-down",
  severity: "high",
  kind: "fire",
  title: "WAN down",
  body: "ether1 lost its link",
  device: "edge",
  at: 1_700_000_000_000,
};

afterEach(() => {
  vi.unstubAllGlobals();
  setDeliverySleep();
  resetDigest();
});

test("telegram posts plain text to the bot API and never leaks the token", async () => {
  const fetchMock = vi.fn(async () => new Response("ok"));
  vi.stubGlobal("fetch", fetchMock);
  const cfg = { telegram: { token: "123:SECRET", chatId: "-100200" } };
  expect((await deliver("telegram", cfg, alert)).ok).toBe(true);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://api.telegram.org/bot123:SECRET/sendMessage");
  const body = JSON.parse(String(init.body)) as Record<string, unknown>;
  expect(body.chat_id).toBe("-100200");
  expect(body.text).toContain("ether1 lost its link");
  expect(body.parse_mode).toBeUndefined();

  // A failure that echoes the URL must not carry the token to history or logs.
  setDeliverySleep(async () => {});
  vi.stubGlobal("fetch", async () => {
    throw new Error("connect failed https://api.telegram.org/bot123:SECRET/sendMessage");
  });
  const failed = await deliver("telegram", cfg, alert);
  expect(failed.ok).toBe(false);
  expect(failed.error).not.toContain("SECRET");
  expect(JSON.stringify(redactChannels(cfg))).not.toContain("SECRET");
  expect((await deliver("telegram", {}, alert)).error).toContain("not configured");
});

/** A mail server for one message: no TLS, records what the client sent. */
async function mailServer(
  offerAuthOnly = false,
): Promise<{ port: number; seen: string[]; close: () => void }> {
  const seen: string[] = [];
  const server = createServer((socket) => {
    let inData = false;
    // The client closes hard after QUIT; that is not a test failure.
    socket.on("error", () => {});
    socket.write("220 test ESMTP\r\n");
    socket.on("data", (chunk) => {
      const text = chunk.toString();
      seen.push(text);
      if (inData) {
        if (text.endsWith("\r\n.\r\n")) {
          inData = false;
          socket.write("250 queued\r\n");
        }
        return;
      }
      if (text.startsWith("EHLO"))
        socket.write(offerAuthOnly ? "250-test\r\n250 AUTH PLAIN\r\n" : "250 test\r\n");
      else if (text.startsWith("DATA")) {
        inData = true;
        socket.write("354 go\r\n");
      } else if (text.startsWith("QUIT")) socket.end("221 bye\r\n");
      else if (text.startsWith("RCPT TO:<blocked@")) socket.write("550 no such user\r\n");
      else socket.write("250 ok\r\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, seen, close: () => server.close() };
}

test("email sends one message over SMTP", async () => {
  const server = await mailServer();
  try {
    const result = await deliver(
      "email",
      {
        email: {
          host: "127.0.0.1",
          port: server.port,
          from: "mcp@example.net",
          to: "a@example.net, b@example.net",
        },
      },
      { ...alert, title: "WAN down\r\nBcc: evil@example.net", body: "line one\n.hidden" },
    );
    expect(result).toMatchObject({ ok: true, attempts: 1 });
    const sent = server.seen.join("");
    expect(sent).toContain("MAIL FROM:<mcp@example.net>");
    expect(sent).toContain("RCPT TO:<a@example.net>");
    expect(sent).toContain("RCPT TO:<b@example.net>");
    // The title cannot add a header, and a leading dot is stuffed.
    expect(sent).not.toMatch(/^Bcc:/m);
    expect(sent).toContain("\r\n..hidden");
  } finally {
    server.close();
  }
});

test("email reports a refused recipient and never sends a password in clear text", async () => {
  const server = await mailServer(true);
  try {
    const base = { host: "127.0.0.1", port: server.port, from: "mcp@example.net" };
    const refused = await deliver(
      "email",
      { email: { ...base, to: "blocked@example.net" } },
      alert,
    );
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("a recipient");

    server.seen.length = 0;
    await expect(
      sendMail({ ...base, to: "a@example.net", username: "u", password: "hunter2" }, "s", "t"),
    ).rejects.toThrow(/no TLS/);
    expect(server.seen.join("")).not.toContain("AUTH");
    expect(
      JSON.stringify(
        redactChannels({ email: { ...base, to: "a@example.net", password: "hunter2" } }),
      ),
    ).not.toContain("hunter2");
  } finally {
    server.close();
  }
});

test("addresses and messages are checked before anything is sent", () => {
  expect(recipients("a@example.net , b@example.net")).toEqual(["a@example.net", "b@example.net"]);
  expect(() => recipients("a@example.net>\r\nRCPT TO:<x@y.z")).toThrow(/not an email address/);
  expect(() => recipients(" ")).toThrow(/no recipient/);
  const message = buildMessage("mcp@example.net", ["a@example.net"], "héllo\nX: 1", "body");
  expect(message.split("\r\n\r\n")[0]).not.toContain("X: 1");
});

const record = (over: Partial<AlertRecord>): AlertRecord => ({
  id: "1",
  ruleId: "wan-down",
  kind: "fire",
  severity: "high",
  title: "WAN down",
  body: "",
  ts: 0,
  deliveries: [{ channel: "slack", ok: true, attempts: 1 }],
  ...over,
});

test("the digest sums up a day and is sent once, at its hour", async () => {
  const digest = buildDigest(
    [
      record({ device: "edge" }),
      record({ device: "core" }),
      record({ kind: "resolve" }),
      record({
        ruleId: "cpu",
        title: "CPU high",
        severity: "critical",
        deliveries: [{ channel: "slack", ok: false, attempts: 3 }],
      }),
    ],
    5,
  );
  expect(digest.title).toBe("Daily digest: 3 alert(s) from 2 rule(s)");
  expect(digest.severity).toBe("critical");
  expect(digest.body).toContain("2× WAN down (edge, core)");
  expect(digest.body).toContain("1 alert(s) had a delivery that failed.");
  expect(buildDigest([], 5).title).toContain("no alerts");

  const at = (hour: number, dayOfMonth = 10): number =>
    new Date(2026, 0, dayOfMonth, hour, 30).getTime();
  expect(digestDue(undefined, at(7), 8)).toBe(false);
  expect(digestDue(undefined, at(8), 8)).toBe(true);
  expect(digestDue(at(8), at(20), 8)).toBe(false);
  expect(digestDue(at(8), at(9, 11), 8)).toBe(true);

  const send = vi.fn();
  const history = vi.fn(async () => [record({}), record({ ruleId: "daily-digest" })]);
  const cfg = { enabled: true, hour: 8, channels: ["telegram" as const] };
  expect(await runDigest(cfg, at(9), history, send)).toBe(true);
  expect(await runDigest(cfg, at(10), history, send)).toBe(false);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]![1].title).toBe("Daily digest: 1 alert(s) from 1 rule(s)");
  expect(
    await runDigest({ enabled: false, channels: ["telegram"] }, at(9, 12), history, send),
  ).toBe(false);
});
