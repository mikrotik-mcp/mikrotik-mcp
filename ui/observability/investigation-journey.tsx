import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { Investigation } from "../../src/investigations/model";
import { parseIp } from "../../src/sim/ip";
import { journeyModel } from "./investigation-journey-model";
import { JsonView } from "./highlight";
import { MonitorPanel, MonitorSelect, StatusBadge, useLineDraw } from "./monitoring-ui";
import type { Tone } from "./monitoring-ui";

type NodeTone = "ok" | "warn" | "acc" | "faint";
const NODE_COLOR: Record<NodeTone, string> = {
  ok: "var(--sig)",
  warn: "var(--warning)",
  acc: "var(--brand)",
  faint: "var(--text-faint)",
};
const BADGE_TONE: Record<NodeTone, Tone> = {
  ok: "default",
  warn: "warn",
  acc: "brand",
  faint: "default",
};

interface JourneyNode {
  title: string;
  sub: string;
  tone: NodeTone;
}

/** The board's path diagram: five stops on one line, numbered steps above. */
function JourneyPath({ nodes, drawKey }: { nodes: JourneyNode[]; drawKey: string }): ReactNode {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(796);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const next = Math.round(entry.contentRect.width);
      if (next > 0) setW(next);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLineDraw(box, drawKey);
  const h = 132;
  const y = 50;
  const xs = [70, w * 0.27, w * 0.5, w * 0.72, w - 96];
  const segs: [number, number, NodeTone, boolean][] = [
    [0, 1, nodes[1].tone === "faint" ? "faint" : "ok", false],
    [1, 2, "warn", true],
    [2, 3, nodes[3].tone, true],
    [3, 4, "faint", true],
  ];
  return (
    <div ref={box} className="min-w-0">
      <svg
        className="inv-journey-svg"
        viewBox={`0 0 ${w} ${h}`}
        width="100%"
        height={h}
        role="img"
        aria-label={`Path: ${nodes.map((n) => n.title).join(", then ")}`}
      >
        {segs.map(([i, j, tone, dashed]) => {
          const x1 = xs[i] + 18;
          const x2 = xs[j] - 18;
          return (
            <g key={`${i}-${j}`}>
              <path
                data-draw
                d={`M${x1} ${y}H${x2}`}
                stroke={NODE_COLOR[tone]}
                strokeWidth={2}
                strokeOpacity={0.75}
                strokeDasharray={dashed ? "5 5" : undefined}
                fill="none"
              />
              {!dashed && <circle cx={(x1 + x2) / 2} cy={y} r={3} fill={NODE_COLOR[tone]} />}
            </g>
          );
        })}
        {nodes.map((n, i) => (
          <g key={i}>
            {i > 0 && (
              <text
                x={xs[i]}
                y={y - 30}
                textAnchor="middle"
                fontSize={10}
                letterSpacing="0.1em"
                fill="var(--text-faint)"
              >
                STEP {i}
              </text>
            )}
            <circle
              cx={xs[i]}
              cy={y}
              r={17}
              fill="var(--surface-2)"
              stroke={NODE_COLOR[n.tone]}
              strokeWidth={1.6}
            />
            <circle cx={xs[i]} cy={y} r={4.5} fill={NODE_COLOR[n.tone]} />
            <text
              x={xs[i]}
              y={y + 38}
              textAnchor="middle"
              fontSize={12}
              fill="var(--foreground)"
              fontFamily="var(--font-mt)"
            >
              {n.title}
            </text>
            <text
              x={xs[i]}
              y={y + 56}
              textAnchor="middle"
              fontSize={11}
              fill="var(--muted-foreground)"
            >
              {n.sub}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

/** Saved records only: ingress, policy gap, route candidates, unverified destination. */
export function InvestigationJourney({
  investigation: c,
  className,
}: {
  investigation: Investigation;
  className?: string;
}): ReactNode {
  const fieldId = useId();
  const [destination, setDestination] = useState(parseIp(c.target) !== null ? c.target : "");
  const [table, setTable] = useState("main");
  const m = journeyModel(c, destination, table);
  const choices = [...new Set(["main", ...m.tables])];
  const branches = m.routes
    .filter((r) => r.table === table && r.match !== "no" && r.availability !== "inactive")
    .sort(
      (a, b) =>
        Number(b.best) - Number(a.best) ||
        (b.prefix ?? -1) - (a.prefix ?? -1) ||
        (a.distance ?? Infinity) - (b.distance ?? Infinity),
    );
  const excluded = m.routes.filter(
    (r) => r.table === table && (r.match === "no" || r.availability === "inactive"),
  );
  const best = m.best.length === 1 ? m.best[0] : null;
  const bestExit = best
    ? best.interfaces.join(" / ") || best.row.gateway || "gateway unknown"
    : null;
  const attachment = [...m.logical, ...m.physical].join(" · ");
  const lease = c.evidence
    .filter((e) => e.device === c.device && e.source === "dhcp" && e.state === "observed")
    .flatMap((e) => e.rows)
    .map((r) => r["mac-address"])
    .find(Boolean);
  const unknownPolicy = m.policySources.filter((s) => !s.captured).map((s) => s.source);

  const nodes: JourneyNode[] = [
    { title: c.client, sub: "client", tone: "ok" },
    attachment
      ? { title: attachment, sub: `enters ${c.device}`, tone: "ok" }
      : { title: "ingress unknown", sub: `on ${c.device}`, tone: "faint" },
    { title: `table ${table}`, sub: "firewall decision not observed", tone: "warn" },
    bestExit
      ? { title: bestExit, sub: "best recorded exit", tone: "acc" }
      : { title: "no ranked exit", sub: "exit not named", tone: "faint" },
    { title: c.target, sub: "return path unverified", tone: "faint" },
  ];

  const routeBody: ReactNode = !m.destinationValid ? (
    "Enter the destination IP to compare prefixes. A hostname cannot select a route."
  ) : m.routesIncomplete ? (
    "Route evidence is incomplete or unsupported, so no route is ranked."
  ) : best ? (
    <>
      Best recorded match:{" "}
      <span className="inv-mono">{`${best.row["dst-address"]} → ${bestExit}`}</span>
      {best.row.gateway ? (
        <>
          {" "}
          via <span className="inv-mono">{best.row.gateway}</span>
        </>
      ) : null}
      . Not observed.
    </>
  ) : m.best.length > 1 ? (
    `${m.best.length} routes rank equal. Flow hashing and runtime state decide; neither is recorded.`
  ) : (
    "No unique ranked answer from these records. That does not prove a dropped packet."
  );

  const steps: { title: string; status: string; tone: NodeTone | ""; body: ReactNode }[] = [
    {
      title: "Client enters the access router",
      status: "Saved attachment records",
      tone: "",
      body: attachment ? (
        <>
          <span className="inv-mono">{attachment}</span>
          {lease ? (
            <>
              {" "}
              · lease <span className="inv-mono">{lease}</span>
            </>
          ) : null}
        </>
      ) : (
        "No bridge or ARP record names the port. Current traffic is not measured."
      ),
    },
    {
      title: "Which table and firewall path apply?",
      status: "Decision not observed",
      tone: "warn",
      body: `Mangle, routing rules, NAT and connection state can change this flow.${
        unknownPolicy.length
          ? ` ${unknownPolicy.join(", ").replace(/^./, (ch) => ch.toUpperCase())} evidence is unknown.`
          : ""
      }`,
    },
    {
      title: `Possible exits in table ${table}`,
      status: m.destinationValid ? "Ranked for supplied IP only" : "IP needed to compare",
      tone: "acc",
      body: routeBody,
    },
    {
      title: "Destination and return path",
      status: "Still unverified",
      tone: "",
      body: "Downstream hops, return routing and the application response are absent from this case.",
    },
  ];

  return (
    <MonitorPanel
      className={className}
      flush
      title={
        <>
          <span className="inv-long">Follow this client&apos;s journey</span>
          <span className="inv-short">Client journey</span>
        </>
      }
      description={
        <>
          <span className="inv-long" id={`${fieldId}-help`}>
            Offline comparison only. Enter the destination IP the client actually used, not a DNS
            guess.
          </span>
          <span className="inv-short">Saved evidence, not a live trace.</span>
        </>
      }
      extra={
        <div className="inv-controls inv-journey-desk">
          <input
            className="monitor-input inv-input inv-mono"
            aria-label="Destination IPv4 used by the client"
            aria-describedby={`${fieldId}-help`}
            value={destination}
            onChange={(e) => setDestination(e.target.value.trim())}
            placeholder={parseIp(c.target) === null ? `IP for ${c.target}` : "Destination IPv4"}
            aria-invalid={destination !== "" && !m.destinationValid}
          />
          <MonitorSelect
            label="Assumed routing table"
            value={table}
            onChange={setTable}
            options={choices.map((t) => ({ value: t, label: `table ${t}` }))}
          />
        </div>
      }
    >
      <div className="inv-journey-desk flex flex-col gap-[14px] px-[18px] pb-4">
        <JourneyPath nodes={nodes} drawKey={`${c.id}:${table}:${bestExit ?? ""}`} />
        <div className="inv-steps">
          {steps.map((s, i) => (
            <div key={s.title} className="glass inv-step">
              <span className="inv-step-tags">
                <span className="monitor-chip">{i + 1}</span>
                <StatusBadge tone={s.tone ? BADGE_TONE[s.tone] : "default"} dot={false}>
                  {s.status}
                </StatusBadge>
              </span>
              <b>{s.title}</b>
              <span className="inv-step-body">{s.body}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="inv-timeline px-[18px] pb-4">
        {steps.map((s, i) => (
          <div key={s.title} className="inv-tl-item">
            <span
              className="inv-tl-num"
              style={
                {
                  "--inv-tone":
                    s.tone === ""
                      ? i === 0
                        ? "var(--sig)"
                        : "var(--text-faint)"
                      : NODE_COLOR[s.tone],
                } as CSSProperties
              }
            >
              {i + 1}
            </span>
            <span className="inv-tl-text">
              <b>{s.title}</b>
              <span>
                <StatusBadge tone={s.tone ? BADGE_TONE[s.tone] : "default"} dot={false}>
                  {s.status}
                </StatusBadge>
              </span>
              <span className="inv-step-body">{s.body}</span>
            </span>
          </div>
        ))}
      </div>
      <details className="inv-more inv-journey-desk">
        <summary>
          <ChevronRight aria-hidden="true" />
          <span className="flex-1">
            Route records in table {table} · {branches.length} candidate
            {branches.length === 1 ? "" : "s"}, {excluded.length} excluded
          </span>
        </summary>
        <div className="inv-more-body">
          {branches.length === 0 && (
            <p className="inv-hint">
              No candidate in this saved table.{" "}
              {m.tables.filter((t) => t !== table).length
                ? `Other recorded tables: ${m.tables.filter((t) => t !== table).join(", ")}.`
                : "Missing rows are not proof of a drop."}
            </p>
          )}
          {branches.map((r) => {
            const tunnel = m.tunnels.find((t) => r.interfaces.includes(t.name));
            const disabledExit = m.interfaces.filter(
              (iface) =>
                r.interfaces.includes(iface.name) &&
                (iface.disabled === "yes" ||
                  iface.disabled === "true" ||
                  (iface.flags ?? "").includes("X")),
            );
            return (
              <div key={r.key} className="glass inv-branch" data-best={r.best || undefined}>
                <div className="inv-branch-head">
                  <span className="inv-mono text-foreground">
                    {r.row["dst-address"] || "Prefix unknown"} →{" "}
                    {r.interfaces.join(" / ") || r.row["immediate-gw"] || r.row.gateway || "?"}
                  </span>
                  <StatusBadge tone={r.best ? "brand" : "default"} dot={false}>
                    {r.best
                      ? "Best recorded · not observed"
                      : m.destinationValid
                        ? "Alternative"
                        : "Unfiltered"}
                  </StatusBadge>
                </div>
                <div className="inv-branch-meta">
                  <span>gateway {r.row["immediate-gw"] || r.row.gateway || "not recorded"}</span>
                  <span>distance {r.distance ?? "?"}</span>
                  <span>state {r.availability}</span>
                  {tunnel && <span>{tunnel.protocol}</span>}
                  <span>
                    link{" "}
                    {r.resolution === "subnet"
                      ? "from address subnet"
                      : r.resolution === "explicit"
                        ? "explicit gateway"
                        : "unresolved"}
                  </span>
                </div>
                {disabledExit.length > 0 && (
                  <p className="text-destructive">
                    Recorded disabled exit: {disabledExit.map((i) => i.name).join(", ")}.
                  </p>
                )}
                {r.resolution === "unknown" && (
                  <p className="inv-warn">
                    {m.addressEvidence
                      ? "No clear gateway-to-interface mapping in these records."
                      : "Needs interface addresses or resolved gateways to name the exit."}
                  </p>
                )}
                <details>
                  <summary className="inv-sub">Show route record</summary>
                  <div className="mt-2">
                    <JsonView value={r.row} maxHeight={200} />
                  </div>
                </details>
              </div>
            );
          })}
          {excluded.length > 0 && (
            <details>
              <summary className="inv-sub">
                {excluded.length} excluded: inactive, or the prefix does not match
              </summary>
              <div className="mt-2">
                <JsonView
                  value={excluded.map((r) => ({
                    reason:
                      r.availability === "inactive" ? "Inactive or disabled" : "Prefix mismatch",
                    route: r.row,
                  }))}
                  maxHeight={240}
                />
              </div>
            </details>
          )}
          {m.policySources.map((s) => (
            <details key={s.source}>
              <summary className="inv-sub">
                {s.source}:{" "}
                {s.captured ? `${s.rows.length} records · not evaluated` : "not fully captured"}
              </summary>
              <div className="mt-2">
                <JsonView value={s.rows} maxHeight={180} />
              </div>
            </details>
          ))}
        </div>
      </details>
    </MonitorPanel>
  );
}
