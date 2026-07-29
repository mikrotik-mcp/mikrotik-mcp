import { useState } from "react";
import type { ReactNode } from "react";
import { Play, TriangleAlert } from "lucide-react";
import { postJson } from "./api";
import { Panel } from "./atoms";
import { Button } from "./geist";
import { RolloutView } from "./rollout";
import { toast } from "./toast-action";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

// ── Change plan (dry-run) view ───────────────────────────────────────────────
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
const OP_BADGE: Record<string, string> = {
  add: "+",
  set: "~",
  remove: "−",
  enable: "▲",
  disable: "▽",
  move: "⇅",
};

// Left accent bar per risk level.
const RISK_BAR: Record<string, string> = {
  high: "border-l-destructive",
  medium: "border-l-warning",
  low: "border-l-success",
};

/** Paste intended commands and preview a risk-scored, safely-ordered plan (no device I/O). */
/**
 * The Change Plan page has two halves that answer the same question at different
 * scales: what will this change do to ONE device (the dry-run), and what will it
 * do to the FLEET (the rollout). Tabs rather than two nav entries, because the
 * second is the first applied N times with gates.
 */
export function ChangePlanView(): ReactNode {
  const [tab, setTab] = useState<"plan" | "rollout">("plan");
  const [script, setScript] = useState("");
  const [res, setRes] = useState<{ plan: ChangePlan; text: string } | null>(null);
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
    setRes({ plan: r.plan, text: r.text ?? "" });
    toast.success("Plan ready");
  };

  const grade = res?.plan.grade ?? "";
  const gradeBad = grade === "critical" || grade === "high";

  const tabs = (
    <div className="mb-4 flex items-center gap-1">
      <Button
        size="sm"
        type={tab === "plan" ? "default" : "secondary"}
        onClick={() => setTab("plan")}
      >
        Dry-run
      </Button>
      <Button
        size="sm"
        type={tab === "rollout" ? "default" : "secondary"}
        onClick={() => setTab("rollout")}
      >
        Rollout
      </Button>
    </div>
  );

  if (tab === "rollout") {
    return (
      <div>
        {tabs}
        <RolloutView />
      </div>
    );
  }

  return (
    <>
      {tabs}
      <section className="grid content-start gap-[18px]">
        <Panel
          title="Change plan — dry-run"
          className="reveal"
          extra={
            <span className="text-muted-foreground text-[11px]">
              terraform-style preview · pure analysis, never touches a device
            </span>
          }
        >
          <Textarea
            className="min-h-40 resize-y font-mono text-xs leading-relaxed"
            spellCheck={false}
            placeholder={
              "Paste intended RouterOS commands, one per line, e.g.\n/ip firewall filter add chain=input action=drop in-interface=WAN\n/ip address add address=10.0.0.1/24 interface=ether1\n/ip address remove [find address=192.168.88.1/24]"
            }
            value={script}
            onChange={(e) => setScript(e.target.value)}
          />
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <Button
              type="accent"
              size="sm"
              icon={<Play />}
              loading={busy}
              onClick={() => void run()}
              disabled={busy || !script.trim()}
            >
              {busy ? "Planning…" : "Plan"}
            </Button>
            {err && <span className="text-destructive text-xs">{err}</span>}
          </div>
        </Panel>

        {res && (
          <Panel
            title="Plan"
            className="reveal"
            extra={
              <span
                className={cn(
                  "rounded-full border px-2.5 py-1 font-mono text-[11px]",
                  gradeBad
                    ? "border-destructive/45 bg-destructive/10 text-destructive"
                    : "border-success/45 bg-success/10 text-success",
                )}
              >
                risk {res.plan.riskScore} · {grade}
              </span>
            }
          >
            <div className="flex flex-wrap gap-3 font-mono text-[11px] text-muted-foreground">
              <span>+{res.plan.counts.add} to add</span>
              <span>~{res.plan.counts.modify} to modify</span>
              <span>-{res.plan.counts.remove} to remove</span>
              {res.plan.reordered && <span>· reordered into a safe sequence</span>}
            </div>
            {res.plan.warnings.length > 0 && (
              <div className="my-2.5 grid gap-1">
                {res.plan.warnings.map((w, i) => (
                  <div className="flex items-center gap-1.5 text-warning text-xs" key={i}>
                    <TriangleAlert className="size-3.5 shrink-0" /> {w}
                  </div>
                ))}
              </div>
            )}
            <div className="mt-3 flex flex-col gap-1.5">
              {res.plan.steps.map((s) => (
                <div
                  className={cn(
                    "flex items-center gap-2.5 rounded-md border border-border border-l-[3px] bg-muted/40 px-3 py-2 font-mono text-xs",
                    RISK_BAR[s.risk] ?? "border-l-border",
                  )}
                  key={s.index}
                >
                  <span className="grid size-[18px] flex-none place-items-center rounded bg-brand/15 font-bold text-brand">
                    {OP_BADGE[s.op] ?? "•"}
                  </span>
                  <code className="flex-1 [overflow-wrap:anywhere] text-foreground">
                    {s.command}
                  </code>
                  {s.lockoutRisk && (
                    <span className="rounded-full border border-destructive/45 px-1.5 py-px text-[10px] text-destructive">
                      ⚠ lock-out
                    </span>
                  )}
                  <span className="text-[10px] tracking-wide text-muted-foreground uppercase">
                    {s.risk}
                  </span>
                </div>
              ))}
            </div>
          </Panel>
        )}
      </section>
    </>
  );
}
