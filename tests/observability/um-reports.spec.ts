import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { MikrotikConfigSchema } from "../../src/config";
import { getConfig, setConfig } from "../../src/core/runtime";
import {
  buildUmReport,
  getUmSnapshot,
  getUmUserCounters,
  parseUmReportQuery,
  parseUmRows,
  umDurationSeconds,
  UM_REPORT_FIELDS,
} from "../../src/observability/um-reports";
import type { UmSnapshot } from "../../src/observability/um-reports";
import { getRadiusIncoming, getUmSettings, listAaaEntity } from "../../src/tools/aaa-data";
import { createContext } from "../../src/core/context";
import { DeviceConnectionError } from "../../src/core/device-connection-error";

const read = vi.hoisted(() => vi.fn(async (_command: string) => "[]"));
vi.mock("../../src/core/connector", () => ({ executeMikrotikCommand: read }));
const original = getConfig();
beforeEach(() => {
  setConfig(
    MikrotikConfigSchema.parse({ defaultDevice: "edge", devices: { edge: { host: "192.0.2.1" } } }),
  );
  read.mockReset().mockResolvedValue("[]");
});
afterEach(() => {
  setConfig(original);
  vi.restoreAllMocks();
});
function snapshot(): UmSnapshot {
  const sources = Object.fromEntries(
    Object.keys(UM_REPORT_FIELDS).map((s) => [s, { available: true, rows: [] }]),
  ) as unknown as UmSnapshot["sources"];
  sources.users.rows = [
    { ".id": "*1", name: "alice", group: "full" },
    { ".id": "*2", name: "bob", disabled: "true" },
  ];
  sources.totals.rows = [
    {
      ".id": "*1",
      "active-sessions": "2",
      "total-download": "1000000",
      "total-upload": "400000",
      "total-uptime": "1970-01-03 01:00:00",
      "actual-profile": "standard",
    },
    { ".id": "*2", "active-sessions": "0" },
  ];
  sources.sessions.rows = [
    {
      ".id": "*10",
      user: "alice",
      "acct-session-id": "reused",
      started: "2026-09-01 01:10:00",
      ended: "2026-09-03 00:00:00",
      download: "123456",
      upload: "900",
      uptime: "2d1h",
      "terminate-cause": "lost-carrier",
      "nas-identifier": "edge",
    },
    {
      ".id": "*20",
      user: "alice",
      "acct-session-id": "reused",
      started: "2026-09-03 23:10:00",
      active: "true",
      download: "777",
      upload: "200",
      uptime: "00:10:00",
      "user-address": "192.0.2.10",
    },
    {
      ".id": "*30",
      user: "bob",
      started: "2026-09-03 23:12:00",
      download: "50",
      upload: "70",
      uptime: "0",
    },
    { ".id": "*40", user: "deleted", started: "invalid", download: "50000" },
  ];
  return {
    device: "edge",
    collectedAt: Date.parse("2026-09-03T22:00:00Z"),
    collectionMs: 700,
    clock: { zone: "Asia/Tehran", offsetMs: 12600000 },
    sources,
  };
}
const query = (q = "") => parseUmReportQuery(new URLSearchParams(q));

