import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import type { ToolContext } from "../src/core/context";
import { dnsResolveCommand } from "../src/core/dns-resolve";
import type { RegisterableTool } from "../src/core/registry";
import { indicatesFailure, quoteValue } from "../src/core/routeros";
import { dnsTools } from "../src/tools/dns";
import { networkToolTools } from "../src/tools/network-tools";

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: run }));

const query = dnsTools.find((tool) => tool.name === "test_dns_query")!;
const resolve = networkToolTools.find((tool) => tool.name === "resolve_dns")!;
const ctx: ToolContext = { device: "home-ax3", info: vi.fn(), error: vi.fn() };

function invoke(tool: RegisterableTool, args: Record<string, unknown>) {
  return tool.handler(z.object(tool.inputSchema!).parse(args), ctx);
}

beforeEach(() => {
  run.mockReset();
  run.mockResolvedValue("203.0.113.10\r\n");
});

describe("test_dns_query", () => {
  test("prints the IPv4 expression by default and retains the answer", async () => {
    expect(await invoke(query, { name: "example.com" })).toBe(
      "DNS QUERY RESULT for example.com:\n\n203.0.113.10\r\n",
    );
    expect(run).toHaveBeenCalledExactlyOnceWith(
      ":put [:resolve domain-name=example.com type=ipv4]",
      ctx,
    );
    expect(query.annotations.readOnlyHint).toBe(true);
  });

  test.each([
    ["A", "ipv4"],
    ["AAAA", "ipv6"],
    ["ANY", "any"],
    ["ANY6", "any6"],
  ])("maps %s to RouterOS %s", async (type, routerType) => {
    run.mockResolvedValue("2001:db8::10");
    expect(await invoke(query, { name: "example.com", server: "2001:db8::53", type })).toContain(
      "2001:db8::10",
    );
    expect(run).toHaveBeenCalledExactlyOnceWith(
      `:put [:resolve domain-name=example.com server=2001:db8::53 type=${routerType}]`,
      ctx,
    );
  });

  test.each(["MX", "TXT", "ipv4", "AAAA; /system reboot", ""])(
    "rejects unsupported type %s before device I/O",
    (type) => {
      expect(() => invoke(query, { name: "example.com", type })).toThrow();
      expect(run).not.toHaveBeenCalled();
    },
  );
});

describe("resolve_dns", () => {
  test("prints the system resolver without forcing an address family", async () => {
    expect(await invoke(resolve, { name: "example.com" })).toContain("203.0.113.10");
    expect(run).toHaveBeenCalledExactlyOnceWith(":put [:resolve domain-name=example.com]", ctx);
    expect(resolve.annotations.readOnlyHint).toBe(true);
  });

  test("honors the optional server instead of silently ignoring it", async () => {
    await invoke(resolve, { name: "example.com", server: "1.1.1.1@main" });
    expect(run).toHaveBeenCalledExactlyOnceWith(
      ":put [:resolve domain-name=example.com server=1.1.1.1@main]",
      ctx,
    );
  });
});

describe.each([query, resolve])("$name error handling and escaping", (tool) => {
  test.each([
    "failure: dns name does not exist",
    "failure: dns server failure",
    "failure: not enough permissions (9)",
    "bad command name resolve (line 1 column 7)",
    "syntax error (line 1 column 1)",
    "error: timeout",
    "",
    " \r\n\t ",
  ])("reports failure instead of a successful answer for %j", async (output) => {
    run.mockResolvedValue(output);
    const result = await invoke(tool, { name: "example.com" });
    expect(typeof result).toBe("string");
    expect(indicatesFailure(result as string)).toBe(true);
    expect(result).not.toContain("DNS QUERY RESULT");
    expect(result).not.toContain("DNS RESOLVE");
  });

  test("propagates transport failure instead of claiming an empty DNS response", async () => {
    run.mockRejectedValue(new Error("SSH connection unavailable"));
    await expect(invoke(tool, { name: "example.com" })).rejects.toThrow(
      "SSH connection unavailable",
    );
  });

  test("escapes both user-controlled arguments through the shared command builder", async () => {
    const name = 'example.com" ]; :put $secret; #\n/system reboot';
    const server = '1.1.1.1" ]; :put $secret; #\r\n/system reboot';
    await invoke(tool, { name, server });
    const suffix = tool === query ? " type=ipv4" : "";
    expect(run).toHaveBeenCalledExactlyOnceWith(
      `:put [:resolve domain-name=${quoteValue(name)} server=${quoteValue(server)}${suffix}]`,
      ctx,
    );
    const command = run.mock.calls[0][0] as string;
    expect(command).not.toMatch(/[\r\n]/);
    expect(command).toContain("\\$secret");
    expect(command).toContain('\\"');
  });

  test.each([{ name: " " }, { name: "example.com", server: " " }])(
    "rejects blank arguments %j before device I/O",
    (args) => {
      expect(() => invoke(tool, args)).toThrow();
      expect(run).not.toHaveBeenCalled();
    },
  );

  test("trims surrounding input whitespace", async () => {
    await invoke(tool, { name: " example.com ", server: " 1.1.1.1 " });
    expect(run.mock.calls[0][0]).toContain("domain-name=example.com server=1.1.1.1");
  });
});

test("the shared resolver builder escapes RouterOS control characters", () => {
  expect(dnsResolveCommand('a"\\$b\n\r\t', "1.1.1.1", "any6")).toBe(
    ':put [:resolve domain-name="a\\"\\\\\\$b\\n\\r\\t" server=1.1.1.1 type=any6]',
  );
});
