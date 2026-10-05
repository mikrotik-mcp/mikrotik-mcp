import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import type { ToolContext } from "../src/core/context";
import { quoteValue } from "../src/core/routeros";
import { wirelessTools } from "../src/tools/wireless";

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: run }));
const ctx: ToolContext = { device: "home-ax3", info: vi.fn(), error: vi.fn() };
const paths = ["/interface wifi", "/interface wifiwave2", "/interface wireless", "/interface wlan"];
const security =
  'name=home authentication-types=wpa2-psk,wpa3-psk encryption=ccmp passphrase="top secret" .eap-password=hidden';

function tool(name: string) {
  return wirelessTools.find((entry) => entry.name === name)!;
}
function invoke(name: string, args: Record<string, unknown> = {}) {
  const entry = tool(name);
  return entry.handler(z.object(entry.inputSchema ?? {}).parse(args), ctx);
}
function stack(path: string, output = security) {
  run.mockImplementation(async (command: string) => {
    if (command.endsWith(" print count-only")) {
      return command === `${path} print count-only` ? "2\r\n" : "bad command name";
    }
    if (command.includes("actual-configuration")) return "bad command name actual-configuration";
    if (!command.startsWith(path)) return "bad command name";
    return output;
  });
}
beforeEach(() => {
  run.mockReset();
  stack(paths[0]);
});

describe("Wi-Fi security and interface reads", () => {
  test.each(paths)("reads security presets on %s", async (path) => {
    stack(path);
    const menu =
      path === "/interface wifi" || path === "/interface wifiwave2"
        ? "security"
        : "security-profiles";
    expect(await invoke("list_wireless_security_profiles")).toContain("wpa2-psk,wpa3-psk");
    expect(run).toHaveBeenCalledWith(`${path} ${menu} print detail`, ctx);
    const result = await invoke("get_wireless_security_profile", { name: "home" });
    expect(run).toHaveBeenCalledWith(`${path} ${menu} print detail where name=home`, ctx);
    expect(result).toContain('passphrase="***"');
    expect(result).not.toContain("top secret");
    expect(result).not.toContain("hidden");
  });

  test("reads effective SSID/security separately from current-channel evidence", async () => {
    stack(
      paths[0],
      'name=wifi1 configuration.ssid="Home WiFi" security.authentication-types=wpa3-psk .passphrase=hidden channel.frequency=5180,5260',
    );
    const result = await invoke("get_wireless_interface", { name: "wifi1" });
    expect(result).toContain('configuration.ssid="Home WiFi"');
    expect(result).toContain("wpa3-psk");
    expect(result).toContain("not the actual operating channel");
    expect(result).not.toContain("hidden");
    expect(run).toHaveBeenCalledWith("/interface wifi print detail where name=wifi1", ctx);
    expect(
      run.mock.calls.every(([cmd]) => !/\b(set|add|remove|scan|frequency-scan)\b/.test(cmd)),
    ).toBe(true);
  });

  test("includes actual-configuration on older modern drivers", async () => {
    stack(paths[1], "name=wifi1 configuration=home");
    run.mockImplementation(async (cmd: string) => {
      if (cmd === "/interface wifi print count-only") return "bad command name";
      if (cmd.endsWith("count-only")) return "1";
      return cmd.includes("actual-configuration")
        ? "name=wifi1 ssid=Home authentication-types=wpa2-psk passphrase=hidden"
        : "name=wifi1 configuration=home";
    });
    const result = await invoke("get_wireless_interface", { name: "wifi1" });
    expect(result).toContain("ACTUAL CONFIGURATION");
    expect(result).toContain("ssid=Home");
    expect(result).not.toContain("hidden");
  });

  test("lists detail and safely escapes regex filters", async () => {
    const filter = 'wifi"; :put $secret\n/system reboot';
    const result = await invoke("list_wireless_interfaces", {
      name_filter: filter,
      running_only: true,
    });
    expect(run).toHaveBeenCalledWith(
      `/interface wifi print detail where name~${quoteValue(filter)} and running=yes`,
      ctx,
    );
    expect(result).not.toContain("top secret");
    expect(result).toContain("wpa3-psk");
  });

  test("reads registration details using an escaped interface filter", async () => {
    await invoke("get_wireless_registration_table", { interface: "wifi1" });
    expect(run).toHaveBeenCalledWith(
      "/interface wifi registration-table print detail where interface=wifi1",
      ctx,
    );
  });

  test("does not confuse an installed empty modern menu with the active legacy driver", async () => {
    stack(paths[2]);
    run.mockImplementation(async (cmd: string) => {
      if (cmd === "/interface wifi print count-only") return "0";
      if (cmd === "/interface wireless print count-only") return "2";
      if (cmd.endsWith("count-only")) return "bad command name";
      return security;
    });
    await invoke("get_wireless_security_profile", { name: "home" });
    expect(run).toHaveBeenCalledWith(
      "/interface wireless security-profiles print detail where name=home",
      ctx,
    );
  });

  test("an empty supported menu still allows reading configured profiles", async () => {
    run.mockImplementation(async (cmd: string) =>
      cmd === "/interface wifi print count-only"
        ? "0"
        : cmd.endsWith("count-only")
          ? "bad command name"
          : security,
    );
    expect(await invoke("list_wireless_security_profiles")).toContain("wpa3-psk");
  });

  test.each(["failure: not enough permissions (9)", "error: timeout", "", "unexpected text"])(
    "does not fall back to a different driver on probe failure %j",
    async (output) => {
      run.mockResolvedValue(output);
      await expect(invoke("get_wireless_interface", { name: "wifi1" })).rejects.toThrow(
        "Failed to detect",
      );
      expect(run).toHaveBeenCalledTimes(1);
    },
  );

  test("propagates transport failure", async () => {
    run.mockRejectedValue(new Error("SSH unavailable"));
    await expect(invoke("get_wireless_interface_status", { interface: "wifi1" })).rejects.toThrow(
      "SSH unavailable",
    );
  });

  test.each(["get_wireless_security_profile", "get_wireless_interface"])(
    "escapes names for %s",
    async (name) => {
      const input = 'home" ]; :put $secret; #\n/system reboot';
      await invoke(name, { name: input });
      expect(run.mock.calls.some(([cmd]) => cmd.endsWith(`where name=${quoteValue(input)}`))).toBe(
        true,
      );
      expect(run.mock.calls.every(([cmd]) => !/[\r\n]/.test(cmd))).toBe(true);
    },
  );

  test.each([
    "list_wireless_security_profiles",
    "get_wireless_security_profile",
    "get_wireless_interface",
    "get_wireless_registration_table",
    "get_wireless_interface_status",
  ])("%s reports device-side failures instead of successful data", async (name) => {
    stack(paths[0], "failure: not enough permissions (9)");
    expect(await invoke(name, { name: "home", interface: "wifi1" })).toContain("Failed to");
    expect(tool(name).annotations.readOnlyHint).toBe(true);
  });

  test("distinguishes no presets from an unknown profile", async () => {
    stack(paths[0], "");
    expect(await invoke("list_wireless_security_profiles")).toContain("No Wi-Fi security profiles");
    expect(await invoke("get_wireless_security_profile", { name: "home" })).toContain("not found");
  });
});

