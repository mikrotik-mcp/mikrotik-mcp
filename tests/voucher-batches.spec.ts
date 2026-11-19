/// <reference types="bun" />
/** Hotspot vouchers: batches, a printable sheet, and clearing the unused ones. */
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import { MikrotikConfigSchema } from "../src/config";
import { getConfig, setConfig } from "../src/core/runtime";
import { loginLink, voucherSheetCsv, voucherSheetHtml } from "../src/core/voucher-sheet";

const command = vi.hoisted(() => vi.fn());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
const { hotspotBuilderTools } = await import("../src/tools/hotspot-builder");
const { resetVoucherIssue, voucherIssueRoute } = await import("../src/observability/voucher-issue");

const ctx = { device: "edge", info() {}, error() {} };
const tool = (name: string) => hotspotBuilderTools.find((t) => t.name === name)!;
const run = async (name: string, args: Record<string, unknown>): Promise<string> =>
  String(
    await (tool(name).handler as (a: unknown, c: unknown) => Promise<unknown>)(
      z.object(tool(name).inputSchema).parse(args),
      ctx,
    ),
  );

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vouchers-"));
  vi.stubEnv("MIKROTIK_VOUCHER_DIR", dir);
  command.mockReset();
  command.mockResolvedValue("");
});
afterEach(() => vi.unstubAllEnvs());

test("the sheet escapes every value, loads nothing, and adds a QR code only for a web address", () => {
  const html = voucherSheetHtml({
    title: '<script>alert(1)</script> "Café"',
    batch: "b1",
    codes: ["g1a2b3", "<img onerror=x>"],
    validity: "1 day",
    price: "5 EUR",
    loginUrl: "http://hotspot.lan/login",
  });
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &quot;Café&quot;");
  expect(html).not.toContain("<img onerror");
  expect(html).toContain("default-src 'none'");
  expect(html.match(/data:image\/png;base64,/g)).toHaveLength(2);
  expect(html).toContain("1 day · 5 EUR");
  expect(loginLink("http://hotspot.lan/login", "a b")).toBe(
    "http://hotspot.lan/login?username=a+b&password=a+b",
  );
  expect(loginLink("javascript:alert(1)", "x")).toBeUndefined();
  expect(voucherSheetHtml({ title: "t", batch: "b", codes: ["x"] })).not.toContain("<img");
});

test("the CSV cannot start a spreadsheet formula", () => {
  expect(
    voucherSheetCsv({ title: "t", batch: "b1", codes: ["=cmd()", 'a"b'], validity: "1d" }),
  ).toBe(
    ["code,batch,validity,price", `"'=cmd()","b1","1d",""`, `"a""b","b1","1d",""`].join("\r\n"),
  );
});

test("vouchers are tagged with their batch, and print writes private files", async () => {
  const dry = await run("generate_hotspot_vouchers", { count: 3 });
  expect(dry).toContain("DRY RUN");
  expect(command).not.toHaveBeenCalled();

  const text = await run("generate_hotspot_vouchers", {
    count: 3,
    batch: "hotel-nov",
    apply: true,
    print: true,
    uptime_limit: "1d",
    login_url: "http://hotspot.lan/login",
  });
  const adds = command.mock.calls.map((c) => String(c[0]));
  expect(adds).toHaveLength(3);
  expect(
    adds.every(
      (c) => c.includes('comment="voucher-batch: hotel-nov"') && c.includes("limit-uptime=1d"),
    ),
  ).toBe(true);
  expect(text).toContain("Created 3 hotspot voucher(s) (1d each) in batch 'hotel-nov'.");
  const html = join(dir, "hotel-nov.html");
  expect(readFileSync(html, "utf8").match(/class="card"/g)).toHaveLength(3);
  expect(statSync(html).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(dir, "hotel-nov.csv"), "utf8").split("\r\n")).toHaveLength(4);
  // A batch name that could leave the folder is refused.
  expect(
    z.object(tool("generate_hotspot_vouchers").inputSchema).safeParse({ batch: "../x" }).success,
  ).toBe(false);
});

const USERS = ` 0 name="g111" comment="voucher-batch: nov" uptime=0s
 1 name="g222" comment="voucher-batch: nov" uptime=2h3m
 2 name="g333" comment="voucher-batch: nov" uptime=0s
 3 name="staff" comment="permanent" uptime=5d`;

test("batches are counted, and only unused vouchers are removed by default", async () => {
  command.mockImplementation(async (cmd?: string) =>
    String(cmd).includes("print detail") ? USERS : "",
  );
  expect(await run("list_voucher_batches", {})).toBe("nov  total=3  used=1  unused=2");

  expect(await run("remove_voucher_batch", { batch: "nov" })).toContain(
    "DRY RUN — would remove 2 of 4 voucher(s)",
  );
});

test("removal names each voucher and its batch, so nothing else can match", async () => {
  const batchRows = USERS.split("\n").slice(0, 3).join("\n");
  command.mockImplementation(async (cmd?: string) =>
    String(cmd).includes("print detail") ? batchRows : "",
  );
  expect(await run("remove_voucher_batch", { batch: "nov", apply: true })).toBe(
    "Removed 2 voucher(s) of batch 'nov'. 1 remain.",
  );
  const removes = command.mock.calls.map((c) => String(c[0])).filter((c) => c.includes("remove"));
  expect(removes).toEqual([
    '/ip hotspot user remove [find name="g111" comment~"^voucher-batch: nov( ref=.*)?\\$"]',
    '/ip hotspot user remove [find name="g333" comment~"^voucher-batch: nov( ref=.*)?\\$"]',
  ]);
  command.mockClear();
  expect(await run("remove_voucher_batch", { batch: "nov", include_used: true })).toContain(
    "would remove 3 of 3",
  );
  command.mockImplementation(async () => "");
  expect(await run("remove_voucher_batch", { batch: "none", apply: true })).toContain(
    "No voucher of batch 'none'",
  );
});

