/**
 * Change Plan (the Cfg-Plan board): paste intended RouterOS commands and get a
 * risk-scored plan in a safe order. Pure analysis: no device I/O.
 *
 * The page has two halves that answer the same question at different scales:
 * what a change does to ONE router (Dry-run) and what it does to the FLEET
 * (Rollout, `rollout.tsx`). A switch in the header moves between them.
 */
import "./plan.css";
import { useState } from "react";
import type { ReactNode } from "react";
import { Check, Info, Play, TriangleAlert } from "lucide-react";
import { postJson } from "./api";
import { ScoreRing } from "./config-charts";
import { LoadingState } from "./loading-state";
import {
  MonitorButton,
  MonitorEmpty,
  MonitorNote,
  MonitorPanel,
  PageIntro,
  Segmented,
  StatusBadge,
} from "./monitoring-ui";
import type { ChartTone } from "./monitoring-ui";
import { RolloutView } from "./rollout";
import { toast } from "./toast-action";

interface PlanStep {
  index: number;
  command: string;
  path: string;
  op: string;
  risk: string;
  summary: string;
  lockoutRisk?: string;
}
interface ChangePlan {
  steps: PlanStep[];
  counts: { add: number; modify: number; remove: number; other: number; total: number };
  riskScore: number;
  grade: string;
  warnings: string[];
  reordered: boolean;
}

const OP_MARK: Record<string, string> = {
  add: "+",
  set: "~",
  remove: "−",
  enable: "▲",
  disable: "▽",
  move: "⇅",
};
const OP_TONE: Record<string, string> = {
  add: "text-success",
  enable: "text-success",
  set: "text-warning",
  move: "text-warning",
  disable: "text-warning",
  remove: "text-destructive",
};
const RISK_KIND: Record<string, string> = { low: "read", medium: "write", high: "destructive" };

function gradeTone(grade: string): ChartTone {
  if (grade === "critical" || grade === "high") return "bad";
  if (grade === "moderate") return "warn";
  return "good";
}
const GRADE_TEXT: Record<ChartTone, string> = {
  bad: "text-destructive",
  warn: "text-warning",
  good: "text-success",
  brand: "text-brand",
  muted: "text-faint",
};

export type PlanTab = "plan" | "rollout";

