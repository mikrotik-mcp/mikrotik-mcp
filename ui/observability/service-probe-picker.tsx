import { useEffect, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "./api";

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
  return (
    <div className="ops-field ops-field--wide">
      <span>Approved service {optional && <small>· optional health probe</small>}</span>
      <Select
        value={value || (optional ? "__none__" : "")}
        onValueChange={(v) => onChange(v === "__none__" ? "" : v)}
        disabled={!optional && !targets?.length}
      >
        <SelectTrigger aria-label="Approved service">
          <SelectValue
            placeholder={
              error
                ? "Approvals unavailable"
                : !targets
                  ? "Loading approved services…"
                  : targets.length
                    ? "Select HTTPS service"
                    : "Add your first HTTPS service"
            }
          />
        </SelectTrigger>
        <SelectContent>
          {optional && <SelectItem value="__none__">No probe · manual routing</SelectItem>}
          {targets?.map((alias) => (
            <SelectItem key={alias} value={alias}>
              {alias}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {optional && (
        <small>
          Only needed for HTTPS exit checks and automatic failover. A wildcard needs an approved
          concrete subdomain; this never probes every subdomain.
        </small>
      )}
      {error ? (
        <small role="alert">
          {error}{" "}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setError("");
              setRetry((v) => v + 1);
            }}
          >
            <RefreshCw size={12} />
            Retry approvals
          </Button>
        </small>
      ) : (
        targets?.length === 0 && (
          <small>
            {optional
              ? "No HTTPS services approved yet. You can still save a domain route without a health probe."
              : "No HTTPS services approved yet. Add a service below, save and keep your changes, then select it here. Existing router routes need no approval."}
          </small>
        )
      )}
      <Button variant="outline" onClick={onManage}>
        <Plus size={15} />
        Manage service probes
      </Button>
    </div>
  );
}
