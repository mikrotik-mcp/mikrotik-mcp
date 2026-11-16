import {
  linuxUnit,
  main,
  removeCommandWrappers,
  psQuote,
  serviceOptions,
  validatePorts,
  windowsInstall,
  windowsQuote,
} from "../scripts/service.ts";
import type { ServiceState } from "../scripts/service.ts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { lstatSync, symlinkSync, writeFileSync } from "node:fs";
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mock = vi.hoisted(() => ({
  home: "",
  commands: [] as string[][],
  failEnable: false,
  /** Called for `bun add`, before it "exits"; return a non-zero exit code to fail it. */
  onAdd: undefined as undefined | (() => number),
}));
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  homedir: () => mock.home,
}));
vi.mock("bun", () => ({
  sleep: async () => {},
  spawn: (args: string[]) => {
    mock.commands.push(args);
    const text = args.includes("bin")
      ? join(mock.home, ".bun", "bin")
      : args.includes("--version")
        ? "6.11.0"
        : "";
    return {
      stdout: new Response(text).body,
      exited: Promise.resolve(
        args.includes("add") && mock.onAdd
          ? mock.onAdd()
          : mock.failEnable && args.includes("enable")
            ? 1
            : 0,
      ),
    };
  },
}));

const state: ServiceState = {
  format: 1,
  platform: "linux",
  bun: "/home/a b/bin/bun",
  cli: "/home/a b/app/cli.js",
  installRoot: "/home/a b",
  config: "/home/a b/devices.json",
  cwd: "/home/a b/data",
  args: ["serve", "--config", "/home/a b/$HOME%foo/devices.json"],
  port: 18000,
  dashboardPort: 19090,
};
const originalPlatform = process.platform;
afterEach(async () => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (mock.home) await rm(mock.home, { recursive: true, force: true });
  mock.home = "";
  mock.commands = [];
  mock.failEnable = false;
  mock.onAdd = undefined;
});

async function setup(): Promise<void> {
  if (process.getuid) vi.spyOn(process, "getuid").mockReturnValue(1000);
  mock.home = await mkdtemp(join(tmpdir(), "mcp-service-test-"));
  Object.defineProperty(process, "platform", { value: "linux" });
  vi.stubEnv("XDG_CONFIG_HOME", join(mock.home, ".config"));
  const cli = join(mock.home, ".bun/install/global/node_modules/@usex/mikrotik-mcp/dist/cli.js");
  await mkdir(join(cli, ".."), { recursive: true });
  await writeFile(cli, "// fixture");
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementation(
        () => new Response(JSON.stringify({ result: { serverInfo: { version: "6.11.0" } } })),
      ),
  );
}

describe("cross-platform service definitions", () => {
  it("quotes Linux paths, literal dollars and percent specifiers", () => {
    const unit = linuxUnit(state);
    expect(unit).toContain('ExecStart="/home/a b/bin/bun"');
    expect(unit).toContain('"/home/a b/$$HOME%%foo/devices.json"');
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain("UMask=0077");
    expect(unit).not.toContain("User=root");
  });
  it("creates a limited current-user Windows task without passwords or elevation", () => {
    const script = windowsInstall({ ...state, platform: "win32" });
    expect(script).toContain("-LogonType Interactive -RunLevel Limited");
    expect(script).toContain("-ExecutionTimeLimit ([TimeSpan]::Zero)");
    expect(script).toContain("-MultipleInstances IgnoreNew");
    expect(script).toContain("-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries");
    expect(script).not.toContain("-Password");
    expect(script).not.toContain("-Force");
  });
  it("quotes Windows trailing backslashes and PowerShell apostrophes", () => {
    expect(windowsQuote("C:\\Users\\a b\\")).toBe('"C:\\Users\\a b\\\\"');
    expect(psQuote("C:\\Users\\O'Brien")).toBe("'C:\\Users\\O''Brien'");
  });
  it("rejects multiline values in service definitions", () => {
    expect(() => linuxUnit({ ...state, bun: "bad\nExecStart=evil" })).toThrow();
    expect(() => windowsQuote("bad\nvalue")).toThrow();
  });
  it.each([
    [8000, 8000],
    [0, 9090],
    [8000, 65536],
    [1.2, 9090],
  ])("rejects invalid or overlapping ports %s %s", (a, b) => {
    expect(() => validatePorts(a, b)).toThrow();
  });
  it("defaults to loopback service ports and supports explicit install options", () => {
    expect(serviceOptions(["install"])).toMatchObject({ port: 8000, dashboardPort: 9090 });
    expect(serviceOptions(["install", "--config=x y.json", "--mcp-port", "18000"])).toMatchObject({
      config: "x y.json",
      port: 18000,
    });
  });
  it.each([
    ["upgrade", "--config", "other"],
    ["install", "--wat"],
    ["install", "--config"],
    ["remove"],
    ["install", "extra"],
  ])("rejects invalid CLI %s", (...args) => {
    expect(() => serviceOptions(args)).toThrow();
  });
});

