import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { runFeedback } from "../raycast/src/lib/fleet-menu";

const raycast = vi.hoisted(() => ({
  environment: { launchType: "userInitiated" },
  toast: { style: "animated", message: "" },
  showToast: vi.fn(),
}));
vi.mock("@raycast/api", () => ({
  environment: raycast.environment,
  LaunchType: { Background: "background", UserInitiated: "userInitiated" },
  Toast: { Style: { Animated: "animated", Success: "success", Failure: "failure" } },
  showToast: raycast.showToast,
  Color: { Green: "green", Orange: "orange", Red: "red", SecondaryText: "secondary" },
  Icon: {},
  MenuBarExtra: {},
  Clipboard: {},
  launchCommand: vi.fn(),
  open: vi.fn(),
  openExtensionPreferences: vi.fn(),
  getPreferenceValues: vi.fn(),
}));

beforeEach(() => {
  raycast.environment.launchType = "userInitiated";
  raycast.toast = { style: "animated", message: "" };
  raycast.showToast.mockReset().mockImplementation(async () => {
    if (raycast.environment.launchType === "background") {
      throw new Error("Toast API is not available when command is launched in background");
    }
    return raycast.toast;
  });
});
afterEach(() => vi.restoreAllMocks());

test("background menu actions execute once without calling the unavailable Toast API", async () => {
  raycast.environment.launchType = "background";
  const action = vi.fn(async () => {});
  await expect(runFeedback("Refresh fleet", action)).resolves.toBeUndefined();
  expect(action).toHaveBeenCalledTimes(1);
  expect(raycast.showToast).not.toHaveBeenCalled();
});

test("background action failures are logged without a toast or an unhandled rejection", async () => {
  raycast.environment.launchType = "background";
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const error = new Error("Dashboard unavailable");
  await expect(
    runFeedback("Refresh fleet", async () => {
      throw error;
    }),
  ).resolves.toBeUndefined();
  expect(raycast.showToast).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith("Refresh fleet failed:", error);
});

test("foreground feedback keeps success and failure updates", async () => {
  await runFeedback("Refresh fleet", async () => {});
  expect(raycast.showToast).toHaveBeenCalledWith({ style: "animated", title: "Refresh fleet" });
  expect(raycast.toast.style).toBe("success");
  await runFeedback("Refresh fleet", async () => {
    throw new Error("Dashboard unavailable");
  });
  expect(raycast.toast).toEqual({ style: "failure", message: "Dashboard unavailable" });
});

test("a rejected foreground toast never prevents or retries the requested action", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  raycast.showToast.mockRejectedValueOnce(new Error("Toast unavailable"));
  const action = vi.fn(async () => {});
  await expect(runFeedback("Refresh fleet", action)).resolves.toBeUndefined();
  expect(action).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalled();
});
