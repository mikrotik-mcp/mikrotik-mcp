/** A RouterOS command is parsed on the router before it runs. Answers are from RouterOS 7.25.1. */
import { beforeEach, expect, test, vi } from "vite-plus/test";

const command = vi.hoisted(() => vi.fn());
vi.mock("../src/core/connector", () => ({ executeMikrotikCommand: command }));

const { checkSyntax, describeProblem, readParseAnswer } = await import("../src/core/syntax-check");
const { rawCommandTools } = await import("../src/tools/raw-command");

const ctx = { device: "home", info: () => {}, error: () => {} } as never;
const tool = (name: string) => rawCommandTools.find((t) => t.name === name)!;
const text = (result: unknown): string =>
  typeof result === "string" ? result : (result as { text: string }).text;

beforeEach(() => command.mockReset());

test("the parser's answer is read as valid or as a problem with its place", () => {
  expect(readParseAnswer("(evl /ip/address/print)\r\n", "/ip address print")).toBeNull();
  expect(
    readParseAnswer(
      "(<%% bad command name adress (line 1 column 5) adress;print)",
      "/ip adress print",
    ),
  ).toEqual({ message: "bad command name adress", line: 1, column: 5, near: "adress" });
  const bad = readParseAnswer(
    "(evl bad parameter interfce (line 1 column 36) /ip/address/add)",
    "/ip address add address=1.2.3.4/24 interfce=x",
  )!;
  expect(describeProblem(bad)).toBe(
    'bad parameter interfce at line 1, column 36 (near "interfce=x")',
  );
  expect(readParseAnswer("syntax error (line 2 column 3)", "/ip address\nadd (")!.line).toBe(2);
});

test("the command is sent as a string to :parse, with READ risk, and never run", async () => {
  command.mockResolvedValue("(evl /ip/address/print)");
  const hostile = '/ip address print"; /system reset-configuration; "';
  expect(await checkSyntax(hostile, ctx)).toBeNull();
  const [sent, sentCtx] = command.mock.calls[0]!;
  expect(sent).toBe(':put [:parse "/ip address print\\"; /system reset-configuration; \\""]');
  expect((sentCtx as { risk: string }).risk).toBe("READ");
});

test("a parse error sent as a failed command is read; another failure does not block", async () => {
  command.mockImplementationOnce(async () => {
    throw new Error("MikroTik command failed (exit code 1): syntax error (line 1 column 9)");
  });
  expect((await checkSyntax("/ip addr (", ctx))!.message).toBe("syntax error");
  // Any other failure means the check did not run: it must not block.
  command.mockImplementationOnce(async () => {
    throw new Error("connection lost");
  });
  expect(await checkSyntax("/ip address print", ctx)).toBeUndefined();
});

test("run_routeros_command refuses a command the router does not know, and runs nothing", async () => {
  command.mockResolvedValueOnce("(<%% bad command name adress (line 1 column 5) adress;print)");
  const run = tool("run_routeros_command").handler as (a: unknown, c: unknown) => Promise<unknown>;
  const refused = await run({ command: "/ip adress print", check_syntax: true }, ctx);
  expect(text(refused)).toContain("Not run");
  expect(text(refused)).toContain("bad command name adress at line 1, column 5");
  expect((refused as { isError: boolean }).isError).toBe(true);
  expect(command).toHaveBeenCalledTimes(1);

  command.mockReset();
  command.mockResolvedValueOnce("(evl /ip/address/print)").mockResolvedValueOnce("0 10.0.0.1/24");
  expect(text(await run({ command: "/ip address print", check_syntax: true }, ctx))).toBe(
    "0 10.0.0.1/24",
  );
  expect(command.mock.calls[1]![0]).toBe("/ip address print");

  // A check that could not run does not block; check_syntax=false skips it.
  command.mockReset();
  command
    .mockImplementationOnce(async () => {
      throw new Error("timeout");
    })
    .mockResolvedValueOnce("ok");
  expect(text(await run({ command: "/ip address print", check_syntax: true }, ctx))).toBe("ok");
  command.mockReset();
  command.mockResolvedValueOnce("ok");
  await run({ command: "/ip address print", check_syntax: false }, ctx);
  expect(command).toHaveBeenCalledTimes(1);
});

test("validate_routeros_command is read-only and reports the result as an answer", async () => {
  const validate = tool("validate_routeros_command");
  expect(validate.annotations.readOnlyHint).toBe(true);
  const handler = validate.handler as (a: unknown, c: unknown) => Promise<unknown>;
  command.mockResolvedValueOnce("(evl /ip/address/print)");
  expect(text(await handler({ command: "/ip address print" }, ctx))).toContain("Valid");
  command.mockResolvedValueOnce("(evl bad parameter interfce (line 1 column 36) x)");
  const bad = await handler({ command: "/ip address add address=1.2.3.4/24 interfce=x" }, ctx);
  expect(text(bad)).toContain("Not valid on this router: bad parameter interfce");
  expect((bad as { isError: boolean }).isError).toBe(false);
  command.mockImplementationOnce(async () => {
    throw new Error("timeout");
  });
  expect(
    ((await handler({ command: "/ip address print" }, ctx)) as { isError: boolean }).isError,
  ).toBe(true);
});
