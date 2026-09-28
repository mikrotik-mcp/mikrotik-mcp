import { useEffect, useState } from "react";
import { FileCheck2, Download, EyeOff, Package, Trash2, Check } from "lucide-react";
import { api } from "./api";
import { Button, Select } from "./geist";
import { Checkbox } from "./components/ui/checkbox";
import {
  WorkspaceFrame,
  Notice,
  Steps,
  workspaceCard,
  workspaceNote,
  workspacePost,
  saveDownload,
  ConfirmWorkspaceAction,
  useWorkspaceClock,
} from "./workspace-ui";
import type { Bundle } from "../../src/support/bundle";
import type { Investigation } from "../../src/investigations/model";

export function SupportBundlesView() {
  return (
    <WorkspaceFrame
      title="Share the evidence. Keep the private details."
      description="Prepare a focused support report from saved network evidence. Review exactly what leaves the dashboard before downloading it."
      eyebrow="SUPPORT BUNDLE / PRIVACY FIRST"
    >
      {(device) => <Bundles device={device} />}
    </WorkspaceFrame>
  );
}
function Bundles({ device }: { device: string }) {
  const now = useWorkspaceClock();
  const [casesError, setCasesError] = useState("");
  const [hours, setHours] = useState("24"),
    [cases, setCases] = useState<Investigation[]>([]),
    [chosen, setChosen] = useState<string[]>([]);
  const [include, setInclude] = useState({
    includeEvents: true,
    includeSnapshots: true,
    includeChecks: true,
  });
  const [bundles, setBundles] = useState<Bundle[]>([]),
    [selected, setSelected] = useState<Bundle | null>(null),
    [reviewed, setReviewed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function load() {
    setBundles(await api<Bundle[]>(`/api/support-bundles?device=${encodeURIComponent(device)}`));
  }
  useEffect(() => {
    const abort = new AbortController();
    api<Bundle[]>(`/api/support-bundles?device=${encodeURIComponent(device)}`, abort.signal)
      .then(setBundles)
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    api<{ cases: Investigation[] }>(
      `/api/investigations?device=${encodeURIComponent(device)}`,
      abort.signal,
    )
      .then((d) => setCases(d.cases ?? []))
      .catch((e) => {
        if (!abort.signal.aborted) setCasesError(e.message);
      });
    return () => abort.abort();
  }, [device]);
  async function work(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function create() {
    const until = Date.now(),
      since = until - Number(hours) * 3600000;
    const report = await workspacePost<Bundle>("/api/support-bundles", device, {
      since,
      until,
      cases: chosen,
      ...include,
    });
    setSelected(report);
    setReviewed(false);
    await load();
  }
  async function download(format: "json" | "html") {
    if (!selected || !reviewed) return;
    const data = await workspacePost<{ content: string }>("/api/support-bundles/export", device, {
      id: selected.id,
      format,
    });
    saveDownload(
      `network-support-${selected.id}.${format}`,
      data.content,
      format === "html" ? "text/html" : "application/json",
    );
  }
  return (
    <div className="grid gap-5">
      <Steps
        labels={["Choose evidence", "Review privacy", "Download locally"]}
        active={reviewed ? 2 : selected ? 1 : 0}
      />
      {error && <Notice error>{error}</Notice>}
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(280px,.85fr)_minmax(0,1.3fr)]">
        <section className={`${workspaceCard} grid gap-5`}>
          <h3 className="flex items-center gap-2 font-semibold">
            <Package size={17} className="text-brand" />
            Report contents
          </h3>
          <label className="grid gap-2 text-xs">
            Evidence window
            <Select
              value={hours}
              onValueChange={(v) => {
                setHours(v);
                setChosen([]);
              }}
              options={[
                { value: "1", label: "Last hour" },
                { value: "24", label: "Last 24 hours" },
                { value: "72", label: "Last 3 days" },
                { value: "168", label: "Last 7 days" },
              ]}
            />
          </label>
          {(
            [
              [
                "includeEvents",
                "Tool activity",
                "Names, timings and outcomes. No arguments or output.",
              ],
              [
                "includeSnapshots",
                "Configuration inventory",
                "Section names and counts. No raw exports or values.",
              ],
              [
                "includeChecks",
                "Client measurements",
                "HTTP timing and transfer summaries. No invitation tokens.",
              ],
            ] as const
          ).map(([key, title, description]) => (
            <label
              key={key}
              className="flex items-start gap-3 rounded-xl border border-border bg-background p-4"
            >
              <Checkbox
                checked={include[key]}
                onCheckedChange={(v) => setInclude((i) => ({ ...i, [key]: v === true }))}
              />
              <span>
                <strong className="block text-xs">{title}</strong>
                <span className={`mt-1 block ${workspaceNote}`}>{description}</span>
              </span>
            </label>
          ))}
          <fieldset className="grid gap-3">
            <legend className="mb-3 text-xs font-medium">
              Investigation cases · optional, up to ten
            </legend>
            {cases
              .filter((c) => c.createdAt >= now - Number(hours) * 3600000)
              .map((c) => (
                <label key={c.id} className="flex items-start gap-3 text-xs">
                  <Checkbox
                    checked={chosen.includes(c.id)}
                    disabled={!chosen.includes(c.id) && chosen.length >= 10}
                    onCheckedChange={(v) =>
                      setChosen((a) => (v === true ? [...a, c.id] : a.filter((id) => id !== c.id)))
                    }
                  />
                  <span>
                    {c.service}
                    <small className="mt-1 block text-muted-foreground">
                      {c.client} · {new Date(c.createdAt).toLocaleString()}
                    </small>
                  </span>
                </label>
              ))}
            {casesError && <Notice error>Could not load investigations: {casesError}</Notice>}
            {!casesError && !cases.some((c) => c.createdAt >= now - Number(hours) * 3600000) && (
              <p className={workspaceNote}>
                No saved investigations in this window. Other evidence can still be included.
              </p>
            )}
          </fieldset>
          <Button disabled={busy} onClick={() => void work(create)} icon={<FileCheck2 size={15} />}>
            {busy ? "Preparing…" : "Prepare private preview"}
          </Button>
          <p className={workspaceNote}>
            Uses saved records only. Nothing is queried on a router or sent to an external service.
          </p>
        </section>
        <section className="grid min-w-0 gap-5">
          <div className={workspaceCard}>
            <h3 className="flex items-center gap-2 font-semibold">
              <EyeOff size={18} className="text-brand" />
              What stays out
            </h3>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {[
                "Passwords & private keys",
                "Raw tool input & output",
                "Config values & raw logs",
                "Personal labels & hostnames",
              ].map((text) => (
                <div key={text} className="flex items-center gap-2 text-xs">
                  <Check size={13} className="text-chart-2" />
                  {text}
                </div>
              ))}
            </div>
            <p className={`mt-4 ${workspaceNote}`}>
              IP/MAC addresses and names become consistent aliases, so relationships remain useful.
              The reverse map is discarded. Timestamps and structure may still identify your
              environment — review before sharing.
            </p>
          </div>
          <div className={workspaceCard}>
            <h3 className="mb-4 font-semibold">Saved reports</h3>
            <Select
              aria-label="Saved support report"
              value={selected?.id ?? ""}
              onValueChange={(id) => {
                setSelected(bundles.find((b) => b.id === id) ?? null);
                setReviewed(false);
              }}
              options={[
                { value: "", label: "Choose a prepared report" },
                ...bundles.map((b) => ({
                  value: b.id,
                  label: new Date(b.createdAt).toLocaleString(),
                })),
              ]}
            />
          </div>
          {selected ? (
            <article className={`${workspaceCard} grid gap-4`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-semibold">This is the export</h3>
                <span className="rounded-full border border-brand/30 px-2 py-1 font-mono text-[10px] text-brand">
                  MINIMISED / v1
                </span>
              </div>
              <pre
                aria-label="Support report preview"
                tabIndex={0}
                className="max-h-[480px] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-background p-4 font-mono text-[11px] leading-relaxed"
              >
                {JSON.stringify(selected.report, null, 2)}
              </pre>
              <p className="break-all font-mono text-[10px] text-muted-foreground">
                SHA-256 · {selected.digest}
              </p>
              <label className="flex items-start gap-3 text-xs">
                <Checkbox checked={reviewed} onCheckedChange={(v) => setReviewed(v === true)} />
                <span>
                  I reviewed the complete report. I understand minimisation does not guarantee
                  anonymity.
                </span>
              </label>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={!reviewed || busy}
                  icon={<Download size={14} />}
                  onClick={() => void work(() => download("html"))}
                >
                  Download HTML
                </Button>
                <Button
                  ghost
                  disabled={!reviewed || busy}
                  onClick={() => void work(() => download("json"))}
                >
                  JSON
                </Button>
                <ConfirmWorkspaceAction
                  title="Delete this local report?"
                  description="Original evidence and exported copies are unchanged. This saved report will be removed from this server."
                  action="Delete report"
                  onConfirm={() =>
                    void work(async () => {
                      await workspacePost("/api/support-bundles/delete", device, {
                        id: selected.id,
                        confirm: true,
                      });
                      setSelected(null);
                      await load();
                    })
                  }
                >
                  <Button ghost disabled={busy} icon={<Trash2 size={14} />}>
                    Delete report
                  </Button>
                </ConfirmWorkspaceAction>
              </div>
              <p className={workspaceNote}>
                HTML is self-contained and script-free. Downloading does not upload or share the
                report.
              </p>
            </article>
          ) : (
            <Notice>
              Choose a time window and prepare a preview. You will see every exported field here
              before downloading.
            </Notice>
          )}
        </section>
      </div>
    </div>
  );
}
