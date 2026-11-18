import { useEffect, useState } from "react";
import { Target } from "lucide-react";
import { api } from "./api";
import { MonitorButton } from "./monitoring-ui";
import { FieldSelect } from "./service-routing-ui";

/** Configuration-only lookup: adding an approval never waits for router SSH inventory. */
export function ServiceProbePicker({
  device,
  value,
  onChange,
  onManage,
  optional = false,
}: {
  device: string;
  value: string;
  onChange: (value: string) => void;
  onManage: () => void;
  optional?: boolean;
}) {
  const [targets, setTargets] = useState<string[]>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ targets: { name: string; kind: string }[] }>(
      `/api/service-contracts/targets?device=${encodeURIComponent(device)}`,
      controller.signal,
    )
      .then((data) => {
        if (controller.signal.aborted) return;
        setTargets(data.targets.filter((t) => t.kind === "https").map((t) => t.name));
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "Could not load service approvals.");
      });
    return () => controller.abort();
  }, [device, retry]);
  useEffect(() => {
    if (targets && value && !targets.includes(value)) onChange("");
  }, [targets, value, onChange]);
  const placeholder = error
    ? "Approvals unavailable"
    : !targets
      ? "Loading approved services…"
      : targets.length
        ? "Choose an HTTPS service"
        : "Add your first HTTPS service";
  return (
    <div className="monitor-fl">
      <div className="flex items-center">
        <span className="monitor-label flex-1">
          Approved service {optional && <span className="font-normal text-faint">optional</span>}
        </span>
        <button
          type="button"
          className="cursor-pointer text-[12px] font-medium text-brand hover:underline"
          onClick={onManage}
        >
          Manage service probes
        </button>
      </div>
      <FieldSelect
        label="Approved service"
        icon={<Target />}
        value={value || (optional ? "__none__" : "")}
        onChange={(v) => onChange(v === "__none__" ? "" : v)}
        disabled={!optional && !targets?.length}
        placeholder={optional ? undefined : placeholder}
        options={[
          ...(optional ? [{ value: "__none__", label: "No probe · manual routing" }] : []),
          ...(targets ?? []).map((alias) => ({ value: alias, label: `${alias} · HTTPS check` })),
        ]}
      />
      {error ? (
        <span className="monitor-err flex flex-wrap items-center gap-2" role="alert">
          {error}
          <MonitorButton
            size="sm"
            variant="ghost"
            onClick={() => {
              setError("");
              setRetry((v) => v + 1);
            }}
          >
            Retry approvals
          </MonitorButton>
        </span>
      ) : targets?.length === 0 ? (
        <span className="monitor-hint">
          {optional
            ? "No HTTPS services approved yet. You can still save a domain route without a probe."
            : "No HTTPS services approved yet. Add one in Service probes, save and keep it, then pick it here."}
        </span>
      ) : null}
    </div>
  );
}
