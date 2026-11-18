/**
 * Round-trip lab, after the approved Signal board: describe a connection, list
 * the routers it crosses, and compare the request and reply paths in saved
 * configurations. Nothing here sends traffic or changes a router.
 */
import { LoadingState } from "./loading-state";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ChevronDown,
  ChevronUp,
  Check,
  ChevronRight,
  CircleHelp,
  Plus,
  RefreshCw,
  Route,
  Server,
  X,
} from "lucide-react";
import { api, postJson } from "./api";
import { JsonView } from "./highlight";
import type { HopEvidence, PathLeg, PathStatus, RoundTripResult } from "../../src/paths/types";
import { blankStep, buildTripInput, returnSteps } from "./round-trip-form";
import type { PathStep, RouterChoice, TripForm } from "./round-trip-form";
import {
  MonitorButton,
  MonitorNote,
  MonitorPanel,
  MonitorSwitch,
  PageIntro,
  Segmented,
  StatusBadge,
} from "./monitoring-ui";
import type { Tone } from "./monitoring-ui";
import { FormField, FormSelect } from "./path-fields";
import { PATH_LABEL, RoundTripLanes } from "./round-trip-lanes";
import { DetailList, NumberInput, RowDrawer, RowMenu, RowMore, TextInput } from "./kit";
import "./monitoring.css";
import "./round-trip.css";

const TONE: Record<PathStatus, Tone> = { modelled: "good", blocked: "bad", unknown: "warn" };
const TEXT: Record<PathStatus, string> = {
  modelled: "text-success",
  blocked: "text-destructive",
  unknown: "text-warning",
};

/** "17 Nov, 13:58", or with seconds for provenance. */
function when(at: number, seconds = false): string {
  const d = new Date(at);
  // The boards write dates day first: "17 Nov".
  const date = `${d.getDate()} ${d.toLocaleDateString("en", { month: "short" })}`;
  const time = d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
    hourCycle: "h23",
  });
  return `${date}, ${time}`;
}

/** One sentence per leg: "The request gets through." / "The reply is blocked on core-router-01." */
function legSentence(name: "request" | "reply", leg: PathLeg): ReactNode {
  const The = name === "request" ? "The request" : "The reply";
  if (!leg.hops.length) return <span className="text-warning">{The} was not checked.</span>;
  if (leg.status === "modelled")
    return name === "request" ? "The request gets through." : "The reply gets back.";
  const at = leg.hops.find((h) => h.status !== "modelled")?.device;
  return (
    <>
      <span className={TEXT[leg.status]}>
        {The} {leg.status === "blocked" ? "is blocked" : "cannot be determined"}
      </span>
      {at ? ` on ${at}.` : "."}
    </>
  );
}

function HopCard({ hop }: { hop: HopEvidence }): ReactNode {
  return (
    <div className="glass flex flex-col gap-2 px-4 py-3.5">
      <div className="flex items-center gap-2">
        <Server aria-hidden="true" className="size-[15px] flex-none text-muted-foreground" />
        <b className="min-w-0 flex-1 truncate font-mono text-[13px] font-bold text-foreground">
          {hop.device}
        </b>
        <span className={`text-[12px] ${TEXT[hop.status]}`}>{PATH_LABEL[hop.status]}</span>
      </div>
      <span className="font-mono text-[12px] text-muted-foreground">
        {hop.ingress} → {hop.egress}
      </span>
      <span className="text-[13px] leading-5 text-fg-secondary">{hop.reason}</span>
      {hop.trace && (
        <details className="rt-details">
          <summary className="text-[12px] text-muted-foreground">
            <ChevronRight aria-hidden="true" className="size-[13px]" />
            Technical evidence (optional)
          </summary>
          <div className="mt-2">
            <JsonView value={hop.trace} maxHeight={300} />
          </div>
        </details>
      )}
    </div>
  );
}

function Leg({ title, leg }: { title: string; leg: PathLeg }): ReactNode {
  return (
    <MonitorPanel
      title={title}
      extra={
        <StatusBadge tone={TONE[leg.status]} dot={false}>
          {PATH_LABEL[leg.status]}
        </StatusBadge>
      }
    >
      <div className="flex flex-col gap-2.5">
        {!leg.hops.length && (
          <MonitorNote tone="warn">
            The outbound path did not complete reliably, so a valid reply cannot be assumed. The
            return path was not evaluated.
          </MonitorNote>
        )}
        {leg.hops.map((h, i) => (
          <HopCard key={`${h.device}-${i}`} hop={h} />
        ))}
      </div>
    </MonitorPanel>
  );
}

