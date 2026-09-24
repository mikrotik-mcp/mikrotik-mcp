import { executeMikrotikCommand } from "../core/connector";
import type { ToolContext } from "../core/context";
import { Cmd, isEmpty, looksLikeError } from "../core/routeros";
import { parseKeyValues, parseRecords, parseSize } from "../core/routeros-parse";
import { assertDeviceAccess } from "../core/scoped-access";
import { resolveDeviceName } from "../core/runtime";
import { diagnosisInput, compareInput, pingSample, recommendPath, enabled } from "./model";
import type { Diagnosis, Comparison, Row, Finding } from "./model";

export type Reader = typeof executeMikrotikCommand;
export async function checkedRead(
  command: string,
  ctx: ToolContext,
  read: Reader = executeMikrotikCommand,
): Promise<string> {
  const raw = await read(command, ctx, { maxMs: 8000 });
  if (looksLikeError(raw) || raw.length > 512_000)
    throw new Error(
      "Router rejected the command or returned too much data; its outcome was not confirmed.",
    );
  return raw;
}
export async function rows(
  path: string,
  fields: string,
  ctx: ToolContext,
  read: Reader = executeMikrotikCommand,
): Promise<Row[]> {
  const raw = await checkedRead(new Cmd(`${path} print detail without-paging`).build(), ctx, read);
  const result = parseRecords(raw).rows;
  if (
    (!result.length && !isEmpty(raw) && !/^\s*(?:Flags:.*)?\s*$/.test(raw)) ||
    result.length > 1000
  )
    throw new Error(`Cannot safely interpret ${path}.`);
  const keys = new Set(["#", "flags", ...fields.split(",")]);
  return result.map((row) =>
    Object.fromEntries(Object.entries(row).filter(([key]) => keys.has(key))),
  );
}
export async function diagnoseInternet(
  input: unknown,
  ctx: ToolContext,
  read: Reader = executeMikrotikCommand,
): Promise<Diagnosis> {
  const a = diagnosisInput.parse(input),
    device = resolveDeviceName(ctx.device);
  assertDeviceAccess([device], "diagnose_home_internet", "READ");
  const findings: Finding[] = [];
  const capture = async (area: string, work: () => Promise<Finding>) => {
    try {
      findings.push(await work());
    } catch {
      findings.push({
        area,
        state: "unknown",
        title: `${area} could not be measured`,
        detail:
          "The router query failed or is unsupported. Missing evidence is not a healthy result.",
        next: "Check permissions and device support, then retry.",
      });
    }
  };
  await capture("Router", async () => {
    const resource = parseKeyValues(await checkedRead("/system resource print", ctx, read));
    const cpu = Number(resource["cpu-load"]?.replace("%", ""));
    const free = parseSize(resource["free-memory"]),
      total = parseSize(resource["total-memory"]);
    if (!Number.isFinite(cpu) || !total || free === undefined) throw new Error("No resources");
    const memory = Math.round((1 - free / total) * 100),
      hot = cpu >= 85 || memory >= 90;
    return {
      area: "Router",
      state: hot ? "suspected" : "observed",
      title: hot
        ? "The router may be under pressure"
        : "Router resources have headroom in this sample",
      detail: `CPU ${cpu}% · memory ${memory}%. One sample does not establish a bottleneck.`,
      next: "Repeat while the slow download is running; compare with the Devices page.",
    };
  });
  await capture("DNS", async () => {
    const start = Date.now();
    const resolved = (
      await checkedRead(
        `:put [:resolve ${new Cmd("").set("domain-name", a.target).build().trim()}]`,
        ctx,
        read,
      )
    ).trim();
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(resolved)) throw new Error("Not an IPv4 result");
    return {
      area: "DNS",
      state: "observed",
      title: "The router resolved this destination",
      detail: `${a.target} → ${resolved}. Query plus SSH round trip: ${Date.now() - start} ms (not pure DNS latency).`,
      next: "If only one device is affected, compare its DNS and secure-DNS settings.",
    };
  });
  await capture("Internet", async () => {
    const result = pingSample(
      "main",
      await checkedRead(
        new Cmd("/ping").set("address", a.target).set("count", 5).set("interval", "200ms").build(),
        ctx,
        read,
      ),
    );
    if (result.state === "unknown") throw new Error("No ping");
    return {
      area: "Internet",
      state: result.loss! > 0 ? "suspected" : "observed",
      title: result.loss! > 0 ? "Some router probes did not return" : "All router probes returned",
      detail: `${result.loss}% loss · average RTT ${result.latency ?? "unknown"} ms. ICMP can be deprioritized; this does not locate a failing hop.`,
      next: "Compare paths below. Router probes do not test the client's firewall path or application.",
    };
  });
  await capture("Wi-Fi", async () => {
    const leases = await rows(
      "/ip dhcp-server lease",
      "address,mac-address,active-address",
      ctx,
      read,
    );
    const mac = leases.find((r) => r.address === a.client || r["active-address"] === a.client)?.[
      "mac-address"
    ];
    if (!mac) throw new Error("No attachment");
    let registrations: Row[];
    try {
      registrations = await rows(
        "/interface wifi registration-table",
        "mac-address,signal,tx-rate,rx-rate",
        ctx,
        read,
      );
    } catch {
      registrations = await rows(
        "/interface wireless registration-table",
        "mac-address,signal-strength,tx-rate,rx-rate",
        ctx,
        read,
      );
    }
    const entry = registrations.find((r) => r["mac-address"]?.toUpperCase() === mac.toUpperCase());
    const signal = Number.parseFloat(entry?.signal ?? entry?.["signal-strength"] ?? "");
    if (!entry || !Number.isFinite(signal)) throw new Error("No Wi-Fi measurement");
    return {
      area: "Wi-Fi",
      state: signal < -70 ? "suspected" : "observed",
      title:
        signal < -70
          ? "Weak Wi-Fi signal may be slowing this device"
          : "Wi-Fi signal is not weak in this sample",
      detail: `${signal} dBm · PHY transmit rate ${entry["tx-rate"] ?? "unknown"}. PHY rate is not download speed.`,
      next: "Move closer to the access point and compare; interference and airtime remain unmeasured.",
    };
  });
  await capture("Bandwidth", async () => {
    const queues = await rows("/queue simple", "name,target,max-limit,disabled", ctx, read);
    const matches = queues.filter(
      (q) =>
        enabled(q) && q.target?.split(",").some((t) => t === a.client || t === `${a.client}/32`),
    );
    return {
      area: "Bandwidth",
      state: matches.length ? "observed" : "unknown",
      title: matches.length
        ? "A per-device bandwidth policy exists"
        : "Available bandwidth has not been measured",
      detail: matches.length
        ? matches
            .map((q) => `${q.name}: upload/download ceiling ${q["max-limit"] ?? "unknown"}`)
            .join("; ")
        : "No exact per-device simple queue was found. Shared queues, link utilization, MTU and VPN throughput can still matter.",
      next: "Run an endpoint speed test before and during the problem. These checks do not download test files or change MTU.",
    };
  });
  return {
    device,
    client: a.client,
    target: a.target,
    at: Date.now(),
    applicationHealth: "unverified",
    findings,
  };
}

