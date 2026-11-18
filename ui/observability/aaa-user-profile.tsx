import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { api } from "./api";
import { AaaSelect } from "./aaa-ui";
import { MonitorButton } from "./monitoring-ui";

type Row = Record<string, string>;
type List = { available: boolean; rows: Row[] };

/** When a chosen profile starts, as the second half of the hint sentence. */
function activation(profile: Row, editing: boolean): string {
  if (editing) return "activated when saved.";
  if (profile["starts-when"] === "first-auth") return "starts on first authentication.";
  if (profile["starts-when"] === "assigned") return "starts as soon as it is assigned.";
  return "uses the profile’s activation settings.";
}

/** Router-scoped profile picker. Blank in edit mode explicitly means leave assignments alone. */
export function UserProfileField({
  device,
  user,
  value,
  onChange,
  onReadyChange,
  disabled,
}: {
  device: string;
  user?: string;
  value: string;
  onChange: (value: string) => void;
  onReadyChange: (ready: boolean) => void;
  disabled: boolean;
}): ReactNode {
  const [data, setData] = useState<{ profiles: Row[]; assignments: Row[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const q = `?device=${encodeURIComponent(device)}`;
    void Promise.all([
      api<List>(`/api/aaa/list/um-profiles${q}`, controller.signal),
      user
        ? api<List>(`/api/aaa/list/um-user-profiles${q}`, controller.signal)
        : Promise.resolve({ available: true, rows: [] } as List),
    ])
      .then(([profiles, assignments]) => {
        if (controller.signal.aborted) return;
        if (!profiles.available || !assignments.available)
          throw new Error("User Manager profiles are unavailable on this device.");
        setData({
          profiles: profiles.rows.filter((row) => row.name),
          assignments: assignments.rows.filter((row) => row.user === user),
        });
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "Unable to load profiles.");
      });
    return () => controller.abort();
  }, [device, user, attempt]);
  const selected = data?.profiles.find((row) => row.name === value);
  const active =
    data?.assignments.filter((row) => row.state?.replaceAll(" ", "-") === "running-active") ?? [];
  const current = active.length === 1 ? active[0].profile : "";
  const ambiguous = active.length > 1;
  useEffect(() => {
    onReadyChange(!!data && !error && !ambiguous && (!value || !!selected));
  }, [data, error, ambiguous, value, selected, onReadyChange]);
  const changed = !!value && value !== current;
  const label = user ? "Service profile" : "Initial profile";
  const rules = "Profile rules apply when User Manager’s “Use profiles” setting is on.";
  return (
    <section aria-label={`${label} settings`} className="aaa-profile glass">
      <div className="aaa-profile-head">
        <b>{label}</b>
        <span>optional</span>
      </div>
      <span className="monitor-hint">
        {user
          ? "Choose the profile this user should use. Save to activate your selection."
          : "Assign a service profile as part of creating this user."}
      </span>
      {user && data && (
        <div className="aaa-profile-change" aria-live="polite">
          <span className="text-muted-foreground">Current</span>
          <span className="monitor-chip">
            {ambiguous ? "Multiple active profiles" : current || "No active profile"}
          </span>
          {changed && (
            <>
              <ArrowRight aria-hidden="true" />
              <span className="monitor-chip" data-tone="good">
                {value}
              </span>
            </>
          )}
        </div>
      )}
      <AaaSelect
        label={label}
        value={value}
        onChange={(next) => onChange(user && next === current ? "" : next)}
        disabled={disabled || !data || !!error || ambiguous}
        options={[
          {
            value: "",
            label:
              !data && !error
                ? "Loading profiles…"
                : user
                  ? current
                    ? `Keep current · ${current}`
                    : "Keep existing assignments"
                  : "No profile — assign later",
          },
          ...(data?.profiles ?? []).map((row) => ({ value: row.name, label: row.name })),
        ]}
      />
      {error ? (
        <div className="aaa-profile-error" role="alert">
          <span>{error}</span>
          <MonitorButton
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => {
              setData(null);
              setError(null);
              setAttempt((n) => n + 1);
            }}
          >
            Retry profiles
          </MonitorButton>
        </div>
      ) : ambiguous ? (
        <p role="alert" className="monitor-hint text-warning">
          Review the Assignments tab before changing this profile. Other user settings can still be
          saved.
        </p>
      ) : data?.profiles.length === 0 ? (
        <p className="monitor-hint">
          No profiles yet. Create one in the Profiles tab, or continue without changing assignments.
        </p>
      ) : selected ? (
        <p className="monitor-hint">
          {selected.validity
            ? `Validity: ${selected.validity} · ${activation(selected, !!user)}`
            : activation(selected, !!user).replace(/^./, (c) => c.toUpperCase())}{" "}
          {rules}
        </p>
      ) : (
        <p className="monitor-hint">
          {user ? "No profile change selected." : "Existing users and profiles are not changed."}{" "}
          {rules}
        </p>
      )}
      {user && changed && (
        <p className="monitor-hint text-warning" role="status">
          Previous assignments and history are kept. A new assignment starts a new validity period;
          an existing eligible one keeps its expiry. Existing connections may need to reconnect for
          new limits.
        </p>
      )}
      {user && data && data.assignments.length > 1 && (
        <p className="monitor-hint">
          {data.assignments.length} assignments retained. Queued profiles may take over when the
          active one expires; manage them in Assignments.
        </p>
      )}
    </section>
  );
}
