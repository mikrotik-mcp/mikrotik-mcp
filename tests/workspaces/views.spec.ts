// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { ClientChecksView } from "../../ui/observability/client-checks";
import { RouterMigrationView } from "../../ui/observability/router-migration";
import { SupportBundlesView } from "../../ui/observability/support-bundles";
import { api, postJson } from "../../ui/observability/api";
vi.mock("../../ui/observability/api", () => ({ api: vi.fn(), postJson: vi.fn() }));
vi.hoisted(() => {
  Reflect.deleteProperty(Element.prototype, "animate");
});
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
const button = (text: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === text)!;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(api).mockImplementation(async (path: string) => {
    if (path === "/api/devices")
      return { devices: [{ name: "old" }, { name: "new" }], defaultDevice: "new" } as any;
    if (path.startsWith("/api/investigations")) return { cases: [] } as any;
    if (path === "/api/client-checks/network")
      return {
        bindHost: "0.0.0.0",
        port: 9091,
        localOnly: false,
        candidates: [{ name: "en0", address: "192.168.1.20", origin: "http://192.168.1.20:9091" }],
      } as any;
    return [] as any;
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
test("LAN invitation stays pending until a real heartbeat, then reflects connected, unavailable and stale states", async () => {
  vi.useFakeTimers();
  const session = {
    id: crypto.randomUUID(),
    device: "new",
    createdAt: 1,
    expiresAt: Date.now() + 60000,
    status: "open",
    label: "test",
    runs: [],
    clientPath: "/client-check#fixture.capability",
    connection: null as null | {
      connectedAt: number;
      lastSeen: number;
      peerAddress: string;
      deviceLabel: string;
    },
  };
  const fallback = vi.mocked(api).getMockImplementation()!;
  let created = false;
  vi.mocked(api).mockImplementation(async (path, signal) =>
    path.startsWith("/api/client-checks?")
      ? ((created ? [session] : []) as any)
      : fallback(path, signal),
  );
  vi.mocked(postJson).mockImplementation(async () => {
    created = true;
    return session as any;
  });
  await act(async () => root.render(h(ClientChecksView)));
  expect(postJson).not.toHaveBeenCalled();
  expect(host.querySelector("img")).toBeNull();
  await act(async () => button("Create invitation").click());
  expect(postJson).toHaveBeenCalledWith(
    "/api/client-checks?device=new",
    expect.objectContaining({ minutes: 15 }),
  );
  expect(host.querySelector("img")?.getAttribute("src")).toMatch(/^data:image/);
  expect(host.querySelector<HTMLAnchorElement>('a[target="_blank"]')?.href).toBe(
    "http://192.168.1.20:9091/client-check#fixture.capability",
  );
  const state = () =>
    host.querySelector("[data-connection-state]")?.getAttribute("data-connection-state");
  expect(state()).toBe("pending");
  session.connection = {
    connectedAt: Date.now(),
    lastSeen: Date.now(),
    peerAddress: "192.168.1.30",
    deviceLabel: "Android device",
  };
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(state()).toBe("connected");
  expect(host.textContent).toContain("Android device");
  expect(host.textContent).toContain("192.168.1.30");
  expect(host.querySelector("[data-connected=true]")).not.toBeNull();
  vi.mocked(api).mockRejectedValueOnce(new Error("offline"));
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(state()).toBe("unknown");
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(state()).toBe("connected");
  await act(async () => vi.advanceTimersByTimeAsync(35000));
  expect(state()).toBe("disconnected");
  await act(async () => vi.advanceTimersByTimeAsync(20000));
  expect(state()).toBe("expired");
});
test("support export requires review, escapes markup, and a new report resets acknowledgement", async () => {
  vi.mocked(postJson).mockResolvedValue({
    id: "report",
    device: "new",
    devices: ["new"],
    createdAt: 1,
    status: "ready",
    digest: "abc",
    report: { text: "<script>unsafe</script>" },
  });
  await act(async () => root.render(h(SupportBundlesView)));
  await act(async () => button("Prepare private preview").click());
  expect(button("Download HTML").disabled).toBe(true);
  expect(host.querySelector("pre")?.textContent).toContain("<script>unsafe</script>");
  expect(host.querySelector("script")).toBeNull();
  const review = [...host.querySelectorAll<HTMLElement>('[role="checkbox"]')].at(-1)!;
  await act(async () => review.click());
  expect(button("Download HTML").disabled).toBe(false);
  await act(async () => button("Prepare private preview").click());
  expect(button("Download HTML").disabled).toBe(true);
});
test("saved migration approval gates both write actions", async () => {
  const oldImpl = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async (path: string, ...args: any[]) => {
    if (path.startsWith("/api/migrations?"))
      return [
        {
          id: "plan",
          device: "new",
          createdAt: 1,
          expiresAt: Date.now() + 60000,
          status: "preview",
          input: { source: "old" },
          fingerprint: "abc",
          items: [],
          manual: [],
          blockers: [],
        },
      ] as any;
    return oldImpl(path, ...args);
  });
  await act(async () => root.render(h(RouterMigrationView)));
  expect(postJson).not.toHaveBeenCalled();
  const trigger = host.querySelector<HTMLElement>('[aria-label="Saved migration"]')!;
  await act(async () => trigger.click());
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) =>
    o.textContent?.includes("old → new"),
  )!;
  await act(async () => option.click());
  expect(button("Rehearse & roll back").disabled).toBe(true);
  expect(button("Back up & stage inactive").disabled).toBe(true);
  const approval = host.querySelector<HTMLElement>('[role="checkbox"]')!;
  await act(async () => approval.click());
  expect(button("Back up & stage inactive").disabled).toBe(false);
});
