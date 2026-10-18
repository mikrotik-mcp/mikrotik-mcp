import { beforeEach, expect, test, vi } from "vite-plus/test";
import { composeAddressSet } from "../src/address-sets/model";
import type { AddressSetRevision } from "../src/address-sets/model";
import { createContext } from "../src/core/context";
import { applyAddressSet, createAddressSet, previewAddressSet } from "../src/address-sets/service";

const mock = vi.hoisted(() => ({
  saved: new Map<string, unknown>(),
  entries: [] as Record<string, string>[],
  rule: { ".id": "*1", "dst-address-list": "old", chain: "forward", action: "accept" } as Record<
    string,
    string
  >,
  original: { ".id": "*9", list: "old", address: "192.0.2.0/24" } as Record<string, string>,
  read: vi.fn(),
  write: vi.fn(),
  snapshot: vi.fn(),
  lock: vi.fn(),
  unlock: vi.fn(),
  safe: { isActive: false, enable: vi.fn(), commit: vi.fn(), rollback: vi.fn() },
}));
vi.mock("../src/operations/store", () => ({
  operationsStore: async () => ({
    get: (_kind: string, id: string, device: string) => {
      const r = mock.saved.get(id) as AddressSetRevision | undefined;
      return r?.device === device ? structuredClone(r) : undefined;
    },
    put: (_kind: string, r: AddressSetRevision) => mock.saved.set(r.id, structuredClone(r)),
    list: () => [...mock.saved.values()],
    lock: mock.lock,
    unlock: mock.unlock,
  }),
}));
vi.mock("../src/core/runtime", () => ({
  resolveDeviceName: (d?: string) => d ?? "router",
  getDevice: () => ({ host: "192.0.2.1" }),
}));
vi.mock("../src/core/scoped-access", () => ({ assertDeviceAccess: vi.fn() }));
vi.mock("../src/service-routing/read", () => ({ readRoutingRows: mock.read }));
vi.mock("../src/home/read", () => ({ checkedRead: mock.write }));
vi.mock("../src/snapshots/capture", () => ({ captureSnapshot: mock.snapshot }));
vi.mock("../src/ssh/safe-mode", () => ({ getSafeModeManager: () => mock.safe }));

const input = { name: "example", source: "test fixture", left: ["10.0.0.0/24"] };
const reference = {
  table: "filter" as const,
  id: "*1",
  field: "dst-address-list" as const,
  expected: "old",
};
const ctx = createContext(undefined, "router");

beforeEach(() => {
  vi.clearAllMocks();
  mock.saved.clear();
  mock.entries = [];
  mock.rule = { ".id": "*1", "dst-address-list": "old", chain: "forward", action: "accept" };
  mock.original = { ".id": "*9", list: "old", address: "192.0.2.0/24" };
  mock.safe.isActive = false;
  mock.safe.enable.mockResolvedValue("Safe mode ENABLED");
  mock.safe.commit.mockResolvedValue({ ok: true });
  mock.safe.rollback.mockResolvedValue("rolled back");
  mock.snapshot.mockResolvedValue("snap-1");
  mock.read.mockImplementation(
    async (path: string, _fields: unknown, _ctx: unknown, lists?: string[]) =>
      path.endsWith("address-list")
        ? structuredClone([...mock.entries, mock.original].filter((r) => lists?.includes(r.list)))
        : [{ ...mock.rule }],
  );
  mock.write.mockImplementation(async (command: string) => {
    if (command.includes("address-list add")) {
      const match = /list=(\S+) address=(\S+) comment=(\S+)/.exec(command)!;
      mock.entries.push({ list: match[1], address: match[2], comment: match[3] });
    } else if (command.includes("filter set"))
      mock.rule["dst-address-list"] = command.split("dst-address-list=")[1];
    return "";
  });
});