/** The Dry-run / Rollout switch, shared by both halves of the page. */
export function PlanSwitch({
  value,
  onChange,
}: {
  value: PlanTab;
  onChange: (tab: PlanTab) => void;
}): ReactNode {
  return (
    <Segmented
      label="Change plan view"
      value={value}
      onChange={onChange}
      options={[
        { value: "plan", label: "Dry-run" },
        { value: "rollout", label: "Rollout" },
      ]}
    />
  );
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function Summary({ plan }: { plan: ChangePlan | null }): ReactNode {
  if (!plan)
    return (
      <MonitorPanel title="Plan summary">
        <MonitorEmpty compact title="No plan yet">
          Paste commands and press Plan to see the risk score.
        </MonitorEmpty>
      </MonitorPanel>
    );
  const tone = gradeTone(plan.grade);
  // The reorder notice comes first in `warnings`; it gets its own green note.
  const lockouts = plan.steps.filter((s) => s.lockoutRisk);
  const order = new Map(plan.steps.map((s, i) => [s.index, i + 1]));
  return (
    <MonitorPanel title="Plan summary">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex items-center gap-4">
          <ScoreRing
            value={plan.riskScore}
            size={76}
            stroke={7}
            fontSize={18}
            tone={tone}
            label={`Risk score ${plan.riskScore} of 100`}
          />
          <div className="flex flex-col gap-1">
            <span className="monitor-label">Risk score</span>
            <b className={`text-[20px] leading-[21px] font-semibold ${GRADE_TEXT[tone]}`}>
              {plan.grade}
            </b>
            <span className="monitor-hint">grade from the riskiest step</span>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2.5">
          <div className="glass plan-card">
            <span className="monitor-label">To add</span>
            <div className="num plan-count text-success">+{plan.counts.add}</div>
          </div>
          <div className="glass plan-card">
            <span className="monitor-label">To modify</span>
            <div className="num plan-count text-warning">~{plan.counts.modify}</div>
          </div>
          <div className="glass plan-card">
            <span className="monitor-label">To remove</span>
            <div className="num plan-count text-destructive">−{plan.counts.remove}</div>
          </div>
        </div>
        {plan.reordered && (
          <MonitorNote tone="good" icon={<Check aria-hidden="true" />}>
            <b>Reordered into a safe sequence.</b> Adds now run before removes and drops, so a new
            way in exists before the old one goes.
          </MonitorNote>
        )}
        {lockouts.map((s) => (
          <MonitorNote
            key={s.index}
            tone={s.risk === "high" ? "bad" : "warn"}
            icon={<TriangleAlert aria-hidden="true" />}
          >
            Step {pad(order.get(s.index) ?? s.index)} ({s.command}): {s.lockoutRisk}.
          </MonitorNote>
        ))}
      </div>
    </MonitorPanel>
  );
}

function Steps({ plan }: { plan: ChangePlan }): ReactNode {
  return (
    <MonitorPanel
      title="Plan"
      description="Steps in the order they would run. The bar shows each step's risk."
      flush
      extra={
        <span className="monitor-legend">
          <span>
            <i className="bg-sig" />
            low
          </span>
          <span>
            <i className="bg-warning" />
            medium
          </span>
          <span>
            <i className="bg-destructive" />
            high
          </span>
        </span>
      }
    >
      {plan.steps.map((s, i) => (
        <div key={s.index} className="plan-step" data-risk={s.risk}>
          <span className="mono text-faint">{pad(i + 1)}</span>
          <span className={`plan-op ${OP_TONE[s.op] ?? "text-faint"}`}>{OP_MARK[s.op] ?? "•"}</span>
          <code className="trunc" title={s.command}>
            {s.command}
          </code>
          {s.lockoutRisk ? (
            <span className="plan-lock" title={s.lockoutRisk}>
              <StatusBadge tone="bad" dot={false}>
                <TriangleAlert aria-hidden="true" />
                lock-out
              </StatusBadge>
            </span>
          ) : (
            <span />
          )}
          <span className="justify-self-start">
            <span className="monitor-risk" data-risk={RISK_KIND[s.risk] ?? "read"}>
              {s.risk.toUpperCase()}
            </span>
          </span>
        </div>
      ))}
      <div className="monitor-foot">
        <Info aria-hidden="true" className="size-4 shrink-0" />
        <span>
          To apply this plan across routers, open Rollout or start a transaction with{" "}
          <span className="mono">begin_transaction</span>.
        </span>
      </div>
    </MonitorPanel>
  );
}

export function ChangePlanView(): ReactNode {
  const [tab, setTab] = useState<PlanTab>("plan");
  const [script, setScript] = useState("");
  const [res, setRes] = useState<{ plan: ChangePlan; text: string; at: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    const r = await postJson<{ plan?: ChangePlan; text?: string; error?: string }>("/api/plan", {
      script,
    }).catch((): { plan?: ChangePlan; text?: string; error?: string } => ({
      error: "request failed",
    }));
    setBusy(false);
    if (r.error || !r.plan) {
      setErr(r.error ?? "no plan produced");
      setRes(null);
      toast.error(r.error ?? "no plan produced");
      return;
    }
    setRes({ plan: r.plan, text: r.text ?? "", at: Date.now() });
    toast.success("Plan ready");
  };

  const switcher = <PlanSwitch value={tab} onChange={setTab} />;
  if (tab === "rollout") return <RolloutView switcher={switcher} />;

  const plan = res?.plan ?? null;
  const lines = script.split("\n").filter((l) => l.trim()).length;
  const lockouts = plan?.steps.filter((s) => s.lockoutRisk).length ?? 0;
  const commands = plan ? `${plan.counts.total} command${plan.counts.total === 1 ? "" : "s"}.` : "";

  return (
    <section className="plan grid content-start gap-[18px]">
      <PageIntro
        eyebrow="Change plan · dry-run"
        verdict={
          !plan ? (
            "Nothing planned yet."
          ) : lockouts > 0 ? (
            <>
              {commands} <em>{lockouts} could lock you out.</em>
            </>
          ) : (
            <>
              {commands} <span className="s">None could lock you out.</span>
            </>
          )
        }
        lead="A terraform-style preview. Pure analysis: nothing is sent to a router."
        aside={switcher}
      />

      <div className="plan-cols">
        <MonitorPanel
          title="Intended commands"
          description="Paste RouterOS commands, one per line."
          extra={<StatusBadge tone="good">never touches a router</StatusBadge>}
          bodyClassName="flex flex-col gap-3"
        >
          <textarea
            className="plan-script"
            aria-label="Intended commands"
            spellCheck={false}
            placeholder={
              "/ip firewall filter add chain=input action=drop in-interface=ether1\n/ip address add address=10.0.0.1/24 interface=ether2\n/ip address remove [find address=192.168.88.1/24]"
            }
            value={script}
            onChange={(e) => setScript(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <MonitorButton
              variant="primary"
              icon={<Play aria-hidden="true" />}
              aria-busy={busy || undefined}
              disabled={busy || !script.trim()}
              onClick={() => void run()}
            >
              {busy ? "Planning…" : "Plan"}
            </MonitorButton>
            <span className="monitor-hint">
              {lines} line{lines === 1 ? "" : "s"}
              {res ? ` · last planned ${clock(res.at)}` : ""}
            </span>
            {err && <span className="monitor-err">{err}</span>}
          </div>
        </MonitorPanel>
        <Summary plan={plan} />
      </div>

      {busy && !res && <LoadingState label="Preparing change plan" layout="form" />}
      {plan && <Steps plan={plan} />}
    </section>
  );
}
