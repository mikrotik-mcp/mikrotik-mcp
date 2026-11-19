/** Container lifecycle: logs, image upgrade that keeps data, and deploy from a description. */
import { beforeEach, expect, test, vi } from "vite-plus/test";
import { z } from "zod";

const command = vi.hoisted(() => vi.fn());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));
const { containerStackTools, hideEnvValue, serviceCommands } =
  await import("../src/tools/container-stack");

const ctx = { device: "edge", info() {}, error() {} };
const tool = (name: string) => containerStackTools.find((t) => t.name === name)!;
const run = async (name: string, args: Record<string, unknown>): Promise<string> => {
  const result = await (tool(name).handler as (a: unknown, c: unknown) => Promise<unknown>)(
    z.object(tool(name).inputSchema).parse(args),
    ctx,
  );
  return typeof result === "string" ? result : (result as { text: string }).text;
};
beforeEach(() => command.mockReset());

const pihole = {
  name: "pihole",
  image: "pihole/pihole:latest",
  veth: {
    name: "veth-pihole",
    address: "172.20.0.2/24",
    gateway: "172.20.0.1",
    bridge: "containers",
  },
  env: { TZ: "Europe/Berlin", WEBPASSWORD: "s3cret pass" },
  mounts: [{ name: "pihole-etc", src: "/usb1/pihole/etc", dst: "/etc/pihole" }],
  root_dir: "usb1/pihole/root",
  logging: true,
  start_on_boot: true,
};

test("a service becomes veth, envs, mounts and the container, in that order", () => {
  expect(serviceCommands(pihole, false)).toEqual([
    '/interface veth add name=veth-pihole address=172.20.0.2/24 gateway=172.20.0.1 comment="stack: pihole"',
    '/interface bridge port add bridge=containers interface=veth-pihole comment="stack: pihole"',
    "/container envs add list=pihole key=TZ value=Europe/Berlin",
    '/container envs add list=pihole key=WEBPASSWORD value="s3cret pass"',
    "/container mounts add list=pihole src=/usb1/pihole/etc dst=/etc/pihole",
    '/container add name=pihole remote-image=pihole/pihole:latest interface=veth-pihole envlists=pihole mountlists=pihole root-dir=usb1/pihole/root logging=yes start-on-boot=yes comment="stack: pihole"',
  ]);
  const old = serviceCommands(pihole, true);
  expect(old[2]).toBe("/container envs add name=pihole key=TZ value=Europe/Berlin");
  expect(old[4]).toBe("/container mounts add name=pihole-etc src=/usb1/pihole/etc dst=/etc/pihole");
  expect(old.at(-1)).toContain("envlist=pihole mounts=pihole-etc");
  expect(hideEnvValue(old[3]!)).toBe(
    "/container envs add name=pihole key=WEBPASSWORD value=«hidden»",
  );
  expect(hideEnvValue(old[0]!)).toBe(old[0]);
});

const router =
  (opts: { containers?: string; parse?: (text: string) => string } = {}) =>
  async (cmd?: string): Promise<string> => {
    const text = String(cmd);
    if (text.startsWith(":put [:parse")) return opts.parse?.(text) ?? "(evl ok)";
    if (text.startsWith("/container print detail")) return opts.containers ?? "";
    return "";
  };

test("deploy shows a dry run with secrets hidden, then writes in order", async () => {
  command.mockImplementation(router());
  const dry = await run("deploy_container_stack", { services: [pihole] });
  expect(dry).toContain(
    "DRY RUN — 6 command(s) for 1 container(s). Every command is valid on this router.",
  );
  expect(dry).not.toContain("s3cret");
  const writes = () =>
    command.mock.calls
      .map((c) => String(c[0]))
      .filter((c) => / add /.test(c) && !c.startsWith(":put"));
  expect(writes()).toEqual([]);

  command.mockClear();
  const done = await run("deploy_container_stack", { services: [pihole], apply: true });
  expect(done).toContain("Created 1 container(s) with 6 command(s).");
  expect(done).not.toContain("s3cret");
  expect(writes()).toEqual(serviceCommands(pihole, false));
  // It does not start the container.
  expect(command.mock.calls.some((c) => String(c[0]).includes("/container start"))).toBe(false);
});

test("deploy uses the setting names the router knows, skips what exists, and stops before a bad command", async () => {
  // An older RouterOS: `envlists` is not a parameter.
  command.mockImplementation(
    router({
      parse: (t) =>
        t.includes("envlists=") ? "(evl bad parameter envlists (line 1 column 50))" : "(evl ok)",
    }),
  );
  expect(await run("deploy_container_stack", { services: [pihole] })).toContain(
    "envlist=pihole mounts=pihole-etc",
  );

  command.mockImplementation(router({ containers: ' 0 name="pihole" status=stopped' }));
  expect(await run("deploy_container_stack", { services: [pihole], apply: true })).toContain(
    "Nothing to do: every container already exists (pihole).",
  );

  command.mockReset();
  command.mockImplementation(
    router({
      parse: (t) =>
        t.includes("/interface veth")
          ? "(<%% bad command name veth (line 1 column 12))"
          : "(evl ok)",
    }),
  );
  const refused = await run("deploy_container_stack", { services: [pihole], apply: true });
  expect(refused).toContain("Nothing was written");
  expect(refused).toContain("bad command name veth");
  expect(command.mock.calls.some((c) => String(c[0]).startsWith("/interface veth add"))).toBe(
    false,
  );
});

test("an image upgrade needs a mount, a stopped container and a router that can repull", async () => {
  const detail = (fields: string) => router({ containers: ` 0 name="app" tag="app:1" ${fields}` });
  command.mockImplementation(detail("status=stopped"));
  expect(await run("upgrade_container_image", { name: "app", apply: true })).toContain(
    "Not upgraded. Add a mount for the data first, or pass accept_data_loss=true.",
  );
  command.mockImplementation(detail('status=running mountlists="data"'));
  expect(await run("upgrade_container_image", { name: "app", apply: true })).toContain(
    "must be stopped",
  );
  command.mockImplementation(detail('status=stopped mountlists="data"'));
  expect(await run("upgrade_container_image", { name: "app" })).toContain(
    "DRY RUN — would pull app:1 again",
  );

  command.mockClear();
  const done = await run("upgrade_container_image", { name: "app", apply: true });
  expect(done).toContain("Mounts that keep data across the upgrade: data");
  expect(command.mock.calls.map((c) => String(c[0]))).toContain(
    '/container repull [find name="app"]',
  );

  command.mockImplementation(
    router({
      containers: ' 0 name="app" tag="app:1" status=stopped mountlists="data"',
      parse: () => "(<%% bad command name repull (line 1 column 12))",
    }),
  );
  expect(await run("upgrade_container_image", { name: "app", apply: true })).toContain(
    "has no /container repull",
  );
  command.mockImplementation(router());
  expect(await run("upgrade_container_image", { name: "nope" })).toContain(
    "No container named 'nope'",
  );
});

test("logs are read by topic, filtered, and limited to the newest lines", async () => {
  expect(tool("get_container_logs").annotations.readOnlyHint).toBe(true);
  command.mockResolvedValue("line 1\nline 2\nline 3\n");
  expect(await run("get_container_logs", { lines: 2, contains: "err or" })).toBe("line 2\nline 3");
  expect(command.mock.calls[0]![0]).toBe('/log print where topics~"container" message~"err or"');
  command.mockResolvedValue("");
  expect(await run("get_container_logs", {})).toContain("A container logs only with logging=yes");
});
