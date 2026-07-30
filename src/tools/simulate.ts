/**
 * Simulator — trace a hypothetical packet through firewall and routing WITHOUT
 * touching the device.
 *
 * Every tool here is `READ` and none of them writes anything: the whole feature
 * is a prediction over a configuration snapshot. That prediction is also the
 * risk, so two rules run through all of it:
 *
 * 1. **An unmodelled construct on the path makes the verdict `UNKNOWN`.** Never
 *    `ACCEPT`. A confident wrong answer is worse than no answer, because people
 *    act on it (see `docs/tasks/08` §1).
 * 2. **Every step names its rule index and source line**, so a human can check
 *    the model's reasoning instead of trusting it.
 *
 * `connectionState` is DECLARED by the caller, not inferred: there is no
 * connection-tracking table here, and a question about an established connection
 * has to say so.
 */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { READ, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { looksLikeError } from "../core/routeros";
import { resolveDeviceName } from "../core/runtime";
import { buildModel } from "../sim/model";
import type { SimModel } from "../sim/model";
import { unreachableRules } from "../sim/firewall";
import type { SimPacket } from "../sim/firewall";
import { diffTraces, renderTrace, tracePacket } from "../sim/trace";
import { openSnapshotStore } from "../snapshots/store";
import { DEFAULT_SNAPSHOT_DB } from "../config";
import type { ToolContext } from "../core/context";

let storePromise: Promise<Awaited<ReturnType<typeof openSnapshotStore>>> | null = null;
function snapshots(): Promise<Awaited<ReturnType<typeof openSnapshotStore>>> {
  storePromise ??= openSnapshotStore(DEFAULT_SNAPSHOT_DB);
  return storePromise;
}

const packetSchema = {
  src_address: z.string().describe('Source IPv4 address, e.g. "192.168.88.50"'),
  dst_address: z.string().describe('Destination IPv4 address, e.g. "8.8.8.8"'),
  protocol: z.string().default("tcp").describe('"tcp", "udp", "icmp" or a protocol number'),
  src_port: z.coerce.number().int().min(0).max(65535).optional(),
  dst_port: z.coerce.number().int().min(0).max(65535).optional(),
  in_interface: z.string().describe("Interface the packet arrives on, e.g. `bridge`"),
  connection_state: z
    .enum(["new", "established", "related", "invalid"])
    .default("new")
    .describe("DECLARED, not inferred — this model has no connection-tracking table"),
  connection_mark: z.string().optional(),
};

/** One entry of a `simulate_suite` request. */
interface SuitePacket {
  name: string;
  src_address: string;
  dst_address: string;
  protocol: string;
  src_port?: number;
  dst_port?: number;
  in_interface: string;
  connection_state: "new" | "established" | "related" | "invalid";
  expect: "accept" | "drop" | "reject";
}

interface SuiteRow {
  name: string;
  expect: string;
  result: ReturnType<typeof tracePacket>;
  ok: boolean;
}

type PacketArgs = {
  src_address: string;
  dst_address: string;
  protocol: string;
  src_port?: number;
  dst_port?: number;
  in_interface: string;
  connection_state: "new" | "established" | "related" | "invalid";
  connection_mark?: string;
};

function toPacket(a: PacketArgs): SimPacket {
  return {
    srcAddress: a.src_address,
    dstAddress: a.dst_address,
    protocol: a.protocol,
    srcPort: a.src_port,
    dstPort: a.dst_port,
    inInterface: a.in_interface,
    connectionState: a.connection_state,
    connectionMark: a.connection_mark,
  };
}

/** Load the config to model: a stored snapshot, inline text, or the live device. */
async function loadConfig(
  ctx: ToolContext,
  opts: { snapshotId?: string; configText?: string },
): Promise<{ text: string; source: string } | { error: string }> {
  if (opts.configText !== undefined) return { text: opts.configText, source: "supplied text" };
  if (opts.snapshotId !== undefined) {
    const snapshot = (await snapshots()).get(opts.snapshotId);
    if (!snapshot) return { error: `No snapshot '${opts.snapshotId}'.` };
    return { text: snapshot.body, source: `snapshot ${snapshot.id} (${snapshot.device})` };
  }
  const device = resolveDeviceName(ctx.device);
  ctx.info(`[${device}] Capturing configuration for the simulator`);
  const body = await executeMikrotikCommand("/export terse", ctx);
  if (looksLikeError(body) || body.trim() === "") {
    return {
      error: `Failed to read the configuration from '${device}': ${body.trim() || "empty"}`,
    };
  }
  return { text: body, source: `live config of ${device}` };
}

/** The coverage note every result carries — what the model did NOT read. */
function coverage(model: SimModel): string {
  const kinds = new Map<string, number>();
  for (const u of model.unmodelled) kinds.set(u.what, (kinds.get(u.what) ?? 0) + 1);
  if (kinds.size === 0 && model.unparsedLines === 0) return "";
  const parts = [...kinds.entries()].map(([what, n]) => (n > 1 ? `${what} ×${n}` : what));
  if (model.unparsedLines > 0) parts.push(`${model.unparsedLines} unparsed line(s)`);
  return `\n\nCONFIG COVERAGE — constructs this model does not implement: ${parts.join(", ")}.\nA packet whose path crosses one of these is reported UNKNOWN.`;
}

const SCOPE_NOTE =
  " Models IPv4 filter/NAT/routing only: no raw table, no queues, no layer7, no IPv6, and no live " +
  "connection tracking (`connection_state` is declared by you, not inferred). Anything on the " +
  "path that is out of scope downgrades the verdict to UNKNOWN rather than guessing.";

export const simulateTools: ToolModule = [
  defineTool({
    name: "simulate_packet",
    title: "Simulate a Packet",
    annotations: READ,
    description:
      "Traces a hypothetical packet through the router's NAT, routing and firewall — WITHOUT " +
      "sending anything or changing anything. Answers 'would this get through, and which rule " +
      "decides?' before Safe Mode is ever opened. " +
      "Returns a step-by-step traversal naming each rule's chain, index and source line, so the " +
      "reasoning can be checked rather than trusted. " +
      `Reads a stored snapshot (\`snapshot_id\`), supplied text (\`config_text\`), or captures the live config with a read-only \`/export terse\`.${SCOPE_NOTE}`,
    inputSchema: {
      ...packetSchema,
      snapshot_id: z.string().optional().describe("Evaluate against a stored snapshot"),
      config_text: z.string().optional().describe("Evaluate against raw `/export` text"),
    },
    async handler(a, ctx) {
      const loaded = await loadConfig(ctx, {
        snapshotId: a.snapshot_id,
        configText: a.config_text,
      });
      if ("error" in loaded) return loaded.error;

      const model = buildModel(loaded.text);
      const result = tracePacket({ model, packet: toPacket(a) });
      return (
        `SIMULATION — ${loaded.source}\n` +
        `${a.src_address}${a.src_port ? `:${a.src_port}` : ""} → ${a.dst_address}${a.dst_port ? `:${a.dst_port}` : ""} ` +
        `${a.protocol} in=${a.in_interface} state=${a.connection_state}\n\n` +
        `${renderTrace(result)}${coverage(model)}`
      );
    },
  }),

  defineTool({
    name: "simulate_change",
    title: "Simulate a Config Change",
    annotations: READ,
    description:
      "Applies proposed configuration lines to a COPY of the config in memory, re-traces the same " +
      "packet, and reports whether the verdict changed and at which step the paths diverged. " +
      "This is the tool for 'would this rule break the VPN?' — pair it with plan_changes so a change " +
      `is evaluated before it is applied. Nothing is sent to any device: the change exists only inside this simulation.${SCOPE_NOTE}`,
    inputSchema: {
      ...packetSchema,
      changes: z
        .union([z.array(z.string()), z.string()])
        .describe("Proposed export lines, e.g. `/ip firewall filter` then `add action=drop ...`"),
      snapshot_id: z.string().optional(),
      config_text: z.string().optional(),
    },
    async handler(a, ctx) {
      const loaded = await loadConfig(ctx, {
        snapshotId: a.snapshot_id,
        configText: a.config_text,
      });
      if ("error" in loaded) return loaded.error;

      const changeText = (Array.isArray(a.changes) ? a.changes : a.changes.split("\n"))
        .map((l: string) => l.trim())
        .filter((l: string) => l !== "")
        .join("\n");
      if (changeText === "") return "No changes supplied.";

      const packet = toPacket(a);
      const before = tracePacket({ model: buildModel(loaded.text), packet });
      // Appending is how RouterOS itself applies an export fragment: new rules
      // land at the END of their chain, which is exactly where a mistake hides.
      const afterModel = buildModel(`${loaded.text}\n${changeText}\n`);
      const after = tracePacket({ model: afterModel, packet });
      const diff = diffTraces(before, after);

      return [
        `SIMULATED CHANGE — ${loaded.source}`,
        `packet: ${a.src_address} → ${a.dst_address} ${a.protocol}${a.dst_port ? `:${a.dst_port}` : ""} in=${a.in_interface} state=${a.connection_state}`,
        "",
        `RESULT: ${diff.summary}`,
        "",
        "BEFORE",
        renderTrace(before),
        "",
        "AFTER",
        renderTrace(after),
        coverage(afterModel),
        "",
        "Nothing was changed on any device — this is a simulation over a copy of the config.",
      ].join("\n");
    },
  }),

  defineTool({
    name: "explain_rule_reachability",
    title: "Explain Firewall Rule Reachability",
    annotations: READ,
    description:
      "Static analysis, no packet needed: which firewall rules can NEVER match because an earlier " +
      "terminal rule in the same chain already matches everything they would? " +
      "Deliberately conservative — only an exact-superset relation counts, because a false 'this " +
      "rule is dead' gets a working rule deleted, which is worse than missing one. " +
      "Complements firewall_audit's shadow detection with the simulator's own matcher model.",
    inputSchema: {
      snapshot_id: z.string().optional(),
      config_text: z.string().optional(),
      chain: z.string().optional().describe("Restrict to one chain, e.g. `input`"),
    },
    async handler(a, ctx) {
      const loaded = await loadConfig(ctx, {
        snapshotId: a.snapshot_id,
        configText: a.config_text,
      });
      if ("error" in loaded) return loaded.error;

      const model = buildModel(loaded.text);
      const rules = a.chain ? model.filter.filter((r) => r.chain === a.chain) : model.filter;
      const dead = unreachableRules(rules);

      if (model.filter.length === 0) return `No firewall filter rules in ${loaded.source}.`;
      if (dead.length === 0) {
        return (
          `REACHABILITY — ${loaded.source}\n\n` +
          `All ${rules.length} filter rule(s) are reachable.${coverage(model)}`
        );
      }
      return [
        `REACHABILITY — ${loaded.source}`,
        "",
        `${dead.length} of ${rules.length} rule(s) can never match:`,
        "",
        ...dead.map(
          (d) =>
            `  chain=${d.rule.chain} rule #${d.rule.index} (line ${d.rule.line})\n` +
            `    ${d.rule.raw}\n` +
            `    shadowed by rule #${d.shadowedBy.index} (line ${d.shadowedBy.line}) — ${d.why}`,
        ),
        coverage(model),
      ].join("\n");
    },
  }),

  defineTool({
    name: "simulate_suite",
    title: "Run a Packet Suite",
    annotations: READ,
    description:
      "Runs a set of packets with their EXPECTED verdicts — a regression test for the firewall. " +
      "Declare the flows that must work ('LAN can reach the internet', 'WAN cannot reach SSH') and " +
      "any change that breaks one is caught here rather than in production. " +
      "Each packet reports pass/fail with the deciding rule; an UNKNOWN verdict counts as a failure, " +
      `because a flow whose fate the model cannot determine is not a flow you have verified.${SCOPE_NOTE}`,
    inputSchema: {
      packets: z
        .array(
          z.object({
            name: z.string().describe('What this flow is, e.g. "LAN → internet"'),
            src_address: z.string(),
            dst_address: z.string(),
            protocol: z.string().default("tcp"),
            src_port: z.coerce.number().int().optional(),
            dst_port: z.coerce.number().int().optional(),
            in_interface: z.string(),
            connection_state: z.enum(["new", "established", "related", "invalid"]).default("new"),
            expect: z.enum(["accept", "drop", "reject"]).describe("The verdict this flow must get"),
          }),
        )
        .min(1),
      snapshot_id: z.string().optional(),
      config_text: z.string().optional(),
    },
    async handler(a, ctx) {
      const loaded = await loadConfig(ctx, {
        snapshotId: a.snapshot_id,
        configText: a.config_text,
      });
      if ("error" in loaded) return loaded.error;

      const model = buildModel(loaded.text);
      const rows = a.packets.map((p: SuitePacket) => {
        const result = tracePacket({
          model,
          packet: {
            srcAddress: p.src_address,
            dstAddress: p.dst_address,
            protocol: p.protocol,
            srcPort: p.src_port,
            dstPort: p.dst_port,
            inInterface: p.in_interface,
            connectionState: p.connection_state,
          },
        });
        // UNKNOWN is a failure: a flow the model cannot decide is not verified.
        const ok = result.verdict === p.expect;
        return { name: p.name, expect: p.expect, result, ok };
      });

      const failed = rows.filter((r: SuiteRow) => !r.ok);
      const lines = [
        `PACKET SUITE — ${loaded.source}`,
        `${rows.length - failed.length}/${rows.length} passed`,
        "",
        ...rows.map(
          (r: SuiteRow) =>
            `  ${r.ok ? "PASS" : "FAIL"}  ${r.name}: expected ${r.expect.toUpperCase()}, got ${r.result.verdict.toUpperCase()}${
              r.ok ? "" : `\n        ${r.result.summary}`
            }`,
        ),
      ];
      if (failed.some((r: SuiteRow) => r.result.verdict === "unknown")) {
        lines.push(
          "",
          "An UNKNOWN verdict is counted as a failure: the model met a construct it does not " +
            "implement on that packet's path, so that flow is not verified either way.",
        );
      }
      lines.push(coverage(model));
      return lines.join("\n");
    },
  }),
];
