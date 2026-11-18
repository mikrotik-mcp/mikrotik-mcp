/**
 * Scheduled collection: at an interval, the server copies the files of a router
 * folder that match a pattern into its vault, and keeps the newest ones.
 */
import { CalendarClock, Play, Trash2, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Select } from "./geist";
import type { FileJob } from "./files-lib";
import { filesApi, jobsStore } from "./files-lib";

const HOUR = 60 * 60 * 1000;
const EVERY = [
  { value: String(6 * HOUR), label: "every 6 hours" },
  { value: String(12 * HOUR), label: "every 12 hours" },
  { value: String(24 * HOUR), label: "every day" },
  { value: String(7 * 24 * HOUR), label: "every week" },
];
const everyLabel = (ms: number): string =>
  EVERY.find((option) => option.value === String(ms))?.label ?? `every ${Math.round(ms / HOUR)} h`;

export function JobsDialog({ routers }: { routers: string[] }): ReactNode {
  const open = useSyncExternalStore(jobsStore.subscribe, jobsStore.get);
  const [jobs, setJobs] = useState<FileJob[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [devices, setDevices] = useState<string[]>([]);
  const [dir, setDir] = useState("/");
  const [pattern, setPattern] = useState("\\.(backup|rsc)$");
  const [everyMs, setEveryMs] = useState(String(24 * HOUR));
  const [keep, setKeep] = useState("7");

  const load = useCallback((): void => {
    filesApi
      .jobs()
      .then(setJobs)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => {
    if (!open) return;
    setError("");
    load();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") jobsStore.set(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, load]);

  if (!open) return null;
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
    <div className="term-modal" role="dialog" aria-modal="true" aria-label="Scheduled collection">
      <div className="term-modal-card files-sync">
        <header>
          <strong>
            <CalendarClock size={15} /> Scheduled collection
          </strong>
          <span className="files-viewer-meta">
            Router files copied into the vault at an interval
          </span>
          <button type="button" onClick={() => jobsStore.set(false)} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <form
          className="files-job-form"
          onSubmit={(event) => {
            event.preventDefault();
            act(
              "+",
              filesApi.addJob({
                devices,
                dir,
                pattern,
                everyMs: Number(everyMs),
                keep: Number(keep) || 0,
              }),
            );
          }}
        >
          <fieldset>
            <legend>Routers</legend>
            {routers.map((name) => (
              <label key={name}>
                <Checkbox
                  checked={devices.includes(name)}
                  onCheckedChange={(on) =>
                    setDevices((now) =>
                      on === true ? [...now, name] : now.filter((n) => n !== name),
                    )
                  }
                />{" "}
                {name}
              </label>
            ))}
            <small>{devices.length === 0 ? "None selected: every router." : ""}</small>
          </fieldset>
          <label>
            Folder
            <input
              value={dir}
              onChange={(event) => setDir(event.target.value)}
              aria-label="Folder"
            />
          </label>
          <label>
            File names (regular expression)
            <input
              value={pattern}
              onChange={(event) => setPattern(event.target.value)}
              aria-label="File name pattern"
            />
          </label>
          <label>
            Interval
            <Select
              size="sm"
              className="term-select"
              aria-label="Interval"
              value={everyMs}
              options={EVERY}
              onValueChange={setEveryMs}
            />
          </label>
          <label>
            Keep the newest (0 = all)
            <input
              type="number"
              min={0}
              max={365}
              value={keep}
              onChange={(event) => setKeep(event.target.value)}
              aria-label="Files to keep for each router"
            />
          </label>
          <button type="submit" disabled={busy !== ""}>
            Add the job
          </button>
        </form>
        {error && (
          <p className="files-empty" data-tone="danger">
            {error}
          </p>
        )}
        {jobs?.length === 0 && <p className="files-empty">No job yet.</p>}
        <div className="files-sync-rows">
          {(jobs ?? []).map((job) => (
            <div key={job.id} className="files-sync-row files-trash-row">
              <span className="files-sync-mid">
                <strong>{job.devices.length ? job.devices.join(", ") : "every router"}</strong>
                <small>{everyLabel(job.everyMs)}</small>
              </span>
              <span className="files-sync-cell" title={job.last?.note}>
                {job.dir} · /{job.pattern}/ · keep {job.keep || "all"} · next{" "}
                {new Date(job.next).toLocaleString()}
                {job.last && (
                  <em data-bad={!job.last.ok}>
                    {job.last.ok ? "ok" : "failed"}: {job.last.note}
                  </em>
                )}
              </span>
              <span className="files-sync-mid">
                <button
                  type="button"
                  disabled={busy !== ""}
                  onClick={() => act(job.id, filesApi.runJob(job.id))}
                >
                  <Play size={13} /> {busy === job.id ? "Running…" : "Run now"}
                </button>
                <button
                  type="button"
                  disabled={busy !== ""}
                  title="Remove the job. The collected files stay in the vault."
                  onClick={() => act(job.id, filesApi.removeJob(job.id))}
                >
                  <Trash2 size={13} />
                </button>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
