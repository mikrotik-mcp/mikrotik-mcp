/**
 * Change Plan command — mirrors the dashboard's Change Plan tab: paste intended
 * RouterOS commands and get a risk-scored, safely-reordered dry-run plan. Pure
 * analysis (`POST /api/plan`) — it never touches a device.
 */
import {
  Action,
  ActionPanel,
  Color,
  Detail,
  Form,
  Icon,
  List,
  useNavigation,
} from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { postJson } from "./lib/api";
import { showFailureToast } from "./lib/confirm";
import { RolloutSection } from "./lib/rollouts";
import type { ChangePlan, PlanStep } from "./lib/types";

const OP_SIGN: Record<string, string> = {
  add: "+",
  set: "~",
  enable: "▲",
  disable: "▽",
  move: "⇅",
  remove: "−",
  other: "!",
};

function PlanResult({ script }: { script: string }) {
  const { data, isLoading } = usePromise(
    (s: string) =>
      postJson<{ plan?: ChangePlan; text?: string; error?: string }>(
        "/api/plan",
        { script: s },
      ),
    [script],
  );
  const plan = data?.plan;

  const stepLine = (s: PlanStep) =>
    `${OP_SIGN[s.op] ?? "•"} \`${s.command}\`${s.lockoutRisk ? "  ⚠ lock-out" : ""}  _(${s.risk})_`;

  const md = plan
    ? [
        `# Change Plan · risk ${plan.riskScore}/100 (${plan.grade})`,
        ``,
        `+${plan.counts.add} add · ~${plan.counts.modify} modify · −${plan.counts.remove} remove${plan.reordered ? " · reordered for safety" : ""}`,
        plan.warnings.length
          ? `\n## Warnings\n\n${plan.warnings.map((w) => `- ⚠ ${w}`).join("\n")}`
          : "",
        `\n## Steps\n\n${plan.steps.map(stepLine).join("\n\n")}`,
      ].join("\n")
    : data?.error
      ? `# Error\n\n${data.error}`
      : "Analyzing…";

  return (
    <Detail
      isLoading={isLoading}
      markdown={md}
      navigationTitle="Change Plan"
      metadata={
        plan ? (
          <Detail.Metadata>
            <Detail.Metadata.Label
              title="Risk"
              text={`${plan.riskScore}/100`}
            />
            <Detail.Metadata.TagList title="Grade">
              <Detail.Metadata.TagList.Item
                text={plan.grade}
                color={
                  plan.grade === "critical" || plan.grade === "high"
                    ? Color.Red
                    : Color.Green
                }
              />
            </Detail.Metadata.TagList>
            <Detail.Metadata.Label
              title="Steps"
              text={String(plan.counts.total)}
            />
            <Detail.Metadata.Label
              title="Reordered"
              text={plan.reordered ? "yes" : "no"}
            />
          </Detail.Metadata>
        ) : null
      }
    />
  );
}

/** The dry-run form, pushed from the command's root list. */
function PlanForm() {
  const { push } = useNavigation();
  return (
    <Form
      navigationTitle="Change Plan"
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Plan Changes"
            icon={Icon.Play}
            onSubmit={(v: { script: string }) => {
              if (!v.script.trim()) {
                showFailureToast(new Error("Enter at least one command"), {
                  title: "Nothing to plan",
                });
                return;
              }
              push(<PlanResult script={v.script} />);
            }}
          />
        </ActionPanel>
      }
    >
      <Form.Description text="Paste intended RouterOS commands (one per line). This is a dry-run — no device is touched." />
      <Form.TextArea
        id="script"
        title="Commands"
        placeholder={
          "/ip firewall filter add chain=input action=accept ...\n/ip address add address=10.0.0.1/24 interface=bridge"
        }
      />
    </Form>
  );
}

/**
 * Root: the dry-run entry point plus the fleet-rollout section. A rollout is the
 * same change plan applied to N devices with gates, so they belong in one place —
 * and having Hold / Resume / Abort a keystroke away is the point of putting
 * rollouts in a launcher at all.
 */
export default function Command() {
  return (
    <List searchBarPlaceholder="Change plan & rollouts…">
      <List.Section title="Dry-run">
        <List.Item
          icon={Icon.Play}
          title="Plan Changes"
          subtitle="Paste commands for a risk-scored preview — no device is touched"
          actions={
            <ActionPanel>
              <Action.Push title="Plan Changes" icon={Icon.Play} target={<PlanForm />} />
            </ActionPanel>
          }
        />
      </List.Section>
      <RolloutSection />
    </List>
  );
}