describe("runtime monitoring and bounded scans", () => {
  test.each(paths)("monitor reads %s once without disrupting clients", async (path) => {
    stack(path, "state: running\nchannel: 5500/ax/Ceee\nregistered-peers: 3");
    const result = await invoke("get_wireless_interface_status", { interface: "wifi1" });
    expect(run).toHaveBeenCalledWith(`${path} monitor wifi1 once`, ctx);
    expect(result).toContain("5500/ax/Ceee");
    expect(run.mock.calls.every(([cmd]) => !/\b(scan|frequency-scan|set)\b/.test(cmd))).toBe(true);
  });

  test.each(["scan_wireless_networks", "scan_wifi_channels"])(
    "%s cannot scan without explicit approval",
    async (name) => {
      expect(await invoke(name, { interface: "wifi1" })).toContain("explicit user approval");
      expect(run).not.toHaveBeenCalled();
      expect(tool(name).annotations.readOnlyHint).not.toBe(true);
      for (const duration of [0, 31, -1, 1.5]) {
        expect(() => invoke(name, { interface: "wifi1", duration, confirm: true })).toThrow();
      }
      expect(run).not.toHaveBeenCalled();
    },
  );

  test.each([paths[0], paths[1]])("modern RF survey uses %s frequency-scan", async (path) => {
    stack(path, "CHANNEL NETWORKS LOAD NF\n5180 2 25 -98");
    expect(
      await invoke("scan_wifi_channels", { interface: "wifi1", confirm: true, duration: 3 }),
    ).toContain("5180");
    expect(run).toHaveBeenCalledWith(`${path} frequency-scan wifi1 duration=3s`, ctx);
    expect(run.mock.calls.every(([cmd]) => !cmd.includes("frequency-monitor"))).toBe(true);
  });

  test("rejects modern RF surveys on legacy drivers", async () => {
    stack(paths[2]);
    expect(await invoke("scan_wifi_channels", { interface: "wlan1", confirm: true })).toContain(
      "Error:",
    );
    expect(run.mock.calls.every(([cmd]) => !cmd.includes("frequency-scan"))).toBe(true);
  });

  test("approved AP scans use bounded duration and escaped names", async () => {
    const name = 'wifi"; :put $secret\n';
    await invoke("scan_wireless_networks", { interface: name, confirm: true });
    expect(run).toHaveBeenCalledWith(
      `/interface wifi scan ${quoteValue(name.trim())} duration=5s`,
      ctx,
    );
  });

  test("no wireless support is reported explicitly", async () => {
    run.mockResolvedValue("bad command name");
    expect(await invoke("get_wireless_interface_status", { interface: "wifi1" })).toContain(
      "No wireless interface support",
    );
  });
});
