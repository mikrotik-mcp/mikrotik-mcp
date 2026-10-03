import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import { executeMikrotikCommand } from "../src/core/connector";
import { containerTools } from "../src/tools/container";
import { quoteValue } from "../src/core/routeros";
import { toRequest } from "../src/rest/bridge";
import { buildEvent } from "../src/observability/event";
import { formatLogMessage } from "../src/logger";
import { containerCommandForLog, redactContainerText } from "../src/utils/container-redaction";

vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: vi.fn() }));
const exec = vi.mocked(executeMikrotikCommand);
const ctx = { info: vi.fn(), error: vi.fn(), device: "chosen-router" };
const calls = () => exec.mock.calls.map(([command]) => command);
async function run(name: string, args: Record<string, unknown> = {}) {
  const tool = containerTools.find((t) => t.name === name)!;
  return tool.handler(z.object(tool.inputSchema ?? {}).parse(args), ctx);
}
beforeEach(() => {
  exec.mockReset();
  exec.mockResolvedValue("");
});

describe("container target and lifecycle safety", () => {
  test.each(["start", "stop", "remove", "update"])(
    "%s rejects ambiguous and unreadable resolution",
    async (action) => {
      for (const output of ["0", "2", "1\n*A\n*B", "1\nnot-an-id", "", "failure: denied"]) {
        exec.mockReset();
        exec.mockResolvedValue(output);
        await expect(
          run(`${action}_container`, { tag: "same-image:1", comment: "test" }),
        ).rejects.toThrow();
        expect(exec).toHaveBeenCalledTimes(1);
        expect(calls()[0]).toContain("tag=same-image:1");
        expect(calls()[0]).not.toContain("tag~");
      }
    },
  );
  test.each([{ id: "0" }, { id: "*A; /system reboot" }, { name: "a", tag: "b" }, {}])(
    "rejects bad selector before I/O: %j",
    async (args) => {
      await expect(run("stop_container", args)).rejects.toThrow();
      expect(exec).not.toHaveBeenCalled();
    },
  );
  test.each(["start", "remove", "update"])(
    "%s requires positively stopped state",
    async (action) => {
      exec.mockResolvedValueOnce("1\n*A").mockResolvedValueOnce("not-confirmed-stopped");
      await expect(run(`${action}_container`, { id: "*A", env: "K=secret" })).rejects.toThrow(
        "fully stopped",
      );
      expect(exec).toHaveBeenCalledTimes(2);
    },
  );
  test("start uses stable id and reports pending observed state, not health", async () => {
    exec
      .mockResolvedValueOnce("1\n*A")
      .mockResolvedValueOnce("confirmed-stopped")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce('name=app status=starting env="TOKEN=private"');
    const result = await run("start_container", { name: "app" });
    expect(calls()[2]).toBe("/container start numbers=*A");
    expect(result).toContain("pending");
    expect(result).toContain("status=starting");
    expect(result).not.toContain("private");
    for (const [, context] of exec.mock.calls) expect(context.device).toBe("chosen-router");
  });
  test("remove verifies exact absence and never deletes files", async () => {
    exec
      .mockResolvedValueOnce("1\n*AB")
      .mockResolvedValueOnce("confirmed-stopped")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("0");
    expect(await run("remove_container", { id: "*AB" })).toContain("removal verified");
    expect(calls()[2]).toBe("/container remove numbers=*AB");
    expect(calls()[3]).toBe("/container print count-only where .id=*AB");
    expect(calls().join("\n")).not.toContain("/file");
  });
  test("failed read-back does not report a confirmed removal", async () => {
    exec
      .mockResolvedValueOnce("1\n*A")
      .mockResolvedValueOnce("confirmed-stopped")
      .mockResolvedValueOnce("")
      .mockRejectedValueOnce(new Error("offline"));
    expect(await run("remove_container", { id: "*A" })).toContain("UNVERIFIED");
    expect(exec).toHaveBeenCalledTimes(4);
  });
  test("ambiguous write is not replayed or leaked", async () => {
    exec
      .mockResolvedValueOnce("1\n*A")
      .mockResolvedValueOnce("confirmed-stopped")
      .mockRejectedValueOnce(new Error("timeout env=hidden-secret"));
    await expect(run("update_container", { id: "*A", env: "TOKEN=hidden-secret" })).rejects.toThrow(
      "outcome UNKNOWN",
    );
    expect(exec).toHaveBeenCalledTimes(3);
  });
  test("metadata-only updates need no stop and empty updates do no I/O", async () => {
    expect(await run("update_container", { id: "*A" })).toBe("No updates specified.");
    expect(exec).not.toHaveBeenCalled();
    exec
      .mockResolvedValueOnce("1\n*A")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("comment=ok");
    expect(await run("update_container", { id: "*A", comment: "ok" })).toContain("update accepted");
    expect(calls()[1]).toBe("/container set numbers=*A comment=ok");
  });
  test("explicit empty env clears overrides instead of silently omitting the update", async () => {
    exec
      .mockResolvedValueOnce("1\n*A")
      .mockResolvedValueOnce("confirmed-stopped")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce('env=""');
    await run("update_container", { id: "*A", env: "" });
    expect(calls()[2]).toBe('/container set numbers=*A env=""');
  });
});

