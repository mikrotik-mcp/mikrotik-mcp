/// <reference types="bun" />
/** Scheduled collection of router files: validation, due time, retention. */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test } from "vite-plus/test";

const jobs = await import("../../src/observability/files-schedules");

const HOUR = 60 * 60 * 1000;
beforeEach(() => jobs.setJobsFile(undefined));

test("a job needs a valid pattern and an interval of an hour or longer", () => {
  expect(() => jobs.addJob({ dir: "/", pattern: "(", everyMs: HOUR })).toThrow(
    "regular expression",
  );
  expect(() => jobs.addJob({ dir: "/", everyMs: 60_000 })).toThrow("one hour");
  const job = jobs.addJob({ dir: "/", everyMs: HOUR, keep: 9999, devices: ["a", 5, ""] }, 1000);
  expect(job).toEqual(
    expect.objectContaining({
      devices: ["a"],
      pattern: "\\.(backup|rsc)$",
      keep: 365,
      next: 1000 + HOUR,
    }),
  );
});

test("a due job collects from every router, keeps the newest files and goes on after a failure", async () => {
  const job = jobs.addJob({ dir: "/", everyMs: HOUR, keep: 2 }, 0);
  const dropped: string[] = [];
  let round = 0;
  const collect = async (device: string): Promise<string[]> => {
    if (device === "down") throw new Error("no route");
    round += 1;
    return [`${device}_${round}a.backup`, `${device}_${round}b.backup`];
  };
  expect(
    await jobs.runDueJobs(["up", "down"], collect, (name) => dropped.push(name), HOUR - 1),
  ).toBe(0);
  expect(await jobs.runDueJobs(["up", "down"], collect, (name) => dropped.push(name), HOUR)).toBe(
    1,
  );
  expect(job.last).toEqual({ at: HOUR, ok: false, note: "up: 2 new · down: no route" });
  expect(job.next).toBe(2 * HOUR);
  await jobs.runDueJobs(["up", "down"], collect, (name) => dropped.push(name), 2 * HOUR);
  expect(dropped).toEqual(["up_1a.backup", "up_1b.backup"]);
  expect(job.collected.up).toEqual(["up_2a.backup", "up_2b.backup"]);
});

test("jobs are saved to a file and read again", () => {
  const file = join(mkdtempSync(join(tmpdir(), "files-jobs-")), "jobs.json");
  jobs.setJobsFile(file);
  const job = jobs.addJob({ dir: "/flash", everyMs: HOUR });
  expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(1);
  jobs.setJobsFile(file);
  expect(jobs.listJobs().map((item) => item.id)).toEqual([job.id]);
  expect(jobs.removeJob(job.id)).toBe(true);
  expect(jobs.listJobs()).toEqual([]);
});
