import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { printBanner } from "../src/cli-logo";
import { VERSION } from "../src/version";

const mocks = vi.hoisted(() => ({ art: vi.fn(), color: vi.fn() }));
vi.mock("figlet", () => ({ default: { textSync: mocks.art } }));
vi.mock("gradient-string", () => ({ default: () => ({ multiline: mocks.color }) }));

const originalTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
let write: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.art.mockReturnValue("MikroTik MCP art");
  mocks.color.mockReturnValue("colored art");
  write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  write.mockRestore();
  if (originalTTY) Object.defineProperty(process.stderr, "isTTY", originalTTY);
  else Reflect.deleteProperty(process.stderr, "isTTY");
});

test("non-interactive startup keeps MCP stdout and stderr free of a banner", async () => {
  Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: false });
  await printBanner();
  expect(mocks.art).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});

test("interactive startup writes branded version, transport and site to stderr", async () => {
  Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
  await printBanner();
  expect(mocks.art).toHaveBeenCalledWith("MikroTik MCP", { font: "Small" });
  expect(mocks.color).toHaveBeenCalledWith("MikroTik MCP art");
  expect(write.mock.calls[0][0]).toContain("colored art");
  const box = String(write.mock.calls[1][0]);
  expect(box).toContain(`v${VERSION}`);
  expect(box).toContain("RouterOS over SSH");
  expect(box).toContain("MCP Protocol");
});

test("cosmetic renderer failure falls back to a simple stderr version", async () => {
  Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
  mocks.art.mockImplementationOnce(() => {
    throw new Error("font unavailable");
  });
  await printBanner();
  expect(write).toHaveBeenCalledTimes(1);
  expect(write.mock.calls[0][0]).toContain(`MikroTik MCP v${VERSION}`);
});
