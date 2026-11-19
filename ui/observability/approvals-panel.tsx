/**
 * Approvals: the changes that wait for a person. Shown on the Access page when
 * approvals are on. Approve lets the model run that one call; Reject tells it no.
 */
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import type { ApprovalRequest } from "../../src/core/approvals";
import { api, postJson } from "./api";
import { MonitorButton, MonitorEmpty, MonitorNote, MonitorPanel, RiskBadge } from "./monitoring-ui";

interface ApprovalsPayload {
  enabled: boolean;
  minRisk: string;
  ttlMinutes: number;
  requests: ApprovalRequest[];
}

const clock = (at: number): string => new Date(at).toLocaleTimeString();

export function ApprovalsPanel(): ReactNode {
  const [data, setData] = useState<ApprovalsPayload | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await api<ApprovalsPayload>("/api/approvals"));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  const decide = async (id: string, approve: boolean): Promise<void> => {
    setBusy(id);
    try {
      const result = await postJson<{ error?: string }>("/api/approvals/decide", { id, approve });
      setError(result.error ?? "");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  if (!data?.enabled) return null;
  const pending = data.requests.filter((r) => r.status === "pending");
  const recent = data.requests.filter((r) => r.status !== "pending").slice(0, 8);

  return (
    <MonitorPanel
      title="Approvals"
      description={`A ${data.minRisk} change or above waits here for you. An approval is for one call and lasts ${data.ttlMinutes} minutes.`}
    >
      {error && (
        <MonitorNote tone="bad" role="alert">
          {error}
        </MonitorNote>
      )}
      {pending.length === 0 && <MonitorEmpty compact title="No change is waiting for approval." />}
      <ul className="approvals-list">
        {pending.map((request) => (
          <li key={request.id} className="approvals-item" data-pending="">
            <div className="approvals-head">
              <RiskBadge risk={request.risk} />
              <b>{request.title}</b>
              <span className="mono">{request.tool}</span>
              {request.device && <span className="approvals-device">on {request.device}</span>}
              <span className="approvals-time">
                asked {clock(request.requestedAt)} · expires {clock(request.expiresAt)}
              </span>
            </div>
            {request.reason && <p className="approvals-reason">Reason given: {request.reason}</p>}
            <pre className="approvals-args">{JSON.stringify(request.args, null, 2)}</pre>
            <div className="approvals-actions">
              <MonitorButton
                variant="primary"
                size="sm"
                disabled={busy === request.id}
                onClick={() => void decide(request.id, true)}
              >
                Approve this call
              </MonitorButton>
              <MonitorButton
                variant="danger"
                size="sm"
                disabled={busy === request.id}
                onClick={() => void decide(request.id, false)}
              >
                Reject
              </MonitorButton>
            </div>
          </li>
        ))}
        {recent.map((request) => (
          <li key={request.id} className="approvals-item">
            <div className="approvals-head">
              <span className="approvals-status" data-status={request.status}>
                {request.status}
              </span>
              <b>{request.title}</b>
              <span className="mono">{request.tool}</span>
              {request.device && <span className="approvals-device">on {request.device}</span>}
              <span className="approvals-time">
                {clock(request.decidedAt ?? request.requestedAt)}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </MonitorPanel>
  );
}
