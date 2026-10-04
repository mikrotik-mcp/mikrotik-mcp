import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ArrowRight, Layers } from "lucide-react";
import { api } from "./api";
import { Button, Select } from "./geist";

type Row = Record<string, string>;
type List = { available: boolean; rows: Row[] };

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
  return (
    <section
      aria-label={`${label} settings`}
      className="mb-3.5 grid gap-4 rounded-lg border border-brand/25 bg-brand/5 p-3.5 sm:grid-cols-2"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Layers className="size-4 shrink-0 text-brand" aria-hidden="true" />
          {label}
          <span className="font-normal text-muted-foreground">· optional</span>
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          {user
            ? "Choose the profile this user should use. Save to activate your selection."
            : "Assign a service profile as part of creating this user."}
        </p>
        {user && data && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs" aria-live="polite">
            <span className="text-muted-foreground">Current</span>
            <span className="break-all rounded-md border border-border bg-background px-2 py-1 font-mono">
              {ambiguous ? "Multiple active profiles" : current || "No active profile"}
            </span>
            {changed && (
              <>
                <ArrowRight className="size-3.5 text-brand" aria-hidden="true" />
                <span className="break-all rounded-md border border-brand/30 bg-brand/10 px-2 py-1 font-mono text-brand">
                  {value}
                </span>
              </>
            )}
          </div>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          Profile rules apply when User Manager’s “Use profiles” setting is enabled.
        </p>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <Select
          aria-label={label}
          className="w-full"
          value={value}
          onValueChange={(next) => onChange(user && next === current ? "" : next)}
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
          <div className="text-xs text-destructive" role="alert">
            {error}
            <Button
              size="sm"
              ghost
              disabled={disabled}
              className="mt-2"
              onClick={() => {
                setData(null);
                setError(null);
                setAttempt((n) => n + 1);
              }}
            >
              Retry profiles
            </Button>
          </div>
        ) : ambiguous ? (
          <p role="alert" className="text-xs text-warning">
            Review the Assignments tab before changing this profile. Other user settings can still
            be saved.
          </p>
        ) : data?.profiles.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No profiles yet. Create one in the Profiles tab, or continue without changing
            assignments.
          </p>
        ) : selected ? (
          <p className="text-xs text-muted-foreground">
            {selected.validity && <>Validity: {selected.validity} · </>}
            {user
              ? "Activated when saved"
              : selected["starts-when"] === "first-auth"
                ? "Starts on first authentication"
                : selected["starts-when"] === "assigned"
                  ? "Starts immediately when assigned"
                  : "Uses the profile’s activation settings"}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {user ? "No profile change selected." : "Existing users and profiles are not changed."}
          </p>
        )}
        {user && changed && (
          <p className="text-xs text-warning" role="status">
            Previous assignments and history are kept. A new assignment starts a new validity
            period; an existing eligible one keeps its expiry. Existing connections may need to
            reconnect for new limits.
          </p>
        )}
        {user && data && data.assignments.length > 1 && (
          <p className="text-xs text-muted-foreground">
            {data.assignments.length} assignments retained. Queued profiles may take over when the
            active one expires; manage them in Assignments.
          </p>
        )}
      </div>
    </section>
  );
}