describe("service install orchestration", () => {
  it.each([true, false])(
    "migrates only the known legacy macOS helper (known=%s)",
    async (known) => {
      await setup();
      Object.defineProperty(process, "platform", { value: "darwin" });
      const metadata = join(mock.home, ".mikrotik-mcp/service/service.json");
      await mkdir(join(metadata, ".."), { recursive: true });
      await writeFile(
        metadata,
        JSON.stringify({ ...state, platform: "darwin", bun: process.execPath }),
      );
      const plist = join(mock.home, "Library/LaunchAgents/dev.usestrict.mikrotik-mcp.plist");
      await mkdir(join(plist, ".."), { recursive: true });
      await writeFile(plist, "existing registration");
      const legacy = join(mock.home, ".local/bin/mikrotik-mcp-upgrade");
      await mkdir(join(legacy, ".."), { recursive: true });
      const content = known
        ? 'const LABEL = "dev.usestrict.mikrotik-mcp"; // macOS only; no sudo.'
        : "custom user command";
      await writeFile(legacy, content);
      await main(["install"]);
      const result = await readFile(legacy, "utf8");
      if (known) expect(result).toContain('upgrade "$@"');
      else expect(result).toBe(content);
      expect(await readFile(plist, "utf8")).toBe("existing registration");
      expect(mock.commands.some((args) => args.includes("bootstrap"))).toBe(false);
    },
  );
  it("creates private metadata, a user unit and independent command launchers; repeat install keeps config", async () => {
    await setup();
    await main(["install", "--mcp-port", "28001", "--dashboard-port", "28002"]);
    const config = join(mock.home, ".mikrotik-mcp/devices.json");
    expect(JSON.parse(await readFile(config, "utf8")).devices.router).toEqual({
      host: "127.0.0.1",
      port: 1,
      username: "admin",
      disabled: true,
    });
    const unit = await readFile(
      join(mock.home, ".config/systemd/user/mikrotik-mcp.service"),
      "utf8",
    );
    expect(unit).toContain('"--mcp-host" "127.0.0.1"');
    expect(unit).toContain('"--dashboard-host" "127.0.0.1"');
    expect(await readFile(join(mock.home, ".bun/bin/mikrotik-mcp-upgrade"), "utf8")).toContain(
      'upgrade "$@"',
    );
    await writeFile(config, '{"devices":{},"marker":"preserved"}');
    await main(["install"]);
    expect(await readFile(config, "utf8")).toContain("preserved");
    expect(mock.commands.filter((args) => args.includes("add"))).toHaveLength(0);
    await main(["uninstall"]);
    expect(await readFile(config, "utf8")).toContain("preserved");
    await expect(
      readFile(join(mock.home, ".mikrotik-mcp/service/service.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("recovers registration after a failed activation", async () => {
    await setup();
    mock.failEnable = true;
    await expect(
      main(["install", "--mcp-port", "28003", "--dashboard-port", "28004"]),
    ).rejects.toThrow("systemctl");
    mock.failEnable = false;
    await main(["install"]);
    expect(mock.commands.filter((args) => args.includes("enable"))).toHaveLength(2);
  });
  it("refuses to overwrite an unmanaged Linux unit", async () => {
    await setup();
    const file = join(mock.home, ".config/systemd/user/mikrotik-mcp.service");
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, "unmanaged");
    await expect(main(["install"])).rejects.toThrow("refusing to overwrite");
    expect(await readFile(file, "utf8")).toBe("unmanaged");
  });
  it("keeps missing explicit config errors actionable", async () => {
    await setup();
    await expect(main(["install", "--config", join(mock.home, "missing.json")])).rejects.toThrow(
      "Config file not found",
    );
    expect(mock.commands.some((args) => args.includes("enable"))).toBe(false);
  });
});

describe("upgrade does not collide with Bun's own command links", () => {
  const COMMANDS = ["mikrotik-mcp-service", "mikrotik-mcp-upgrade"];
  const binOf = (name: string) => join(mock.home, ".bun/bin", name);
  const kind = (name: string) => {
    try {
      const info = lstatSync(binOf(name));
      return info.isSymbolicLink() ? "symlink" : info.isFile() ? "file" : "other";
    } catch {
      return "missing";
    }
  };

  it("removes its wrapper files before `bun add` and keeps the links Bun creates", async () => {
    await setup();
    await main(["install", "--mcp-port", "28011", "--dashboard-port", "28012"]);
    // The state that broke `mikrotik-mcp-upgrade`: regular files where Bun links bins.
    expect(COMMANDS.map(kind)).toEqual(["file", "file"]);

    const packaged = join(
      mock.home,
      ".bun/install/global/node_modules/@usex/mikrotik-mcp/scripts/service.ts",
    );
    await mkdir(join(packaged, ".."), { recursive: true });
    const seenByBun: string[] = [];
    mock.onAdd = () => {
      seenByBun.push(...COMMANDS.map(kind));
      // What `bun add --global` does: link each package bin. A regular file in
      // the way is the EEXIST failure.
      if (seenByBun.includes("file")) return 1;
      for (const name of COMMANDS) symlinkSync(join(mock.home, "package", name), binOf(name));
      writeFileSync(packaged, "// service.ts from the new package");
      return 0;
    };
    await main(["upgrade"]);
    // The manager copy that out-of-bin wrappers run now matches the new package.
    expect(await readFile(join(mock.home, ".mikrotik-mcp/service/manager.ts"), "utf8")).toBe(
      "// service.ts from the new package",
    );

    expect(seenByBun).toEqual(["missing", "missing"]);
    expect(COMMANDS.map(kind)).toEqual(["symlink", "symlink"]);
    expect(mock.commands.some((args) => args.includes("restart"))).toBe(true);

    // A second upgrade and a repeat install leave Bun's links alone.
    seenByBun.length = 0;
    mock.onAdd = () => {
      seenByBun.push(...COMMANDS.map(kind));
      return 0;
    };
    await main(["upgrade"]);
    await main(["install"]);
    expect(seenByBun).toEqual(["symlink", "symlink"]);
    expect(COMMANDS.map(kind)).toEqual(["symlink", "symlink"]);
  });

  it("puts the wrappers back when `bun add` fails, and does not restart", async () => {
    await setup();
    await main(["install", "--mcp-port", "28013", "--dashboard-port", "28014"]);
    mock.commands.length = 0;
    mock.onAdd = () => 1;
    await expect(main(["upgrade"])).rejects.toThrow("Command failed");
    expect(COMMANDS.map(kind)).toEqual(["file", "file"]);
    expect(await readFile(binOf("mikrotik-mcp-upgrade"), "utf8")).toContain('upgrade "$@"');
    expect(mock.commands.some((args) => args.includes("restart"))).toBe(false);
  });

  it("removes only its own wrappers: never a link or someone else's file", async () => {
    await setup();
    const bin = join(mock.home, ".bun/bin");
    await mkdir(bin, { recursive: true });
    await writeFile(binOf("mikrotik-mcp-service"), "#!/bin/sh\necho custom user script\n");
    await symlink(join(mock.home, "package", "upgrade.ts"), binOf("mikrotik-mcp-upgrade"));
    await removeCommandWrappers(bin);
    expect(COMMANDS.map(kind)).toEqual(["file", "symlink"]);

    await writeFile(
      binOf("mikrotik-mcp-service"),
      "#!/bin/sh\nexec '/usr/bin/bun' '/home/a/.mikrotik-mcp/service/manager.ts'  \"$@\"\n",
    );
    await removeCommandWrappers(bin);
    expect(kind("mikrotik-mcp-service")).toBe("missing");
    expect((await lstat(binOf("mikrotik-mcp-upgrade"))).isSymbolicLink()).toBe(true);
    await removeCommandWrappers(join(mock.home, "no-such-directory")); // no throw
  });
});

describe("status and upgrade screens", () => {
  /** Everything written to stderr through console.warn, as one string. */
  function capture(): () => string {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    return () => spy.mock.calls.map((call) => String(call[0])).join("\n");
  }

  it("status prints the banner and what it could find out, and changes nothing", async () => {
    await setup();
    await main(["install", "--mcp-port", "28021", "--dashboard-port", "28022"]);
    mock.commands.length = 0;
    const printed = capture();
    await main(["status"]);
    const out = printed();
    expect(out).toContain("|_|  |_|_|_\\_\\_|");
    expect(out).toContain("Shared service · status");
    expect(out).toContain("6.11.0 running and installed");
    expect(out).toContain("http://127.0.0.1:28021/mcp");
    expect(out).toContain("http://127.0.0.1:28022");
    expect(out).toContain("1 device, 0 enabled");
    // Read-only: no install, restart, enable or removal was issued.
    expect(
      mock.commands.some((args) =>
        ["add", "restart", "enable", "disable", "kickstart", "bootout"].some((word) =>
          args.includes(word),
        ),
      ),
    ).toBe(false);
  });

  it("upgrade narrates each step and ends with a summary", async () => {
    await setup();
    await main(["install", "--mcp-port", "28023", "--dashboard-port", "28024"]);
    const printed = capture();
    await main(["upgrade"]);
    const out = printed();
    expect(out).toContain("Shared service · upgrade");
    const order = ["Running now", "Installing", "✓ Installed     6.11.0", "✓ Restarted", "✓ Ready"];
    const positions = order.map((text) => out.indexOf(text));
    expect(positions.every((at) => at >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(out).toContain("Already current · reinstalled");
    expect(out).toContain("Client URLs and config are unchanged.");
  });

  it("a failed install says the old version keeps running", async () => {
    await setup();
    await main(["install", "--mcp-port", "28025", "--dashboard-port", "28026"]);
    const printed = capture();
    mock.onAdd = () => 1;
    await expect(main(["upgrade"])).rejects.toThrow("Command failed");
    expect(printed()).toContain(
      "Upgrade stopped during install. The service was not restarted; 6.11.0 keeps running.",
    );
    expect(printed()).not.toContain("✓ Installed");
  });
});
