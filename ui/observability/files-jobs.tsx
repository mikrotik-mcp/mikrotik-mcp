/**
 * Scheduled collection: at an interval, the server copies the files of a router
 * folder that match a pattern into its vault, and keeps the newest ones.
 */
import { CalendarClock, Play, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import type { FileJob } from "./files-lib";
import { filesApi } from "./files-lib";
import { Strip } from "./files-parts";
import { Led, MultiSelect, NumberInput, RowMenu, Select, TextInput } from "./kit";

const HOUR = 60 * 60 * 1000;
const EVERY = [
  { value: String(6 * HOUR), label: "Every 6 hours", short: "every 6 h" },
  { value: String(12 * HOUR), label: "Every 12 hours", short: "every 12 h" },
  { value: String(24 * HOUR), label: "Every day", short: "daily" },
  { value: String(7 * 24 * HOUR), label: "Every week", short: "weekly" },
];
const everyShort = (ms: number): string =>
  EVERY.find((option) => option.value === String(ms))?.short ?? `every ${Math.round(ms / HOUR)} h`;
const two = (n: number): string => String(n).padStart(2, "0");
const clock = (ms: number): string => {
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
};

export function JobsTab({
  routers,
  onCount,
}: {
  routers: string[];
  onCount?: (n: number) => void;
}): ReactNode {
  const [jobs, setJobs] = useState<FileJob[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [devices, setDevices] = useState<string[]>([]);
  const [dir, setDir] = useState("/");
  const [pattern, setPattern] = useState("\\.(backup|rsc)$");
  const [everyMs, setEveryMs] = useState(String(24 * HOUR));
  const [keep, setKeep] = useState<number | null>(7);

  const load = useCallback((): void => {
    filesApi
      .jobs()
      .then((list) => {
        setJobs(list);
        onCount?.(list.length);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [onCount]);
  useEffect(() => {
    setError("");
    load();
  }, [load]);

  const act = (id: string, work: Promise<unknown>): void => {
    setBusy(id);
    work
      .then(() => setError(""))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        setBusy("");
        load();
      });
  };

  return (
    <div className="fl-tool">
      <div className="fl-tool-hd">
        <CalendarClock size={16} aria-hidden="true" />
        <h3>Scheduled collection</h3>
        <span className="m">copies router files into the vault</span>
      </div>
      {error && <Strip tone="danger">{error}</Strip>}
      {jobs?.length === 0 && <p className="fl-empty">No job yet. Add one below.</p>}
      {(jobs ?? []).map((job) => {
        const who = job.devices.length ? job.devices.join(", ") : "Every router";
        return (
          <RowMenu
            key={job.id}
            title={`${who} · ${everyShort(job.everyMs)}`}
            sub={`${job.dir} · /${job.pattern}/`}
            actions={[
              {
                label: "Run now",
                icon: <Play />,
                onSelect: () => act(job.id, filesApi.runJob(job.id)),
                disabled: busy !== "",
              },
              {
                label: "Remove the job",
                icon: <Trash2 />,
                danger: true,
                onSelect: () => act(job.id, filesApi.removeJob(job.id)),
                disabled: busy !== "",
              },
            ]}
          >
            <div
              className="fl-lr fl-job-r"
              title="The collected files stay in the vault when a job is removed."
            >
              <Led tone={job.last ? (job.last.ok ? "ok" : "bad") : "off"} />
              <span data-col="job">
                <span className="n">
                  {who} · {everyShort(job.everyMs)}
                </span>
                <span className="m">
                  {job.dir} · /{job.pattern}/ · keep {job.keep || "all"} · next {clock(job.next)}
                </span>
              </span>
              <span
                className="fl-last"
                data-col="last"
                data-tone={job.last ? (job.last.ok ? "ok" : "bad") : undefined}
              >
                {job.last ? `${job.last.ok ? "ok" : "failed"} · ${job.last.note}` : "not run yet"}
              </span>
              <button
                type="button"
                className="fp-act"
                disabled={busy !== ""}
                onClick={() => act(job.id, filesApi.runJob(job.id))}
              >
                <Play size={12} />
                {busy === job.id ? "Running…" : "Run now"}
              </button>
            </div>
          </RowMenu>
        );
      })}
      <form
        className="fl-job-form"
        onSubmit={(event) => {
          event.preventDefault();
          act(
            "+",
            filesApi.addJob({ devices, dir, pattern, everyMs: Number(everyMs), keep: keep ?? 0 }),
          );
        }}
      >
        <MultiSelect
          label="Routers"
          placeholder="Every router"
          noun="router"
          value={devices}
          onChange={setDevices}
          options={routers.map((name) => ({ value: name, label: name }))}
        />
        <TextInput mono value={dir} onChange={setDir} label="Folder" />
        <TextInput mono value={pattern} onChange={setPattern} label="File name pattern" />
        <Select
          label="Interval"
          value={everyMs}
          options={EVERY.map(({ value, label }) => ({ value, label }))}
          onChange={setEveryMs}
        />
        <NumberInput
          value={keep}
          onChange={setKeep}
          min={0}
          max={365}
          label="Files to keep for each router (0 keeps all)"
        />
        <button type="submit" className="fp-act" data-tone="primary" disabled={busy !== ""}>
          Add the job
        </button>
      </form>
    </div>
  );
}
