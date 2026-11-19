/** logSince: the log time filter, pinned to the form that was checked on RouterOS 7.25.1. */
import { expect, test } from "vite-plus/test";
import { logSince } from "../src/core/routeros";

test("the filter compares the entry's own time with the router's local now", () => {
  // On the router this kept 70 of 1000 entries for 5m, the same 70 as a cut-off written by hand.
  // The old form, `time > ([:timestamp] - 5m)`, kept all 1000.
  expect(logSince("5m")).toBe(
    "(([:len $time] < 19) or ([:totime $time] > ([:timestamp] + " +
      "[:totime ((([/system clock get gmt-offset] + 2147483648) % 4294967296) - 2147483648)] - 5m)))",
  );
  expect(logSince("1d12h")).toContain(" - 1d12h)))");
  expect(logSince(60)).toContain(" - 60)))");
});

test("text that is not a duration is refused: it would be read as commands", () => {
  expect(() => logSince("5m) ; /system reboot ; (")).toThrow(/Invalid duration/);
});