describe("container input validation and current/legacy command fields", () => {
  const add = { name: "app", interface: "veth-app", root_dir: "disk1/app" };
  test.each([
    {},
    { remote_image: "image:1", file: "image.tar" },
    { remote_image: "image:1", envlist: "old", envlists: "new" },
    { remote_image: "image:1", mounts: "old", mountlists: "new" },
  ])("rejects invalid add before I/O: %j", async (args) => {
    await expect(run("add_container", { ...add, ...args })).rejects.toThrow();
    expect(exec).not.toHaveBeenCalled();
  });
  test("add requires identity, VETH, storage and verified uniqueness", async () => {
    await expect(run("add_container", { remote_image: "image:1" })).rejects.toThrow();
    exec.mockResolvedValue("failure: denied");
    await expect(run("add_container", { ...add, remote_image: "image:1" })).rejects.toThrow();
    expect(exec).toHaveBeenCalledTimes(1);
  });
  test.each([
    { envlists: "env", mountlists: "data" },
    { envlist: "env", mounts: "data" },
  ])("explicit syntax is preserved, no fallback writes: %j", async (fields) => {
    exec
      .mockResolvedValueOnce("0")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("status=extracting");
    expect(await run("add_container", { ...add, remote_image: "image:1", ...fields })).toContain(
      "asynchronous",
    );
    for (const [key, value] of Object.entries(fields))
      expect(calls()[1]).toContain(`${key}=${value}`);
    expect(exec).toHaveBeenCalledTimes(3);
  });
  test.each(["memory_high", "ram_high"])("%s maps to real memory-high", async (field) => {
    await run("set_container_config", { [field]: "256M" });
    expect(calls()[0]).toBe("/container config set memory-high=256M");
    expect(calls()[0]).not.toContain("ram-high");
  });
  test("conflicting memory aliases are rejected", async () => {
    await expect(
      run("set_container_config", { memory_high: "256M", ram_high: "128M" }),
    ).rejects.toThrow();
    expect(exec).not.toHaveBeenCalled();
  });
  test.each(["list", "name"])("mount uses explicit %s grouping", async (field) => {
    exec.mockResolvedValueOnce("0").mockResolvedValueOnce("").mockResolvedValueOnce("1");
    expect(
      await run("add_container_mount", { [field]: "data", src: "disk1/data", dst: "/data" }),
    ).toContain("verified");
    expect(calls()[1]).toBe(`/container mounts add ${field}=data src=disk1/data dst=/data`);
  });
  test("multi-entry mount lists are not bulk-deleted", async () => {
    exec.mockResolvedValue("2");
    await expect(run("remove_container_mount", { list: "data" })).rejects.toThrow("Ambiguous");
    expect(exec).toHaveBeenCalledTimes(1);
  });
  test("regex and mount selectors escape quotes, dollar substitutions and newlines", async () => {
    const injection = 'x"; /system reboot\n$bad';
    await run("list_containers", { name_filter: injection, tag_filter: "x" });
    expect(calls()[0]).toContain(`name~${quoteValue(injection)}`);
    expect(calls()[0]).not.toContain("\n");
    exec.mockReset();
    exec.mockResolvedValue("0");
    await expect(run("remove_container_mount", { name: injection })).rejects.toThrow("not found");
    expect(calls()[0]).toContain(`name=${quoteValue(injection)}`);
  });
});

describe("container secret boundaries", () => {
  test("env reads request metadata only and mask an unexpected echoed value", async () => {
    exec.mockResolvedValue('list=app key=TOKEN value="secret"');
    const result = await run("list_container_envs", { list_filter: "app" });
    expect(calls()[0]).toContain(" proplist=.id,list,key,disabled");
    expect(calls()[0]).not.toContain(" .proplist=");
    expect(toRequest(calls()[0])?.query).toEqual({
      ".proplist": ".id,list,key,disabled",
      list: "app",
    });
    expect(result).not.toContain("secret");
    expect(result).toContain("TOKEN");
  });
  test.each([
    'env="TOKEN=secret\\\"suffix"',
    'env-current="K=secret\nmore"',
    "value=secret",
    'password="secret"',
    'config-json="{secret}"',
    'default-cmd="secret"',
    'env="secret',
  ])("masks escaped, multiline and unquoted attributes: %s", (input) => {
    expect(redactContainerText(input)).not.toContain("secret");
  });
  test("logs omit arguments without changing original command bytes", () => {
    const command = '/container envs add list=app key=TOKEN value="secret"';
    expect(containerCommandForLog(command)).not.toContain("secret");
    expect(formatLogMessage(`Failed ${command}`)).not.toContain("secret");
    expect(command).toContain('value="secret"');
    expect(containerCommandForLog("/ip route print")).toBe("/ip route print");
    expect(formatLogMessage(`[router] Executing MikroTik command: ${command}`)).toContain(
      "[router] Executing MikroTik command: /container envs add",
    );
  });
  test("singleton config print masks colon-style credentials", async () => {
    exec.mockResolvedValue(
      "registry-url: https://registry.example\npassword: secret\nmemory-high: 256M",
    );
    const result = await run("get_container_config");
    expect(result).not.toContain("secret");
    expect(result).toContain("memory-high: 256M");
  });
  test("activity history redacts generic env/value/cmd fields", () => {
    const event = buildEvent(
      {
        tool: "add_container_env",
        title: "Env",
        risk: "WRITE",
        ts: 1,
        durationMs: 1,
        isError: false,
        args: { list: "app", key: "TOKEN", value: "secret", env: "K=hidden", cmd: "sensitive" },
        output: "Created",
        hasStructured: false,
      },
      "test",
      { captureBody: true, maxBodyBytes: 4000 },
    );
    expect(event.input).not.toContain("secret");
    expect(event.input).not.toContain("hidden");
    expect(event.input).not.toContain("sensitive");
    expect(event.input).toContain("TOKEN");
  });
});