export async function comparePaths(
  input: unknown,
  ctx: ToolContext,
  read: Reader = executeMikrotikCommand,
): Promise<Comparison> {
  const a = compareInput.parse(input),
    device = resolveDeviceName(ctx.device);
  assertDeviceAccess([device], "compare_home_paths", "READ");
  const tables = await rows("/routing table", "name,fib,disabled", ctx, read);
  const names = [...new Set(a.tables)];
  if (
    names.some(
      (name) =>
        !tables.some((t) => t.name === name && enabled(t) && (t.fib === "yes" || t.fib === "true")),
    )
  )
    throw new Error("Choose an existing enabled FIB routing table.");
  const paths = [];
  for (const table of names) {
    try {
      paths.push(
        pingSample(
          table,
          await checkedRead(
            new Cmd("/ping")
              .set("address", a.target)
              .set("routing-table", table)
              .set("count", 5)
              .set("interval", "200ms")
              .build(),
            ctx,
            read,
          ),
        ),
      );
    } catch {
      paths.push(pingSample(table, ""));
    }
  }
  return {
    device,
    at: Date.now(),
    target: a.target,
    goal: a.goal,
    paths,
    recommended: recommendPath(paths, a.goal),
    explanation:
      a.goal === "download"
        ? "Download speed is not inferred from ping. Choose only after an endpoint throughput test."
        : "Lowest loss, then latency and RTT range in this small router sample. Not a guarantee of client performance; output mangle can affect router probes.",
  };
}