const TOKEN = "billing-system-token-0001";
const issue = (
  init: { token?: string; body?: unknown; method?: string } = {},
): Promise<Response | null> =>
  voucherIssueRoute(
    new Request("http://x/api/vouchers/issue", {
      method: init.method ?? "POST",
      headers: init.token ? { authorization: `Bearer ${init.token}` } : {},
      body: init.method === "GET" ? undefined : JSON.stringify(init.body ?? {}),
    }),
    new URL("http://x/api/vouchers/issue"),
  );

test("the issue route does not exist until it is configured, and needs its own token", async () => {
  const original = getConfig();
  try {
    setConfig(
      MikrotikConfigSchema.parse({
        devices: { edge: { host: "10.0.0.1" } },
        defaultDevice: "edge",
      }),
    );
    expect((await issue({ token: TOKEN }))!.status).toBe(404);
    expect(
      MikrotikConfigSchema.safeParse({ devices: {}, vouchers: { issue: { token: "short" } } })
        .success,
    ).toBe(false);
    expect(MikrotikConfigSchema.safeParse({ devices: {}, vouchers: { issue: {} } }).success).toBe(
      false,
    );

    setConfig(
      MikrotikConfigSchema.parse({
        devices: { edge: { host: "10.0.0.1" } },
        defaultDevice: "edge",
        vouchers: { issue: { token: TOKEN, uptimeLimit: "1d", maxPerMinute: 2 } },
      }),
    );
    resetVoucherIssue();
    expect((await issue())!.status).toBe(401);
    expect((await issue({ token: "wrong-token-000000000" }))!.status).toBe(401);
    expect((await issue({ token: TOKEN, method: "GET" }))!.status).toBe(405);
    expect((await issue({ token: TOKEN, body: { reference: "a b; /system reset" } }))!.status).toBe(
      400,
    );
    expect(command).not.toHaveBeenCalled();

    // A paid reference gets one voucher; the same reference again gets the same one.
    const sold: string[] = [];
    command.mockImplementation(async (cmd?: string) => {
      const text = String(cmd);
      if (text.includes("print detail"))
        return sold.length ? ` 0 name="${sold[0]}" comment="x"` : "";
      const name = text.match(/name=(\S+)/)?.[1];
      if (name) sold.push(name);
      return "";
    });
    const first = await (await issue({ token: TOKEN, body: { reference: "pay_123" } }))!.json();
    expect(first).toMatchObject({
      batch: "sold",
      reference: "pay_123",
      repeated: false,
      validity: "1d",
    });
    expect(first.code).toMatch(/^g[0-9a-f]{8}$/);
    const add = command.mock.calls.map((c) => String(c[0])).find((c) => c.includes("user add"))!;
    expect(add).toContain('limit-uptime=1d comment="voucher-batch: sold ref=pay_123"');
    const again = await (await issue({ token: TOKEN, body: { reference: "pay_123" } }))!.json();
    expect(again).toMatchObject({ code: first.code, repeated: true });
    expect(sold).toHaveLength(1);

    // The limit counts new vouchers, not repeated questions.
    command.mockImplementation(async () => "");
    expect((await issue({ token: TOKEN }))!.status).toBe(200);
    expect((await issue({ token: TOKEN }))!.status).toBe(429);
    // Another path is not this route's business.
    expect(
      await voucherIssueRoute(new Request("http://x/api/other"), new URL("http://x/api/other")),
    ).toBeNull();
  } finally {
    setConfig(original);
    resetVoucherIssue();
  }
});

test("the login limit goes in the chain that runs before the hotspot rules, and is removed by its tag", async () => {
  const { loginLimitRules } = await import("../src/tools/hotspot-builder");
  const rules = loginLimitRules(30, 15, 10);
  expect(rules).toHaveLength(5);
  expect(rules[0]).toBe(
    '/ip firewall filter add chain=pre-hs-input protocol=tcp dst-port=64872-64875 src-address-list=hs-login-flood action=drop comment="hs-login-limit: blocked clients"',
  );
  expect(rules[2]).toContain(
    "chain=hs-login-limit dst-limit=30/1m,15,src-address/1m action=return",
  );
  expect(rules[3]).toContain(
    "action=add-src-to-address-list address-list=hs-login-flood address-list-timeout=10m",
  );

  command.mockImplementation(async (cmd?: string) =>
    String(cmd).includes("count-only") ? "0" : "",
  );
  expect(await run("protect_hotspot_login", {})).toContain("DRY RUN — 5 rule(s)");
  expect(command.mock.calls.some((c) => String(c[0]).includes(" add "))).toBe(false);
  expect(await run("protect_hotspot_login", { apply: true })).toContain(
    "limited to 30 new connections a minute",
  );

  command.mockReset();
  command.mockImplementation(async (cmd?: string) =>
    String(cmd).includes("count-only") ? "5" : "",
  );
  expect(await run("protect_hotspot_login", { apply: true })).toContain("already rate-limited");
  expect(await run("unprotect_hotspot_login", {})).toBe(
    "Removed 5 rule(s) and emptied the block list.",
  );
  expect(command.mock.calls.map((c) => String(c[0])).filter((c) => c.includes("remove"))).toEqual([
    '/ip firewall filter remove [find comment~"^hs-login-limit"]',
    '/ip firewall address-list remove [find list="hs-login-flood"]',
  ]);
});