/** Guided offline input. Loading choices never captures snapshots or contacts a router. */
export function RoundTripView(): ReactNode {
  const [choices, setChoices] = useState<RouterChoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [interfaces, setInterfaces] = useState<
    Record<string, { values: string[]; error?: string }>
  >({});
  const [form, setForm] = useState<TripForm>(() => ({
    forward: [blankStep()],
    reverse: [],
    mirror: true,
    src: "",
    dst: "",
    protocol: "tcp",
    srcPort: "49152",
    dstPort: "443",
    maxAge: 900,
    maxSkew: 120,
  }));
  const [result, setResult] = useState<RoundTripResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // The open provenance row belongs to one result; a new result closes it.
  const [openAt, setOpenAt] = useState<{ of: RoundTripResult; i: number } | null>(null);
  const openRow = openAt && openAt.of === result ? openAt.i : null;
  const setOpenRow = (i: number | null): void =>
    setOpenAt(i == null || !result ? null : { of: result, i });
  const alive = useRef(true),
    loadId = useRef(0);
  const update = (patch: Partial<TripForm>): void => {
    setForm((f) => ({ ...f, ...patch }));
    setResult(null);
    setError("");
  };
  async function load(): Promise<void> {
    const id = ++loadId.current;
    setLoading(true);
    setLoadError("");
    setResult(null);
    try {
      const data = await api<{ devices: RouterChoice[] }>("/api/round-trip/options");
      if (!Array.isArray(data.devices)) throw new Error("Invalid response");
      if (alive.current && id === loadId.current) setChoices(data.devices);
    } catch {
      if (alive.current && id === loadId.current)
        setLoadError(
          "Could not load saved configurations. Retry, or reload the upgraded server if this page was just updated.",
        );
    } finally {
      if (alive.current && id === loadId.current) setLoading(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    // Defer initial refresh so loading state is not synchronously reset by the effect.
    void Promise.resolve().then(() => {
      if (alive.current) return load();
    });
    return () => {
      alive.current = false;
    };
  }, []);
  async function loadInterfaces(device: string, id: string): Promise<void> {
    const key = `${device}/${id}`;
    if (!id || interfaces[key]?.values.length) return;
    try {
      const data = await api<{ interfaces: string[] }>(
        `/api/round-trip/options?device=${encodeURIComponent(device)}&id=${encodeURIComponent(id)}`,
      );
      if (!Array.isArray(data.interfaces)) throw new Error("Invalid response");
      if (alive.current) setInterfaces((all) => ({ ...all, [key]: { values: data.interfaces } }));
    } catch {
      if (alive.current)
        setInterfaces((all) => ({
          ...all,
          [key]: {
            values: [],
            error: "Could not load interface choices. Select another capture and retry.",
          },
        }));
    }
  }
  function stepChange(
    direction: "forward" | "reverse",
    key: string,
    patch: Partial<PathStep>,
  ): void {
    update({ [direction]: form[direction].map((s) => (s.key === key ? { ...s, ...patch } : s)) });
  }
  function move(direction: "forward" | "reverse", at: number, delta: number): void {
    const steps = [...form[direction]];
    [steps[at], steps[at + delta]] = [steps[at + delta], steps[at]];
    update({ [direction]: steps });
  }
  function editor(direction: "forward" | "reverse"): ReactNode {
    const steps = form[direction];
    return (
      <div className="rt-hops">
        <div className="monitor-thead rt-hop-grid" aria-hidden="true">
          <span>#</span>
          <span>Router</span>
          <span>Saved configuration</span>
          <span>Entry · where it arrives</span>
          <span>Exit · where it leaves</span>
          <span />
        </div>
        {steps.map((s, i) => {
          const snaps = choices.find((c) => c.device === s.device)?.snapshots ?? [];
          const snapshot = snaps.find((c) => c.id === s.snapshotId);
          const list = interfaces[`${s.device}/${s.snapshotId}`];
          const placeholder = !s.snapshotId
            ? "Choose a saved configuration first"
            : !list
              ? "Loading interfaces…"
              : "Select an interface";
          const opts = (list?.values ?? []).map((name) => ({ value: name, label: name }));
          const n = i + 1;
          const notes: ReactNode[] = [];
          if (s.device && !snaps.length)
            notes.push(
              <span key="none" className="text-warning">
                Capture a configuration for this router in{" "}
                <a href="#snapshots" className="underline">
                  Snapshots
                </a>
                , then refresh choices here.
              </span>,
            );
          if (snapshot && Date.now() - snapshot.ts > form.maxAge * 1000)
            notes.push(
              <span key="old" className="text-warning">
                This capture is older than the allowed age. Choose a fresh capture or raise the
                maximum snapshot age.
              </span>,
            );
          if (list?.error)
            notes.push(
              <span key="err" role="alert" className="text-destructive">
                {list.error}
              </span>,
            );
          if (list && !list.error && !list.values.length)
            notes.push(
              <span key="empty" className="text-warning">
                No usable interfaces in this capture. Choose another snapshot.
              </span>,
            );
          return (
            <div
              key={s.key}
              className="monitor-row rt-hop-grid"
              role="group"
              aria-label={`${direction === "forward" ? "Outbound" : "Return"} router ${n}`}
            >
              <span className="monitor-chip justify-self-start">{n}</span>
              <FormSelect
                mono
                label={`Router ${n}`}
                placeholder="Select a router"
                disabled={busy}
                value={s.device}
                options={choices.map((c) => ({ value: c.device, label: c.device }))}
                onChange={(device) =>
                  stepChange(direction, s.key, {
                    device,
                    snapshotId: "",
                    ingress: "",
                    egress: "",
                  })
                }
              />
              <FormSelect
                label={`Saved configuration for router ${n}`}
                placeholder={snaps.length ? "Select a capture date" : "No saved configurations"}
                disabled={busy || !s.device}
                value={s.snapshotId}
                options={snaps.map((c) => ({
                  value: c.id,
                  label: `${c.label || "Configuration"} · ${when(c.ts)}`,
                }))}
                onChange={(snapshotId) => {
                  stepChange(direction, s.key, { snapshotId, ingress: "", egress: "" });
                  void loadInterfaces(s.device, snapshotId);
                }}
              />
              <FormSelect
                mono
                label={`Entry interface for router ${n}`}
                placeholder={placeholder}
                disabled={busy || !list?.values.length}
                value={s.ingress}
                options={opts}
                onChange={(ingress) => stepChange(direction, s.key, { ingress })}
              />
              <FormSelect
                mono
                label={`Exit interface for router ${n}`}
                placeholder={placeholder}
                disabled={busy || !list?.values.length}
                value={s.egress}
                options={opts}
                onChange={(egress) => stepChange(direction, s.key, { egress })}
              />
              <span className="flex gap-0.5">
                <MonitorButton
                  size="sm"
                  variant="ghost"
                  icon={<ChevronUp aria-hidden="true" />}
                  aria-label={`Move ${direction} router ${n} earlier`}
                  disabled={busy || i === 0}
                  onClick={() => move(direction, i, -1)}
                />
                <MonitorButton
                  size="sm"
                  variant="ghost"
                  icon={<ChevronDown aria-hidden="true" />}
                  aria-label={`Move ${direction} router ${n} later`}
                  disabled={busy || i === steps.length - 1}
                  onClick={() => move(direction, i, 1)}
                />
                <MonitorButton
                  size="sm"
                  variant="ghost"
                  icon={<X aria-hidden="true" />}
                  aria-label={`Remove ${direction} router ${n}`}
                  disabled={busy || steps.length === 1}
                  onClick={() => update({ [direction]: steps.filter((h) => h.key !== s.key) })}
                />
              </span>
              {notes.length > 0 && <div className="rt-hop-notes">{notes}</div>}
            </div>
          );
        })}
        <div className="monitor-foot">
          <MonitorButton
            size="sm"
            icon={<Plus aria-hidden="true" />}
            disabled={busy || steps.length >= 8}
            onClick={() => update({ [direction]: [...steps, blankStep()] })}
          >
            Add another router
          </MonitorButton>
          <span>
            {direction === "forward"
              ? "Start at the client-side router. You declare the links; the lab does not discover physical connections."
              : "Start at the destination-side router and end at the client side."}
          </span>
        </div>
      </div>
    );
  }
  async function analyze(): Promise<void> {
    if (busy) return;
    setError("");
    setResult(null);
    try {
      const input = buildTripInput(form, choices);
      for (const s of [...form.forward, ...(form.mirror ? [] : form.reverse)]) {
        const names = interfaces[`${s.device}/${s.snapshotId}`]?.values;
        if (!names?.includes(s.ingress) || !names.includes(s.egress))
          throw new Error(
            `${s.device}: select entry and exit interfaces from the chosen saved configuration.`,
          );
      }
      setBusy(true);
      const response = await postJson<RoundTripResult & { error?: string }>(
        `/api/round-trip?device=${encodeURIComponent(input.forward[0].device)}`,
        input,
      );
      if (response.error || !response.provenance)
        throw new Error(response.error ?? "No analysis returned");
      if (alive.current) setResult(response);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : "Path analysis failed");
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  if (loading && !choices.length && !loadError)
    return <LoadingState label="Loading saved router configurations" layout="form" />;

  const captured = result?.provenance.map((p) => p.capturedAt) ?? [];
  const gap = captured.length
    ? Math.round((Math.max(...captured) - Math.min(...captured)) / 1000)
    : 0;
  const provenanceNote =
    captured.length < 2
      ? "One saved configuration."
      : `${gap} seconds apart, ${gap <= form.maxSkew ? "inside" : "over"} the ${form.maxSkew}-second limit.`;
  const opened = openRow != null ? result?.provenance[openRow] : undefined;
  const openSnapshots = (): void => {
    window.location.hash = "snapshots";
  };

  return (
    <div className="rt-page">
      <PageIntro
        eyebrow="Round-trip lab · configuration rehearsal"
        verdict="Can the reply find its way back?"
        lead="A connection needs two paths: the request to the destination and the reply to the client. Compare routing and firewall decisions in saved configurations, without sending traffic or changing your network."
        actions={
          <div className="flex flex-wrap gap-2">
            <StatusBadge tone="good">No router changes</StatusBadge>
            <StatusBadge dot={false}>Saved configuration only</StatusBadge>
            <StatusBadge dot={false}>Not a live VPN or connectivity test</StatusBadge>
          </div>
        }
        aside={
          <div className="glass flex flex-col gap-2.5 px-[18px] py-4">
            <b className="flex items-center gap-2 text-[13px] leading-[21px] font-bold text-foreground">
              <CircleHelp aria-hidden="true" className="size-[15px]" />
              When should I use this?
            </b>
            {[
              "Find why a request passes but its reply might be blocked.",
              "Check the expected path between a branch and a server network.",
              "Compare outbound and return paths before you change anything.",
            ].map((t) => (
              <span key={t} className="flex gap-2 text-[13px] leading-[19px] text-fg-secondary">
                <Check aria-hidden="true" className="mt-0.5 size-[14px] flex-none text-success" />
                {t}
              </span>
            ))}
          </div>
        }
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void analyze();
        }}
      >
        <fieldset disabled={busy} className="rt-stack">
          <legend className="sr-only">Connection and routers</legend>
          <MonitorPanel
            title="1 · The connection"
            description="Use the IPs you want to model. No JSON or snapshot IDs needed."
          >
            <div className="rt-conn" data-icmp={form.protocol === "icmp" || undefined}>
              <FormField label="Client IPv4">
                <TextInput
                  required
                  mono
                  label="Client IPv4"
                  placeholder="192.168.88.20"
                  value={form.src}
                  onChange={(src) => update({ src })}
                />
              </FormField>
              <FormField label="Destination IPv4">
                <TextInput
                  required
                  mono
                  label="Destination IPv4"
                  placeholder="10.20.0.10"
                  value={form.dst}
                  onChange={(dst) => update({ dst })}
                />
              </FormField>
              <FormField label="Connection type" group>
                <Segmented
                  label="Connection type"
                  value={form.protocol}
                  options={[
                    { value: "tcp", label: "TCP" },
                    { value: "udp", label: "UDP" },
                    { value: "icmp", label: "ICMP" },
                  ]}
                  onChange={(protocol) => update({ protocol })}
                />
              </FormField>
              {form.protocol !== "icmp" && (
                <>
                  <FormField label="Destination port" group>
                    <NumberInput
                      label="Destination port"
                      allowEmpty
                      min={1}
                      max={65535}
                      value={form.dstPort === "" ? null : Number(form.dstPort)}
                      onChange={(n) => update({ dstPort: n == null ? "" : String(n) })}
                    />
                  </FormField>
                  <FormField label="Client source port" group>
                    <NumberInput
                      label="Client source port"
                      allowEmpty
                      min={1}
                      max={65535}
                      value={form.srcPort === "" ? null : Number(form.srcPort)}
                      onChange={(n) => update({ srcPort: n == null ? "" : String(n) })}
                    />
                  </FormField>
                </>
              )}
            </div>
          </MonitorPanel>

          <MonitorPanel
            title="2 · Outbound routers, in order"
            flush
            extra={
              <MonitorButton
                size="sm"
                variant="ghost"
                icon={<RefreshCw aria-hidden="true" />}
                disabled={busy || loading}
                onClick={() => void load()}
              >
                {loading ? "Loading…" : "Refresh choices"}
              </MonitorButton>
            }
          >
            {(loadError || (!loading && !choices.length)) && (
              <div className="px-[18px] pb-3">
                {loadError ? (
                  <MonitorNote tone="bad" role="alert">
                    {loadError}
                  </MonitorNote>
                ) : (
                  <MonitorNote tone="warn">
                    No accessible router choices. Check access scope and saved configurations.
                  </MonitorNote>
                )}
              </div>
            )}
            {editor("forward")}
          </MonitorPanel>

          <MonitorPanel
            title="3 · The return path"
            description="Defaults: captures no older than 15 minutes, at most 2 minutes apart. NAT, unsupported features or incomplete evidence can block a conclusion."
          >
            <div className="rt-return">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex">
                  <MonitorSwitch
                    label="Assume the reply follows the same routers in reverse"
                    checked={form.mirror}
                    disabled={busy}
                    onChange={(mirror) =>
                      update({
                        mirror,
                        reverse: mirror ? form.reverse : returnSteps(form.forward),
                      })
                    }
                  />
                </span>
                <span className="text-[13px] text-foreground">
                  Assume the reply follows the same routers in reverse
                  <span className="monitor-hint block">
                    Entry and exit swap automatically. A test assumption, not a discovery.
                  </span>
                </span>
              </div>
              <FormField label="Maximum snapshot age · seconds" group>
                <NumberInput
                  label="Maximum snapshot age · seconds"
                  min={1}
                  max={86400}
                  value={form.maxAge}
                  onChange={(n) => update({ maxAge: n ?? 1 })}
                />
              </FormField>
              <FormField label="Maximum capture gap · seconds" group>
                <NumberInput
                  label="Maximum capture gap · seconds"
                  min={0}
                  max={3600}
                  value={form.maxSkew}
                  onChange={(n) => update({ maxSkew: n ?? 0 })}
                />
              </FormField>
              <MonitorButton
                type="submit"
                variant="primary"
                icon={<Route aria-hidden="true" />}
                disabled={busy || loading || Boolean(loadError) || !choices.length}
              >
                {busy ? "Checking saved configurations…" : "Check both directions"}
              </MonitorButton>
            </div>
            {!form.mirror && (
              <div className="rt-reverse">
                <p className="monitor-label px-[18px] pb-2">Return routers, in order</p>
                {editor("reverse")}
              </div>
            )}
          </MonitorPanel>
        </fieldset>
      </form>
      {error && (
        <MonitorNote tone="bad" role="alert">
          {error}
        </MonitorNote>
      )}
      {result && (
        <div className="rt-stack" aria-live="polite">
          <section className="glass flex flex-col gap-3 px-5 py-[18px]" aria-label="Result">
            <div className="rt-result-head">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className={`monitor-eyebrow ${TEXT[result.status]}`}>Result</p>
                <h2 className="rt-verdict">
                  {legSentence("request", result.forward)} {legSentence("reply", result.reverse)}
                </h2>
                <span className="monitor-hint text-[13px]">
                  Declared paths are {result.asymmetric ? "different" : "mirrored"}. Live delivery
                  remains unverified.
                </span>
              </div>
              <StatusBadge tone={TONE[result.status]}>{PATH_LABEL[result.status]}</StatusBadge>
            </div>
            <RoundTripLanes
              client={form.src}
              destination={form.dst}
              forward={result.forward}
              reverse={result.reverse}
            />
            <details className="rt-details border-t border-line pt-2.5">
              <summary className="text-[13px] text-fg-secondary">
                <ChevronRight aria-hidden="true" className="size-[14px]" />
                What this result assumes · {result.assumptions.length}{" "}
                {result.assumptions.length === 1 ? "assumption" : "assumptions"}
              </summary>
              <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-9 text-[13px] text-fg-secondary">
                {result.assumptions.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </details>
          </section>
          <div className="rt-legs">
            <Leg title="Request → destination" leg={result.forward} />
            <Leg title="Reply → client" leg={result.reverse} />
          </div>
          <MonitorPanel title="Saved configurations used" description={provenanceNote} flush>
            <div className="overflow-x-auto">
              <table className="rt-table">
                <thead>
                  <tr className="monitor-thead">
                    {["Router", "Captured", "Snapshot", "SHA"].map((h) => (
                      <th scope="col" key={h}>
                        {h}
                      </th>
                    ))}
                    <th scope="col" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {result.provenance.map((p, i) => (
                    <RowMenu
                      key={p.device}
                      title={p.device}
                      sub={`Captured ${when(p.capturedAt, true)}`}
                      onOpen={() => setOpenRow(i)}
                      opens={[{ label: "Open Snapshots", onSelect: openSnapshots }]}
                      cells={{
                        device: { value: p.device, kind: "router" },
                        captured: { value: when(p.capturedAt, true), kind: "time" },
                        snapshot: { value: p.snapshotId, kind: "id" },
                        sha: { value: p.sha, kind: "id" },
                      }}
                      copies={[
                        { label: "Snapshot ID", value: p.snapshotId },
                        { label: "SHA", value: p.sha },
                      ]}
                      row={p}
                    >
                      <tr
                        className="monitor-row"
                        tabIndex={0}
                        aria-label={`${p.device}, captured ${when(p.capturedAt, true)}`}
                        data-selected={openRow === i || undefined}
                        onClick={() => setOpenRow(i)}
                        onKeyDown={(ev) => {
                          if (ev.key === "Enter") {
                            ev.preventDefault();
                            setOpenRow(i);
                          }
                        }}
                      >
                        <th
                          scope="row"
                          data-col="device"
                          className="p truncate font-mono text-[12px]"
                        >
                          {p.device}
                        </th>
                        <td
                          data-col="captured"
                          className="truncate font-mono text-[12px] text-muted-foreground"
                        >
                          {when(p.capturedAt, true)}
                        </td>
                        <td data-col="snapshot" className="truncate font-mono text-[12px]">
                          {p.snapshotId}
                        </td>
                        <td
                          data-col="sha"
                          className="truncate font-mono text-[12px] text-muted-foreground"
                        >
                          {p.sha.length > 10 ? `${p.sha.slice(0, 4)}…${p.sha.slice(-4)}` : p.sha}
                        </td>
                        <td>
                          <RowMore />
                        </td>
                      </tr>
                    </RowMenu>
                  ))}
                </tbody>
              </table>
            </div>
          </MonitorPanel>
          {opened && (
            <RowDrawer
              open
              onClose={() => setOpenRow(null)}
              label={`Saved configuration: ${opened.device}`}
              storageKey="round-trip"
              rowKey={opened.device}
              nav={{
                index: openRow!,
                total: result.provenance.length,
                onPrev: openRow! > 0 ? () => setOpenRow(openRow! - 1) : undefined,
                onNext:
                  openRow! < result.provenance.length - 1
                    ? () => setOpenRow(openRow! + 1)
                    : undefined,
              }}
              title={opened.device}
              meta={`Captured ${when(opened.capturedAt, true)}`}
              primary={
                <MonitorButton size="sm" onClick={openSnapshots}>
                  Open Snapshots
                </MonitorButton>
              }
            >
              <DetailList
                items={[
                  { label: "Router", value: opened.device, mono: true },
                  { label: "Captured", value: when(opened.capturedAt, true), mono: true },
                  { label: "Snapshot", value: opened.snapshotId, mono: true },
                  {
                    label: "SHA",
                    value: <span className="break-all">{opened.sha}</span>,
                    mono: true,
                  },
                ]}
              />
              <MonitorNote>{provenanceNote}</MonitorNote>
            </RowDrawer>
          )}
        </div>
      )}
    </div>
  );
}
