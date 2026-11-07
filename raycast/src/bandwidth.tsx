import {
  Action,
  ActionPanel,
  Color,
  Detail,
  Form,
  Icon,
  List,
  confirmAlert,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { randomUUID } from "node:crypto";
import { useState } from "react";
import { api, postJson } from "./lib/api";
import { useApi, usePolling } from "./lib/hooks";
import { showFailureToast, confirmDestructive } from "./lib/confirm";
import { barChart, chartImage, multiAreaChart } from "./lib/charts";
import {
  cell,
  impact,
  mbps,
  measurement,
  validateJob,
  comparisonRuns,
  summarizeRuns,
} from "./lib/bandwidth";
import type {
  BandwidthJob,
  BandwidthPreflight,
  BandwidthState,
  JobInput,
} from "./lib/bandwidth";

/** Reject structured errors, including non-2xx JSON returned by postJson. */
async function post<T>(action: string, body: unknown): Promise<T> {
  const result = await postJson<T & { error?: string }>(
    `/api/bandwidth/${action}`,
    body,
  );
  if (!result || result.error || Object.keys(result).length === 0)
    throw new Error(result?.error || "Dashboard returned an empty response");
  return result;
}
/** Read stored measurements only; opening this report never queries a router. */
function Results({ jobId }: { jobId?: string }) {
  const { data, error, isLoading, revalidate } =
    useApi<BandwidthState>("/api/bandwidth");
  usePolling(revalidate, 5000);
  const [selection, setSelection] = useState<{
    ids: string[];
    from: number;
    to: number;
  }>();
  const ids = selection?.ids ?? (jobId ? [jobId] : []);
  const from = selection?.from ?? 0;
  const to = selection?.to ?? Infinity;
  const runs = comparisonRuns(data?.runs ?? [], ids, from, to);
  const jobs = [
    ...new Map([
      ...(data?.runs ?? []).map((r) => [r.job.id, r.job] as const),
      ...(data?.jobs ?? []).map((j) => [j.id, j] as const),
    ]).values(),
  ];
  const summaries = ids.map((id) => ({
    id,
    name: jobs.find((j) => j.id === id)?.name ?? id,
    ...summarizeRuns(runs.filter((r) => r.job.id === id)),
  }));
  const formatStats = (stats: ReturnType<typeof summarizeRuns>["tx"]) =>
    stats
      ? `${stats.min.toFixed(2)} / ${stats.mean.toFixed(2)} / ${stats.max.toFixed(2)} (n=${stats.count})`
      : "—";
  const chart =
    ids.length === 1
      ? multiAreaChart([
          {
            label: "TX Mbps",
            color: Color.Blue,
            values: runs.map((r) => measurement(r, "txBps")),
          },
          {
            label: "RX Mbps",
            color: Color.Green,
            values: runs.map((r) => measurement(r, "rxBps")),
          },
        ])
      : barChart(
          summaries.flatMap((summary) => [
            ...(summary.tx
              ? [
                  {
                    label: `${summary.name} TX mean`,
                    value: summary.tx.mean,
                    color: Color.Blue,
                  },
                ]
              : []),
            ...(summary.rx
              ? [
                  {
                    label: `${summary.name} RX mean`,
                    value: summary.rx.mean,
                    color: Color.Green,
                  },
                ]
              : []),
          ]),
          { unit: " Mbps" },
        );
  const md = error
    ? `# Cannot load history\n\n${cell(error.message)}`
    : `# ${ids.length === 1 ? "Tunnel history" : "Cross-job comparison"}\n\n${impact}\n\n${runs.length && chart ? chartImage(chart, "Throughput in Mbps") : "No measurements in this selection. Use Select Jobs and Time Range to choose stored history."}\n\n${ids.length === 1 ? "Samples ordered oldest to newest; TX/RX are from the source router." : "Mean successful throughput per selected job. Protocol, direction, caps and test times may differ."}\n\nRange (run start): ${from === 0 ? "Beginning of retained history" : new Date(from).toLocaleString()} → ${to === Infinity ? "Latest retained history" : new Date(to).toLocaleString()}\n\n| Job | Success | Failed | Interrupted | Running | TX min / mean / max Mbps | RX min / mean / max Mbps |\n|---|---:|---:|---:|---:|---|---|\n${summaries.map((r) => `| ${cell(r.name)} | ${r.success} | ${r.failed} | ${r.interrupted} | ${r.running} | ${formatStats(r.tx)} | ${formatStats(r.rx)} |`).join("\n")}\n\n| Job | Started | Status | Protocol / direction | Caps local / remote bps | TX Mbps | RX Mbps | Lost packets | Result |\n|---|---|---|---|---:|---:|---:|---:|---|\n${[
        ...runs,
      ]
        .reverse()
        .map(
          (r) =>
            `| ${cell(r.job.name)} | ${cell(new Date(r.startedAt).toLocaleString())} | ${r.status} | ${r.job.protocol} / ${r.job.direction} | ${r.job.localTxBps} / ${r.job.remoteTxBps} | ${r.status === "ok" ? mbps(r.txBps) : "—"} | ${r.status === "ok" ? mbps(r.rxBps) : "—"} | ${r.lostPackets ?? "—"} | ${cell(r.message)} |`,
        )
        .join("\n")}`;
  return (
    <Detail
      navigationTitle="Bandwidth Results"
      isLoading={isLoading}
      markdown={md}
      actions={
        <ActionPanel>
          <Action.Push
            title="Select Jobs and Time Range"
            target={
              <ComparisonForm
                jobs={jobs}
                ids={ids}
                from={from}
                to={to}
                onApply={setSelection}
              />
            }
          />
          <Action title="Refresh History" onAction={revalidate} />
        </ActionPanel>
      }
    />
  );
}
/** Choose explicit jobs and optional inclusive date boundaries for the native report. */
function ComparisonForm({
  jobs,
  ids,
  from,
  to,
  onApply,
}: {
  jobs: BandwidthJob[];
  ids: string[];
  from: number;
  to: number;
  onApply: (selection: { ids: string[]; from: number; to: number }) => void;
}) {
  const { pop } = useNavigation();
  return (
    <Form
      navigationTitle="Compare Stored Bandwidth"
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Apply Comparison"
            onSubmit={async (values: {
              jobs: string[];
              from: Date | null;
              to: Date | null;
            }) => {
              const start = values.from?.getTime() ?? 0;
              const end = values.to?.getTime() ?? Infinity;
              if (!values.jobs.length || start > end) {
                await showFailureToast(
                  new Error(
                    "Select at least one job and an end time at or after the start.",
                  ),
                  { title: "Invalid comparison" },
                );
                return;
              }
              onApply({ ids: values.jobs, from: start, to: end });
              pop();
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TagPicker id="jobs" title="Jobs" defaultValue={ids}>
        {jobs.map((job) => (
          <Form.TagPicker.Item key={job.id} value={job.id} title={job.name} />
        ))}
      </Form.TagPicker>
      <Form.DatePicker
        id="from"
        title="Started At or After"
        defaultValue={from ? new Date(from) : null}
      />
      <Form.DatePicker
        id="to"
        title="Started At or Before"
        defaultValue={Number.isFinite(to) ? new Date(to) : null}
      />
      <Form.Description text="Empty dates include all retained history. Statistics use successful measurements only; unavailable directions are excluded, and zero is a valid measurement." />
    </Form>
  );
}
/** Edit one tunnel definition without persisting credentials or querying a router. */
function JobForm({
  job,
  devices,
  refresh,
}: {
  job?: BandwidthJob;
  devices: string[];
  refresh: () => void;
}) {
  const { pop, push } = useNavigation();
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState(job?.source ?? devices[0] ?? "");
  const [options, setOptions] = useState<
    { interface: string; address: string }[]
  >([]);
  const [sourceInterface, setInterface] = useState(job?.sourceInterface ?? "");
  const [sourceAddress, setAddress] = useState(job?.sourceAddress ?? "");
  /** Use the same validated form values for saving and explicit read-only preflight. */
  async function submit(
    values: Record<string, string | boolean>,
    preflight: boolean,
  ) {
    if (busy) return;
    setBusy(true);
    try {
      const input: JobInput = {
        id: job?.id ?? randomUUID(),
        name: String(values.name).trim(),
        source,
        destination: String(values.destination),
        sourceInterface: sourceInterface.trim(),
        sourceAddress: sourceAddress.trim(),
        destinationAddress: String(values.destinationAddress).trim(),
        protocol: values.protocol as JobInput["protocol"],
        direction: values.direction as JobInput["direction"],
        localUdpTxSize: Number(values.localUdpTxSize),
        remoteUdpTxSize: Number(values.remoteUdpTxSize),
        randomData: values.randomData === true,
        connectionCount: Number(values.connectionCount),
        reportIntervalSeconds: Number(values.reportIntervalSeconds),
        durationSeconds: Number(values.durationSeconds),
        intervalSeconds: Number(values.intervalSeconds),
        localTxBps: Number(values.localTxBps),
        remoteTxBps: Number(values.remoteTxBps),
        enabled: values.enabled === true,
      };
      validateJob(input);
      if (preflight) {
        const result = await post<BandwidthPreflight>("preflight", {
          job: input,
        });
        if (!Array.isArray(result.checks))
          throw new Error("Invalid preflight response");
        push(
          <Detail
            markdown={`# Preflight: ${result.ready ? "Ready" : "Not ready"}\n\n${cell(result.warning)}\n\nRead-only checks; no bandwidth traffic was started.\n\n| Check | Status | Detail |\n|---|---|---|\n${result.checks.map((c) => `| ${cell(c.name)} | ${c.ok ? "Pass" : "Fail"} | ${cell(c.message)} |`).join("\n")}`}
          />,
        );
      } else {
        if (
          input.enabled &&
          !(await confirmAlert({
            title: "Enable scheduled traffic?",
            message: impact,
            primaryAction: { title: "Save and Enable" },
          }))
        )
          return;
        await post("save", { job: input, acknowledgeImpact: true });
        refresh();
        pop();
      }
    } catch (error) {
      await showFailureToast(error, { title: "Bandwidth request failed" });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Form
      isLoading={busy}
      navigationTitle={job ? "Edit Tunnel" : "Create Tunnel"}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Save Tunnel"
            onSubmit={(v) => submit(v, false)}
          />
          <Action.SubmitForm
            title="Read-Only Preflight"
            onSubmit={(v) => submit(v, true)}
          />
          <Action
            title="Load Source Addresses (Live Read)"
            onAction={async () => {
              if (busy || !source) return;
              setBusy(true);
              try {
                const result = await api<{
                  addresses: typeof options;
                  error?: string;
                }>(
                  `/api/bandwidth/options?device=${encodeURIComponent(source)}`,
                );
                if (result.error || !Array.isArray(result.addresses))
                  throw new Error(result.error || "Invalid address response");
                setOptions(result.addresses);
                await showToast({
                  style: Toast.Style.Success,
                  title: `${result.addresses.length} source addresses loaded`,
                });
              } catch (error) {
                await showFailureToast(error, {
                  title: "Cannot load source addresses",
                });
              } finally {
                setBusy(false);
              }
            }}
          />
        </ActionPanel>
      }
    >
      <Form.Description title="Traffic impact" text={impact} />
      <Form.TextField id="name" title="Tunnel Name" defaultValue={job?.name} />
      <Form.Dropdown
        id="source"
        title="Source Router"
        value={source}
        onChange={(v) => {
          setSource(v);
          setOptions([]);
          setInterface("");
          setAddress("");
        }}
      >
        {devices.map((d) => (
          <Form.Dropdown.Item key={d} value={d} title={d} />
        ))}
      </Form.Dropdown>
      <Form.Dropdown
        id="destination"
        title="Destination Router (Runtime Credentials)"
        defaultValue={job?.destination}
      >
        {devices.map((d) => (
          <Form.Dropdown.Item key={d} value={d} title={d} />
        ))}
      </Form.Dropdown>
      {options.length > 0 && (
        <Form.Dropdown
          id="addressOption"
          title="Discovered Source Expectations"
          defaultValue=""
          onChange={(v) => {
            const option = options[Number(v)];
            if (v && option) {
              setInterface(option.interface);
              setAddress(option.address.split("/")[0]);
            }
          }}
        >
          <Form.Dropdown.Item value="" title="Choose an address…" />
          {options.map((o, i) => (
            <Form.Dropdown.Item
              key={i}
              value={String(i)}
              title={`${o.interface}: ${o.address}`}
            />
          ))}
        </Form.Dropdown>
      )}
      <Form.TextField
        id="sourceInterface"
        title="Expected Source Interface"
        value={sourceInterface}
        onChange={setInterface}
      />
      <Form.TextField
        id="sourceAddress"
        title="Expected Source IPv4"
        value={sourceAddress}
        onChange={setAddress}
      />
      <Form.Description text="Source interface/address are preflight expectations, not source binding. No local-address parameter is emitted." />
      <Form.TextField
        id="destinationAddress"
        title="Destination Tunnel IPv4"
        defaultValue={job?.destinationAddress}
      />
      <Form.Dropdown
        id="protocol"
        title="Protocol"
        defaultValue={job?.protocol ?? "tcp"}
      >
        {["tcp", "udp"].map((v) => (
          <Form.Dropdown.Item key={v} value={v} title={v.toUpperCase()} />
        ))}
      </Form.Dropdown>
      <Form.Dropdown
        id="direction"
        title="Direction (From Source)"
        defaultValue={job?.direction ?? "both"}
      >
        {["transmit", "receive", "both"].map((v) => (
          <Form.Dropdown.Item key={v} value={v} title={v} />
        ))}
      </Form.Dropdown>
      <Form.TextField
        id="durationSeconds"
        title="Duration (5–60 Seconds)"
        defaultValue={String(job?.durationSeconds ?? 10)}
      />
      <Form.TextField
        id="intervalSeconds"
        title="Interval (300–604800 Seconds)"
        defaultValue={String(job?.intervalSeconds ?? 3600)}
      />
      <Form.TextField
        id="localTxBps"
        title="Local TX Cap (1–100000000000 Bits/Sec)"
        defaultValue={String(job?.localTxBps ?? 10000000)}
      />
      <Form.TextField
        id="remoteTxBps"
        title="Remote TX Cap (1–100000000000 Bits/Sec)"
        defaultValue={String(job?.remoteTxBps ?? 10000000)}
      />
      <Form.TextField
        id="localUdpTxSize"
        title="Local UDP Packet Size (28–64000 Bytes)"
        defaultValue={String(job?.localUdpTxSize ?? 1500)}
      />
      <Form.TextField
        id="remoteUdpTxSize"
        title="Remote UDP Packet Size (28–64000 Bytes)"
        defaultValue={String(job?.remoteUdpTxSize ?? 1500)}
      />
      <Form.TextField
        id="connectionCount"
        title="TCP Connections (1–255)"
        defaultValue={String(job?.connectionCount ?? 1)}
      />
      <Form.TextField
        id="reportIntervalSeconds"
        title="Report Interval (0.02–5 Seconds, Whole Milliseconds)"
        defaultValue={String(job?.reportIntervalSeconds ?? 1)}
      />
      <Form.Checkbox
        id="randomData"
        label="Use random data"
        defaultValue={job?.randomData ?? false}
      />
      <Form.Checkbox
        id="enabled"
        label="Enable scheduled tests"
        defaultValue={job?.enabled ?? false}
      />
    </Form>
  );
}
/** Manage multiple saved tunnel tests; polling reads host-side history only. */
export default function Bandwidth() {
  const { data, error, isLoading, revalidate } =
    useApi<BandwidthState>("/api/bandwidth");
  usePolling(revalidate, 5000);
  const [busy, setBusy] = useState(false);
  /** Serialize mutations and surface structured endpoint errors. */
  async function mutate(action: string, body: unknown) {
    if (busy) return;
    setBusy(true);
    try {
      await post(action, body);
      if (action === "run")
        await showToast({
          style: Toast.Style.Success,
          title: "Bandwidth test started",
          message: "View Results for live run status.",
        });
      await revalidate();
    } catch (error) {
      await showFailureToast(error, { title: "Bandwidth request failed" });
    } finally {
      setBusy(false);
    }
  }
  const common = (
    <>
      <Action.Push
        title="Create Tunnel"
        target={<JobForm devices={data?.devices ?? []} refresh={revalidate} />}
      />
      <Action.Push title="Compare Jobs and History" target={<Results />} />
      <Action title="Refresh Stored State" onAction={revalidate} />
    </>
  );
  return (
    <List
      isLoading={isLoading || busy}
      navigationTitle="Tunnel Bandwidth"
      searchBarPlaceholder="Search tunnel tests…"
      actions={<ActionPanel>{common}</ActionPanel>}
    >
      <List.EmptyView
        icon={Icon.Network}
        title={error ? "Cannot load bandwidth tests" : "No tunnel tests saved"}
        description={
          error
            ? error.message
            : "Create a disabled tunnel definition, preflight it, then explicitly run or enable it."
        }
        actions={<ActionPanel>{common}</ActionPanel>}
      />
      {error && (
        <List.Item
          title="Refresh failed"
          subtitle={error.message}
          icon={Icon.Warning}
          actions={<ActionPanel>{common}</ActionPanel>}
        />
      )}
      <List.Section
        title="Tunnel Tests"
        subtitle={
          data
            ? `Concurrency: ${data.concurrency} · history polls every 5 seconds`
            : undefined
        }
      >
        {(data?.jobs ?? []).map((job) => (
          <List.Item
            key={job.id}
            title={job.name}
            subtitle={`${job.source} → ${job.destinationAddress} · ${job.protocol} · ${job.direction}`}
            accessories={[
              {
                text: data?.runs.some(
                  (run) => run.job.id === job.id && run.status === "running",
                )
                  ? "Running"
                  : job.enabled
                    ? "Scheduled"
                    : "Disabled",
              },
              { text: `${job.durationSeconds}s / ${job.intervalSeconds}s` },
            ]}
            actions={
              <ActionPanel>
                <Action.Push
                  title="View Results"
                  target={<Results jobId={job.id} />}
                />
                <Action.Push
                  title="Edit Tunnel / Preflight"
                  target={
                    <JobForm
                      job={job}
                      devices={data?.devices ?? []}
                      refresh={revalidate}
                    />
                  }
                />
                <Action
                  title="Run Now…"
                  icon={Icon.Play}
                  onAction={async () => {
                    if (
                      !busy &&
                      (await confirmAlert({
                        title: `Run ${job.name}?`,
                        message: `${impact}\n${job.durationSeconds}s · ${job.protocol} · ${job.direction} · local ${job.localTxBps} / remote ${job.remoteTxBps} bits/sec`,
                        primaryAction: { title: "Generate Test Traffic" },
                      }))
                    )
                      await mutate("run", {
                        id: job.id,
                        acknowledgeImpact: true,
                      });
                  }}
                />
                <Action
                  title={job.enabled ? "Disable Schedule" : "Enable Schedule…"}
                  onAction={async () => {
                    if (
                      job.enabled ||
                      (await confirmAlert({
                        title: "Enable scheduled traffic?",
                        message: impact,
                        primaryAction: { title: "Enable" },
                      }))
                    ) {
                      const input = { ...job, nextRunAt: undefined };
                      await mutate("save", {
                        job: { ...input, enabled: !job.enabled },
                        acknowledgeImpact: true,
                      });
                    }
                  }}
                />
                <Action
                  title="Delete Definition…"
                  style={Action.Style.Destructive}
                  onAction={async () => {
                    if (
                      await confirmDestructive({
                        title: `Delete ${job.name}?`,
                        message:
                          "Removes this definition and schedule. Recorded history is retained.",
                      })
                    )
                      await mutate("delete", { id: job.id });
                  }}
                />
                {common}
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}