describe("User Manager accounting reports", () => {
  test("live user counters join by stable ID, retain unknowns and avoid session history", async () => {
    read
      .mockResolvedValueOnce(
        JSON.stringify([
          { ".id": "*1", name: "alice", password: "hidden" },
          { ".id": "*2", name: "bob" },
          { ".id": "*3", name: "new-user" },
        ]),
      )
      .mockResolvedValueOnce(
        JSON.stringify([
          {
            ".id": "*2",
            "total-download": 0,
            "total-upload": 0,
            "total-uptime": "0s",
            "active-sessions": 0,
          },
          {
            ".id": "*1",
            "total-download": 4000,
            "total-upload": 700,
            "total-uptime": "1970-01-03 01:00:00",
            "active-sessions": 2,
          },
        ]),
      );
    const [one, two] = await Promise.all([getUmUserCounters("edge"), getUmUserCounters("edge")]);
    expect(one).toBe(two);
    expect(one.rows).toEqual([
      { id: "*1", name: "alice", download: 4000, upload: 700, seconds: 176400, active: 2 },
      { id: "*2", name: "bob", download: 0, upload: 0, seconds: 0, active: 0 },
      { id: "*3", name: "new-user", download: null, upload: null, seconds: null, active: null },
    ]);
    expect(JSON.stringify(one)).not.toContain("hidden");
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls.some(([cmd]) => cmd.includes("session"))).toBe(false);
    expect(await getUmUserCounters("edge")).toBe(one);
    expect(read).toHaveBeenCalledTimes(2);
    await expect(getUmUserCounters("missing")).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(2);
    setConfig(MikrotikConfigSchema.parse(getConfig()));
    await getUmUserCounters("edge");
    expect(read).toHaveBeenCalledTimes(4);
  });
  test("live counters expire quickly and device failures do not become zeros", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
    await getUmUserCounters("edge");
    now.mockReturnValue(103_000);
    const failure = new DeviceConnectionError("edge", "Failed to connect to device 'edge'");
    read.mockRejectedValueOnce(failure);
    await expect(getUmUserCounters("edge")).rejects.toBe(failure);
    read.mockResolvedValueOnce("bad command name user-manager");
    expect(await getUmUserCounters("edge")).toMatchObject({ available: false, rows: [] });
    read
      .mockResolvedValueOnce('[{".id":"*1","name":"alice"}]')
      .mockResolvedValueOnce('{"truncated":');
    expect(await getUmUserCounters("edge")).toMatchObject({
      available: false,
      rows: [],
      error: expect.stringContaining("Incomplete"),
    });
    expect((await getUmUserCounters("edge")).available).toBe(true);
  });
  test("singleton settings parse colon-delimited output and rejected management reads stay errors", async () => {
    read.mockResolvedValue("enabled: yes\nuse-profiles: no\nauthentication-port: 1812\n");
    expect((await getUmSettings(createContext(undefined, "edge"))).settings).toEqual({
      enabled: "yes",
      "use-profiles": "no",
      "authentication-port": "1812",
    });
    read.mockResolvedValue("accept: yes\nport: 3799");
    expect(await getRadiusIncoming(createContext(undefined, "edge"))).toEqual({
      accept: "yes",
      port: "3799",
    });
    read.mockResolvedValue("failure: not enough permissions");
    await expect(listAaaEntity(createContext(undefined, "edge"), "um-users")).rejects.toThrow();
    await expect(getUmSettings(createContext(undefined, "edge"))).rejects.toThrow();
  });
  test("preserves exact bytes, timestamps, repeated accounting IDs and router-local dates", () => {
    const r = buildUmReport(snapshot(), query("days=7"));
    expect(r.summary.download).toBe(124283);
    expect(r.summary.upload).toBe(1170);
    expect(r.summary.sessions).toBe(3);
    expect(r.summary.active).toBe(2);
    expect(r.coverage.to).toBe("2026-09-04");
    expect(r.coverage.undated).toBe(1);
    expect(r.series.find((d) => d.day === "2026-09-01")?.download).toBe(123456);
    expect(r.series.find((d) => d.day === "2026-09-02")?.download).toBe(0);
    expect(r.series.at(-1)?.cumulativeDownload).toBe(r.summary.download);
    expect(r.hours[23].sessions).toBe(2);
    expect(r.users.find((u) => u.name === "alice")?.sessions).toBe(2);
    expect(r.users.find((u) => u.name === "deleted")?.configured).toBe(false);
  });
  test("individual selection, custom inclusive dates, state and search keep chart totals independent of table filtering", () => {
    const r = buildUmReport(
      snapshot(),
      query("user=alice&from=2026-09-01&to=2026-09-03&state=active&search=192.0.2.10"),
    );
    expect(r.summary.sessions).toBe(2);
    expect(r.sessions.total).toBe(1);
    expect(r.sessions.rows[0].id).toBe("*20");
    expect(r.causes).toEqual([{ name: "lost-carrier", value: 1 }]);
  });
  test("pages large histories without leaking whole session tables to the browser", () => {
    const s = snapshot();
    s.sources.sessions.rows = Array.from({ length: 123 }, (_, i) => ({
      ...s.sources.sessions.rows[0],
      ".id": `*${i}`,
    }));
    const r = buildUmReport(s, query("days=0&page=99"));
    expect(r.sessions.total).toBe(123);
    expect(r.sessions.page).toBe(3);
    expect(r.sessions.rows).toHaveLength(23);
    expect(r.summary.sessions).toBe(123);
  });
  test("failed live monitors stay unknown; empty accounting is a successful empty read", () => {
    const s = snapshot();
    s.sources.totals = { available: false, rows: [], error: "offline" };
    s.sources.sessions.rows = [];
    const r = buildUmReport(s, query());
    expect(r.summary.active).toBeNull();
    expect(r.users[0].totalDownload).toBeNull();
    expect(r.summary.sessions).toBe(0);
    expect(r.sources.sessions.available).toBe(true);
  });
  test("a missing user's monitor counter does not become a false zero", () => {
    const s = snapshot();
    s.sources.totals.rows = [{ ".id": "*1", "active-sessions": "2" }];
    expect(buildUmReport(s, query()).summary.active).toBeNull();
    const single = buildUmReport(s, query("user=alice"));
    expect(single.summary.active).toBe(2);
    expect(single.users.find((u) => u.name === "alice")?.totalDownload).toBeNull();
  });
  test("normalizes singleton JSON, preserves zero and arrays, rejects partial responses and strips secrets", () => {
    expect(
      parseUmRows(
        '{".id":"*1","name":"alice","disabled":false,"password":"private","attributes":"private"}',
        "users",
      ),
    ).toEqual([{ ".id": "*1", name: "alice", disabled: "false" }]);
    expect(parseUmRows('[{"download":0,"status":["start","stop"]}]', "sessions")).toEqual([
      { download: "0", status: "start, stop" },
    ]);
    expect(parseUmRows("[]", "sessions")).toEqual([]);
    expect(() => parseUmRows('[{"user":"alice"}', "sessions")).toThrow();
    expect(() => parseUmRows("null", "sessions")).toThrow();
  });
  test("normalizes RouterOS duration forms including serialized long durations", () => {
    expect(umDurationSeconds("1970-01-19 16:28:25")).toBe(18 * 86400 + 16 * 3600 + 28 * 60 + 25);
    expect(umDurationSeconds("1w2d03:04:05")).toBe(9 * 86400 + 3 * 3600 + 245);
    expect(umDurationSeconds("2d1h20m")).toBe(177600);
    expect(umDurationSeconds("00:01:30")).toBe(90);
  });
  test.each([
    "days=-1",
    "days=NaN",
    "page=0",
    "page=1.5",
    "state=nope",
    "from=2026-02-30",
    "from=2026-09-03&to=2026-09-01",
    "from=garbage",
  ])("rejects invalid filters: %s", (filter) => {
    expect(() => query(filter)).toThrow();
  });
  test("coalesces concurrent reads, projects secrets before transmission and uses monitor once", async () => {
    read.mockImplementation(async (command) =>
      command.includes("/user-manager user print")
        ? '[{".id":"*1","name":"alice"}]'
        : command.includes("/user-manager session find")
          ? '["*A"]'
          : command.includes("/user-manager session print")
            ? '[{".id":"*A","user":"alice"}]'
            : command === "/system clock print"
              ? "time-zone-name: UTC\ngmt-offset: +00:00"
              : "[]",
    );
    const [one, two] = await Promise.all([getUmSnapshot("edge"), getUmSnapshot("edge")]);
    expect(one).toBe(two);
    const commands = read.mock.calls.map(([cmd]) => cmd);
    expect(commands.filter((cmd) => cmd.includes("session print"))).toHaveLength(1);
    expect(commands.some((cmd) => cmd.includes("monitor [find] once as-value"))).toBe(true);
    expect(commands.find((cmd) => cmd.includes("user print"))).not.toContain('"password"');
    const calls = read.mock.calls.length;
    await getUmSnapshot("edge");
    expect(read).toHaveBeenCalledTimes(calls);
    await expect(getUmSnapshot("missing")).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(calls);
  });
  test("device connection failures are reported, not cached as an unavailable package", async () => {
    const failure = new DeviceConnectionError("edge", "Failed to connect to device 'edge'");
    read.mockRejectedValueOnce(failure);
    await expect(getUmSnapshot("edge")).rejects.toBe(failure);
    expect(read).toHaveBeenCalledTimes(1);
    const recovered = await getUmSnapshot("edge");
    expect(recovered.sources.users.available).toBe(true);
  });
  test("reads accounting in bounded ID batches and rejects a missing row instead of partial totals", async () => {
    const ids = Array.from({ length: 2001 }, (_, i) => `*${(i + 1).toString(16)}`);
    read.mockImplementation(async (command) => {
      if (command.includes("/user-manager user print")) return '[{".id":"*1","name":"alice"}]';
      if (command.includes("/user-manager session find")) return JSON.stringify(ids);
      if (command.includes("/user-manager session print")) {
        expect(command).toContain("session print as-value");
        const batch = command.match(/from=([*\da-f,]+)/i)![1].split(",");
        return JSON.stringify(batch.map((id) => ({ ".id": id, user: "alice", download: "17" })));
      }
      return "[]";
    });
    const result = await getUmSnapshot("edge");
    expect(result.sources.sessions.rows).toHaveLength(2001);
    expect(read.mock.calls.filter(([cmd]) => cmd.includes("session print"))).toHaveLength(2);
    setConfig(MikrotikConfigSchema.parse(getConfig()));
    read.mockImplementation(async (command) => {
      if (command.includes("/user-manager user print")) return '[{".id":"*1","name":"alice"}]';
      if (command.includes("/user-manager session find")) return '["*A","*B"]';
      if (command.includes("/user-manager session print")) return '[{".id":"*A"}]';
      return "[]";
    });
    expect((await getUmSnapshot("edge")).sources.sessions.available).toBe(false);
  });
  test("reports unsupported package and incomplete reads without manufacturing empty success", async () => {
    read.mockResolvedValue("bad command name user-manager");
    const r = await getUmSnapshot("edge");
    expect(r.sources.users.available).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
