import { describe, expect, test, vi } from "vite-plus/test";
import { getSuite, listSuites, saveSuite } from "../../src/sim/suites";

const mock = vi.hoisted(() => ({
  rows: new Map<string, { id: string; name: string; packets: string; updated: number }>(),
  fail: false,
  statements: [] as string[],
}));

vi.mock("bun:sqlite", () => ({
  Database: class {
    run(sql: string) {
      mock.statements.push(sql);
    }
    query(sql: string) {
      return {
        all: () => {
          if (mock.fail) throw new Error("read failed");
          return [...mock.rows.values()].sort((a, b) => b.updated - a.updated);
        },
        get: ({ $id }: { $id: string }) => {
          if (mock.fail) throw new Error("read failed");
          return mock.rows.get($id);
        },
        run: (v: { $id: string; $name: string; $packets: string; $updated: number }) => {
          if (mock.fail) throw new Error("write failed");
          mock.statements.push(sql);
          mock.rows.set(v.$id, {
            id: v.$id,
            name: v.$name,
            packets: v.$packets,
            updated: v.$updated,
          });
        },
      };
    }
  },
}));

describe("saved simulation suites with an in-memory SQL adapter", () => {
  test("saves, updates, lists, and reads packet fixtures by ID", async () => {
    mock.fail = false;
    mock.rows.clear();
    const packet = {
      name: "web",
      packet: { srcIp: "192.0.2.10", dstIp: "203.0.113.1", protocol: "tcp" },
      expect: "accept" as const,
    };
    const first = await saveSuite({
      id: "suite-one",
      name: "baseline",
      packets: [packet] as never,
    });
    expect(first.id).toBe("suite-one");
    expect(await getSuite("suite-one")).toEqual(first);
    expect(await listSuites()).toEqual([first]);
    expect(await getSuite("absent")).toBeNull();
    const changed = await saveSuite({ id: "suite-one", name: "revised", packets: [] });
    expect(await getSuite("suite-one")).toEqual(changed);
    expect(mock.statements.some((s) => s.includes("CREATE TABLE IF NOT EXISTS sim_suites"))).toBe(
      true,
    );
  });

  test("an unreadable store returns empty reads and preserves the requested save result", async () => {
    mock.fail = true;
    expect(await listSuites()).toEqual([]);
    expect(await getSuite("suite-one")).toBeNull();
    const proposed = await saveSuite({ name: "unpersisted", packets: [] });
    expect(proposed.id).toMatch(/^suite_/);
    expect(proposed.name).toBe("unpersisted");
    mock.fail = false;
    expect(await getSuite(proposed.id)).toBeNull();
  });
});