test("deduplicates overlapping/adjacent CIDRs and produces canonical stable checksums", () => {
  const a = composeAddressSet({ ...input, left: ["10.0.0.1/25", "10.0.0.128/25", "10.0.0.4/32"] });
  const b = composeAddressSet(input);
  expect(a.prefixes).toEqual(["10.0.0.0/24"]);
  expect(a.checksum).toBe(b.checksum);
  expect(a.addresses).toBe("256");
});
test("exact difference and intersection, including IPv6 /0 arithmetic", () => {
  expect(
    composeAddressSet({ ...input, operation: "difference", right: ["10.0.0.128/25"] }).prefixes,
  ).toEqual(["10.0.0.0/25"]);
  expect(
    composeAddressSet({ ...input, operation: "intersection", right: ["10.0.0.128/25"] }).prefixes,
  ).toEqual(["10.0.0.128/25"]);
  expect(composeAddressSet({ ...input, family: "ipv6", left: ["::/0"] }).addresses).toBe(
    (1n << 128n).toString(),
  );
  expect(
    composeAddressSet({
      ...input,
      family: "ipv6",
      left: ["2001:db8::/126"],
      right: ["2001:db8::1/128"],
      operation: "difference",
    }).prefixes,
  ).toEqual(["2001:db8::/128", "2001:db8::2/127"]);
});
test.each(["1.2.3.4/33", "::1", "127.1", "10.0.0.1/24/1", "10.0.0.1;bad"])(
  "rejects invalid/mixed-family prefix %s",
  (value) => {
    expect(() => composeAddressSet({ ...input, left: [value] })).toThrow();
  },
);
test("empty composition cannot become a revision", async () => {
  await expect(
    createAddressSet({ ...input, operation: "difference", right: input.left }, ctx),
  ).rejects.toThrow("empty");
  expect(mock.saved.size).toBe(0);
});
test("publication backs up, verifies generation and restores references without deleting lists", async () => {
  const r = await createAddressSet(input, ctx);
  const preview = await previewAddressSet(r.id, [reference], false, ctx);
  expect(mock.write).not.toHaveBeenCalled();
  const published = await applyAddressSet(r.id, preview.plan!.id, true, ctx);
  expect(published.state).toBe("published");
  expect(mock.snapshot).toHaveBeenCalledOnce();
  expect(mock.safe.commit).toHaveBeenCalledOnce();
  expect(mock.rule["dst-address-list"]).toBe(r.list);
  const rollback = await previewAddressSet(r.id, [], true, ctx);
  expect((await applyAddressSet(r.id, rollback.plan!.id, true, ctx)).state).toBe("rolled-back");
  expect(mock.rule["dst-address-list"]).toBe("old");
  expect(mock.entries).toHaveLength(1);
  expect(mock.write.mock.calls.some(([cmd]) => cmd.includes("remove"))).toBe(false);
});
test("drift and missing confirmation are rejected before writes", async () => {
  const r = await createAddressSet(input, ctx);
  const preview = await previewAddressSet(r.id, [reference], false, ctx);
  await expect(applyAddressSet(r.id, preview.plan!.id, false, ctx)).rejects.toThrow("confirmation");
  mock.rule.action = "drop";
  await expect(applyAddressSet(r.id, preview.plan!.id, true, ctx)).rejects.toThrow("changed");
  expect(mock.safe.enable).not.toHaveBeenCalled();
  expect(mock.write).not.toHaveBeenCalled();
});
test("failed write is uncertain, rolled back and cannot be automatically replayed", async () => {
  const r = await createAddressSet(input, ctx),
    preview = await previewAddressSet(r.id, [reference], false, ctx);
  mock.write.mockRejectedValueOnce(new Error("write failed"));
  await expect(applyAddressSet(r.id, preview.plan!.id, true, ctx)).rejects.toThrow("write failed");
  expect(mock.safe.rollback).toHaveBeenCalledOnce();
  expect((mock.saved.get(r.id) as AddressSetRevision).state).toBe("uncertain");
  await expect(previewAddressSet(r.id, [reference], false, ctx)).rejects.toThrow("state");
});
test("ambiguous commit is not retried or reported as successful", async () => {
  const r = await createAddressSet(input, ctx),
    preview = await previewAddressSet(r.id, [reference], false, ctx);
  mock.safe.commit.mockResolvedValueOnce({ ok: false });
  await expect(applyAddressSet(r.id, preview.plan!.id, true, ctx)).rejects.toThrow("uncertain");
  expect(mock.safe.rollback).not.toHaveBeenCalled();
  expect((mock.saved.get(r.id) as AddressSetRevision).state).toBe("uncertain");
});
test("rollback refuses altered original list contents", async () => {
  const r = await createAddressSet(input, ctx),
    preview = await previewAddressSet(r.id, [reference], false, ctx);
  await applyAddressSet(r.id, preview.plan!.id, true, ctx);
  mock.original.address = "0.0.0.0/0";
  await expect(previewAddressSet(r.id, [], true, ctx)).rejects.toThrow(
    "Original list contents changed",
  );
});
test("negated references preserve negation during publication", async () => {
  mock.rule["dst-address-list"] = "!old";
  const r = await createAddressSet(input, ctx),
    preview = await previewAddressSet(r.id, [{ ...reference, expected: "!old" }], false, ctx);
  await applyAddressSet(r.id, preview.plan!.id, true, ctx);
  expect(mock.rule["dst-address-list"]).toBe(`!${r.list}`);
});
test("cross-device revision IDs are rejected", async () => {
  const r = await createAddressSet(input, ctx);
  await expect(
    previewAddressSet(r.id, [reference], false, createContext(undefined, "other")),
  ).rejects.toThrow("not found");
});

test("parent coverage diff is exact and large changes require acknowledgement", async () => {
  const parent = await createAddressSet(input, ctx);
  const child = await createAddressSet({ ...input, parent: parent.id, left: ["10.0.0.0/26"] }, ctx);
  expect(child.delta?.removedAddresses).toBe("192");
  expect(child.delta?.addedAddresses).toBe("0");
  expect(child.delta?.large).toBe(true);
  await expect(previewAddressSet(child.id, [reference], false, ctx)).rejects.toThrow(
    "acknowledgement",
  );
  expect((await previewAddressSet(child.id, [reference], false, ctx, true)).plan).toBeDefined();
});

test("undo-history budget rejects oversized publication without device writes", async () => {
  const left = Array.from({ length: 65 }, (_, i) => `10.0.0.${i * 2}/32`);
  const r = await createAddressSet({ ...input, left }, ctx);
  await expect(previewAddressSet(r.id, [reference], false, ctx)).rejects.toThrow("64 compacted");
  expect(mock.write).not.toHaveBeenCalled();
});

test("expired previews cannot write", async () => {
  const r = await createAddressSet(input, ctx),
    preview = await previewAddressSet(r.id, [reference], false, ctx);
  (mock.saved.get(r.id) as AddressSetRevision).plan!.expiresAt = 0;
  await expect(applyAddressSet(r.id, preview.plan!.id, true, ctx)).rejects.toThrow("expired");
  expect(mock.write).not.toHaveBeenCalled();
});
