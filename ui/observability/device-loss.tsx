import type { ReactNode } from "react";
import { clockTime } from "./device-card";
import { StatusBadge, StatusDot, formatMs } from "./monitoring-ui";
import { LineHover, smoothPath, tipProps } from "./kit";
import type { TipCard } from "./kit";
import { cn } from "@/lib/utils";
import type { DeviceInfo } from "./types";

type Loss = NonNullable<DeviceInfo["loss"]>;
type LossTone = "good" | "warn" | "bad";

/** Ticks in a tape: one for each of the last 30 probes. */
const TAPE = 30;
/** From this share of lost probes a path counts as losing packets. */
const WARN_PCT = 2;
/** From this share the path is not answering. */
const BAD_PCT = 50;

/** "0%", "0.3%", "6.7%", "100%". */
export function lossPct(pct: number): string {
  return `${pct.toFixed(1).replace(/\.0$/, "")}%`;
}

export function lossTone(pct: number): LossTone {
  return pct >= BAD_PCT ? "bad" : pct >= WARN_PCT ? "warn" : "good";
}

const TONE_TEXT: Record<LossTone, string> = {
  good: "",
  warn: "text-warning",
  bad: "text-destructive",
};

/** "5 s", "1 min 20 s". */
function gap(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

function tapeCard(title: string, sub: string, loss: Pick<Loss, "sent" | "lost" | "pct">): TipCard {
  return {
    title,
    sub,
    led: loss.pct >= BAD_PCT ? "bad" : loss.pct >= WARN_PCT ? "warn" : "ok",
    rows: [
      { label: "Loss", value: lossPct(loss.pct) },
      { label: "Probes lost", value: `${loss.lost} of ${loss.sent}` },
    ],
  };
}

/**
 * One tick for each of the last 30 probes, newest on the right: a short teal
 * tick answered, a tall one was lost. A slot with no probe yet is a faint dash.
 */
export function LossTape({
  recent,
  width = 96,
  card,
}: {
  recent: boolean[];
  width?: number;
  card: TipCard;
}): ReactNode {
  const step = width / TAPE;
  const empty = TAPE - recent.length;
  return (
    <svg
      className="dv-loss-tape"
      viewBox={`0 0 ${width} 16`}
      width={width}
      height={16}
      role="img"
      aria-label={`${recent.filter(Boolean).length} of the last ${recent.length} probes lost`}
      {...tipProps(card)}
    >
      {Array.from({ length: TAPE }, (_, i) => {
        const x = i * step;
        const w = step - 1.5;
        if (i < empty)
          return <rect key={i} x={x} y={13} width={w} height={3} rx={1} fill="var(--line-2)" />;
        return recent[i - empty] ? (
          <rect key={i} x={x} y={0} width={w} height={16} rx={1} fill="var(--destructive)" />
        ) : (
          <rect key={i} x={x} y={9} width={w} height={7} rx={1} fill="var(--sig)" opacity={0.55} />
        );
      })}
    </svg>
  );
}

/** The Loss cell of the Routers table: the tape, then the share lost. */
export function LossCell({ d }: { d: DeviceInfo }): ReactNode {
  const loss = d.loss;
  if (!loss)
    return (
      <span data-col="loss" className="text-faint text-right font-mono text-[12px]">
        —
      </span>
    );
  return (
    <span data-col="loss" className="kit-tips flex items-center justify-end gap-2.5">
      <LossTape recent={loss.recent} card={tapeCard(d.name, loss.host, loss)} />
      <span
        className={cn("w-11 flex-none text-right font-mono", TONE_TEXT[lossTone(loss.pct)])}
        data-loss-pct
      >
        {lossPct(loss.pct)}
      </span>
    </span>
  );
}

/** The Loss line of a router card on a phone. */
export function PhoneLossRow({ d }: { d: DeviceInfo }): ReactNode {
  const loss = d.loss;
  if (!loss) return null;
  return (
    <span className="kit-tips flex items-center gap-2 text-[12px]">
      <span className="text-muted-foreground">Loss</span>
      <span className="flex-1" />
      <LossTape recent={loss.recent} width={150} card={tapeCard(d.name, loss.host, loss)} />
      <span className={cn("w-11 flex-none text-right font-mono", TONE_TEXT[lossTone(loss.pct)])}>
        {lossPct(loss.pct)}
      </span>
    </span>
  );
}

/** The next round top for the loss axis: 5, 10, 20, 50 or 100 percent. */
function axisTop(peak: number): number {
  return [5, 10, 20, 50, 100].find((top) => top >= peak) ?? 100;
}

/** Loss for each minute as a smooth area line, with the kit card on hover. */
function LossChart({
  loss,
  name,
  width,
  height,
  axis,
}: {
  loss: Loss;
  name: string;
  width: number;
  height: number;
  axis: boolean;
}): ReactNode {
  const minutes = loss.minutes;
  const top = axisTop(Math.max(...minutes.map((m) => m.pct)));
  const last = Math.max(minutes.length - 1, 1);
  const points = minutes.map((m, i): [number, number] => [
    (i / last) * width,
    height - 2 - (m.pct / top) * (height - 8),
  ]);
  const line = smoothPath(points);
  const plot = (
    <svg
      className="dv-loss-chart"
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
    >
      {axis &&
        [0, 0.5, 1].map((part) => {
          const y = height - 2 - part * (height - 8);
          return (
            <line
              key={part}
              x1={0}
              x2={width}
              y1={y}
              y2={y}
              stroke="var(--line)"
              strokeDasharray="2 4"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      <path d={`${line} L${width},${height} L0,${height} Z`} fill="var(--sig-fill)" />
      <path
        d={line}
        fill="none"
        stroke="var(--sig)"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      <LineHover
        width={width}
        height={height}
        points={points}
        label={`Packet loss per minute on ${name}, last ${minutes.length} minutes`}
        card={(i) => {
          const m = minutes[i]!;
          return {
            title: clockTime(m.ts),
            sub: "1 minute",
            led: m.pct >= BAD_PCT ? "bad" : m.pct >= WARN_PCT ? "warn" : "ok",
            rows: [
              { label: "Loss", value: lossPct(m.pct) },
              { label: "Probes lost", value: `${m.lost} of ${m.sent}` },
              { label: "Answer time", value: m.avgMs != null ? formatMs(m.avgMs) : "—" },
            ],
          };
        }}
      />
    </svg>
  );
  if (!axis) return plot;
  const first = minutes[0]!.ts;
  const end = minutes[minutes.length - 1]!.ts;
  return (
    <div className="dv-loss-plot">
      <div className="dv-loss-y" aria-hidden="true">
        <span>{lossPct(top)}</span>
        <span>{lossPct(top / 2)}</span>
        <span>0%</span>
      </div>
      {plot}
      <div className="dv-loss-x" aria-hidden="true">
        <span>{clockTime(first)}</span>
        <span>{clockTime((first + end) / 2)}</span>
        <span>{clockTime(end)}</span>
      </div>
    </div>
  );
}

const HEALTH: Record<LossTone, string> = {
  good: "Healthy",
  warn: "Losing packets",
  bad: "Not answering",
};

function window(loss: Loss): string {
  const minutes = Math.max(1, Math.round((loss.sent * 5) / 60));
  return `last ${Math.min(minutes, 30)} min`;
}

function peakText(loss: Loss): string {
  const peak = loss.minutes.reduce((a, b) => (b.pct > a.pct ? b : a));
  return peak.pct > 0 ? `peak ${lossPct(peak.pct)} at ${clockTime(peak.ts)}` : "no loss";
}

function AddressRows({ d, loss, tape }: { d: DeviceInfo; loss: Loss; tape: number }): ReactNode {
  return (
    <div className="kit-tips flex flex-col gap-2.5 text-[12px]">
      {loss.addresses.map((a) => (
        <div key={a.host} className="flex items-center gap-2">
          <StatusDot tone={lossTone(a.pct)} />
          <span
            className={cn(
              "min-w-0 flex-1 truncate font-mono",
              a.host === d.host ? "text-foreground" : "text-fg-secondary",
            )}
            dir="ltr"
          >
            {a.host}
          </span>
          <LossTape recent={a.recent} width={tape} card={tapeCard(a.host, d.name, a)} />
          <span className={cn("w-10 flex-none text-right font-mono", TONE_TEXT[lossTone(a.pct)])}>
            {lossPct(a.pct)}
          </span>
        </div>
      ))}
    </div>
  );
}

const NUMBER_TONE: Record<LossTone, string> = {
  good: "text-success",
  warn: "text-warning",
  bad: "text-destructive",
};

/**
 * The Packet loss band of a router's details: the share lost in the window,
 * loss for each minute, and a tape for each management address.
 */
export function LossBand({ d, phone = false }: { d: DeviceInfo; phone?: boolean }): ReactNode {
  const loss = d.loss;
  if (!loss || loss.sent === 0) return null;
  const tone = lossTone(loss.pct);
  const chart = loss.minutes.length > 1;

  if (phone)
    return (
      <div
        className="border-line flex min-w-0 flex-col gap-2.5 border-t pt-3.5"
        aria-label={`Packet loss for ${d.name}`}
      >
        <div className="flex items-center gap-2">
          <span className="dv-section flex-1">Packet loss</span>
          <span className="text-faint text-[11px]">{window(loss)}</span>
        </div>
        <div className="flex items-baseline gap-2">
          <span className={cn("dv-loss-num dv-loss-num-phone", NUMBER_TONE[tone])}>
            {lossPct(loss.pct)}
          </span>
          <span className="text-muted-foreground text-[12px]">
            {loss.lost} of {loss.sent} probes lost
          </span>
        </div>
        {chart && (
          <div className="glass dv-cpu">
            <LossChart loss={loss} name={d.name} width={326} height={96} axis={false} />
            <div className="text-faint flex justify-between text-[11px]">
              <span>Loss per minute</span>
              <span>{peakText(loss)}</span>
            </div>
          </div>
        )}
        <AddressRows d={d} loss={loss} tape={120} />
        <span className="monitor-hint">
          A TCP probe to the management port every 5 s. No answer in 1 s counts as lost.
        </span>
      </div>
    );

  return (
    <div className="dv-loss" aria-label={`Packet loss for ${d.name}`}>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <span className="dv-section flex-1">Packet loss</span>
          <span className="text-faint text-[11px]">{window(loss)}</span>
        </div>
        <div className="flex items-baseline gap-2">
          <span className={cn("dv-loss-num", NUMBER_TONE[tone])}>{lossPct(loss.pct)}</span>
          <StatusBadge tone={tone}>{HEALTH[tone]}</StatusBadge>
        </div>
        <span className="text-muted-foreground text-[12px]">
          {loss.lost} of {loss.sent} probes got no answer.
        </span>
        <dl className="monitor-facts dv-loss-facts">
          <dt>Probes sent</dt>
          <dd className="font-mono">{loss.sent}</dd>
          <dt>Lost</dt>
          <dd className="font-mono">{loss.lost}</dd>
          <dt>Longest gap</dt>
          <dd className="font-mono">
            {loss.longestGapAt != null
              ? `${gap(loss.longestGapMs)}, at ${clockTime(loss.longestGapAt)}`
              : "none"}
          </dd>
          <dt>Answer time</dt>
          <dd className="font-mono">
            {loss.avgMs != null ? `${formatMs(loss.avgMs)} average` : "—"}
          </dd>
          <dt>Jitter</dt>
          <dd className="font-mono">{loss.jitterMs != null ? formatMs(loss.jitterMs) : "—"}</dd>
        </dl>
      </div>
      <div className="flex min-w-0 flex-col gap-2.5">
        <div className="flex items-center gap-2">
          <span className="dv-section flex-1">Loss per minute</span>
          <span className="text-faint text-[11px]">{peakText(loss)}</span>
        </div>
        {chart ? (
          <LossChart loss={loss} name={d.name} width={760} height={152} axis />
        ) : (
          <span className="monitor-hint">The chart starts after two minutes of probes.</span>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex items-center gap-2">
          <span className="dv-section flex-1">By address</span>
          <span className="text-faint text-[11px]">last 30 probes</span>
        </div>
        <AddressRows d={d} loss={loss} tape={96} />
        <div className="text-muted-foreground flex gap-3.5 text-[11px]">
          <span className="inline-flex items-center gap-1.5">
            {/* chart-exempt: a legend key, not data. */}
            <svg width={4} height={12} aria-hidden="true">
              <rect y={5} width={4} height={7} rx={1} fill="var(--sig)" opacity={0.55} />
            </svg>
            answered
          </span>
          <span className="inline-flex items-center gap-1.5">
            {/* chart-exempt: a legend key, not data. */}
            <svg width={4} height={12} aria-hidden="true">
              <rect width={4} height={12} rx={1} fill="var(--destructive)" />
            </svg>
            lost
          </span>
        </div>
        <span className="monitor-hint">
          A probe is a TCP connection to the management port, every 5 s. No answer in 1 s counts as
          lost.
        </span>
      </div>
    </div>
  );
}
