/**
 * Releases & Updates view — a version timeline that detects a newer release,
 * shows every published release with its rendered notes, and installs/upgrades/
 * downgrades to a specific version (`bun i -g @usex/mikrotik-mcp@<v>`) then
 * self-restarts the server onto it.
 */
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  ExternalLink,
  RefreshCw,
} from "lucide-react";
import { api, postJson } from "./api";
import { LoadingState } from "./loading-state";
import { MARKDOWN } from "./whats-new";
import { renderMarkdown } from "./markdown";
import { toast } from "./toast-action";
import { cn } from "@/lib/utils";
import {
  Metric,
  MetricStrip,
  MonitorButton,
  MonitorDialog,
  MonitorNote,
  MonitorPanel,
  PageIntro,
  StatusBadge,
} from "./monitoring-ui";
import { ReleaseDowngradeButton } from "./release-actions";
import { VersionLane } from "./release-lane";
import "./monitoring.css";
import "./releases.css";

type Relation = "current" | "newer" | "older";

export interface ReleaseItem {
  version: string;
  name: string;
  body: string;
  publishedAt: string;
  url: string;
  prerelease: boolean;
  relation: Relation;
}

interface ReleasesPayload {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releases: ReleaseItem[];
  fetchedAt: number;
}

interface UpgradeResult {
  ok?: boolean;
  version?: string;
  log?: string;
  restarting?: boolean;
  note?: string;
  error?: string;
}

const PKG = "@usex/mikrotik-mcp";

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

/** "2 min ago" split into the number and its unit, for the KPI card. */
function agoParts(ts: number, now = Date.now()): [string, string] {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return [String(s), "s ago"];
  const m = Math.round(s / 60);
  if (m < 60) return [String(m), "min ago"];
  const h = Math.round(m / 60);
  if (h < 48) return [String(h), "h ago"];
  return [String(Math.round(h / 24)), "days ago"];
}

/** What installing this version means relative to the running one. */
function verb(rel: Relation): { label: string; icon: ReactNode; what: string } {
  if (rel === "current")
    return {
      label: "Reinstall",
      icon: <RefreshCw aria-hidden="true" />,
      what: "Installs this version again and restarts the server.",
    };
  if (rel === "newer")
    return {
      label: "Upgrade",
      icon: <ChevronUp aria-hidden="true" />,
      what: "Installs a newer version and restarts the server.",
    };
  return {
    label: "Downgrade",
    icon: <ChevronDown aria-hidden="true" />,
    what: "Installs an older version and restarts the server.",
  };
}

/** Markdown release notes — sanitized/escaped by renderMarkdown (same as whats-new). */
function Notes({ body }: { body: string }): ReactNode {
  if (!body.trim()) return <p className="monitor-hint">No release notes.</p>;
  return (
    <div
      className={cn(MARKDOWN, "release-notes")}
      // eslint-disable-next-line react/no-danger -- HTML is escaped in renderMarkdown
      dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }}
    />
  );
}

export function ReleasesView(): ReactNode {
  const [data, setData] = useState<ReleasesPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<ReleaseItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string | null>(null);

  const load = useCallback(() => {
    return api<ReleasesPayload>("/api/releases")
      .then((r) => {
        setData(r);
        setError(null);
        const latest = r.releases.find((x) => x.version === r.latestVersion);
        if (latest) setExpanded(new Set([latest.version]));
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : "Could not load releases");
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (v: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });

  async function install(version: string): Promise<void> {
    setPending(null);
    setBusy(true);
    setLog(null);
    const id = toast.loading(`Installing ${PKG}@${version}…`);
    try {
      const r = await postJson<UpgradeResult>("/api/upgrade", { version });
      if (r?.ok) {
        setLog(r.log ?? null);
        toast.success(`Installed v${r.version}`, {
          id,
          description: r.restarting ? "Restarting on the new version — reconnect shortly." : r.note,
        });
      } else {
        setLog(r?.log ?? null);
        toast.error(r?.error ?? "Install failed", {
          id,
          description: "See the install log below.",
        });
      }
    } catch {
      toast.error("Install failed (server unreachable)", { id });
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <LoadingState label="Loading releases" layout="cards" />;
  }
  if (error || !data) {
    return (
      <MonitorNote tone="bad" role="alert" icon={<AlertTriangle aria-hidden="true" />}>
        <b>Couldn't load releases.</b> {error ?? "No data."} Check network access to GitHub.
      </MonitorNote>
    );
  }

  const latest = data.releases.find((r) => r.version === data.latestVersion) ?? null;
  const ahead = data.releases.filter((r) => r.relation === "newer" && !r.prerelease).length;
  const pre = data.releases.filter((r) => r.prerelease).length;
  const [agoN, agoUnit] = agoParts(data.fetchedAt);
  const recheck = (): void => {
    setLoading(true);
    void load();
  };

  return (
    <div className="releases-page flex min-w-0 flex-col gap-[18px]">
      <PageIntro
        eyebrow="Running version"
        verdict={
          <>
            v{data.currentVersion}.{" "}
            {data.updateAvailable && data.latestVersion ? (
              <span className="s">v{data.latestVersion} is available.</span>
            ) : (
              <span className="s">You are up to date.</span>
            )}
          </>
        }
        lead="Update, downgrade or read any version's notes. Installing relaunches the server and drops this connection for a moment."
        aside={
          <div className="release-hero-actions">
            <MonitorButton
              variant="ghost"
              onClick={recheck}
              title="Re-check for updates"
              icon={<RefreshCw aria-hidden="true" />}
            >
              Re-check
            </MonitorButton>
            {data.updateAvailable && latest && (
              <MonitorButton
                variant="primary"
                onClick={() => setPending(latest)}
                disabled={busy}
                icon={<ChevronUp aria-hidden="true" />}
              >
                Upgrade to latest
              </MonitorButton>
            )}
          </div>
        }
      />
      {data.releases.length > 1 && (
        <section className="glass release-lane-wrap" aria-label="Version lane">
          <VersionLane releases={data.releases} latest={data.latestVersion} />
        </section>
      )}
      <MetricStrip label="Release summary" minCell={200}>
        <Metric label="Running" value={`v${data.currentVersion}`} hint={`Package ${PKG}`} />
        <Metric
          label="Latest"
          tone={data.updateAvailable ? "good" : "default"}
          value={data.latestVersion ? `v${data.latestVersion}` : "—"}
          hint={
            ahead
              ? `${ahead} stable release${ahead === 1 ? "" : "s"} ahead`
              : "You run the latest stable"
          }
        />
        <Metric
          label="Releases listed"
          value={data.releases.length}
          hint={`${pre} pre-release${pre === 1 ? "" : "s"}`}
        />
        <Metric
          label="Checked"
          value={
            <>
              {agoN}
              <small>{agoUnit}</small>
            </>
          }
          hint="From GitHub releases"
        />
      </MetricStrip>

      {log && (
        <MonitorPanel title="Install log">
          <pre className="monitor-pre max-h-52 overflow-auto">{log}</pre>
        </MonitorPanel>
      )}

      <MonitorPanel
        title="Release history"
        description="Newest first. Open notes to read what changed."
      >
        <ol className="release-timeline" aria-label="Release history">
          {data.releases.map((r, i) => {
            const isOpen = expanded.has(r.version);
            const isCurrent = r.relation === "current";
            const isLatest = r.version === data.latestVersion;
            const v = verb(r.relation);
            return (
              <li key={r.version}>
                <div className="release-timeline-rail" aria-hidden="true">
                  <span
                    className="release-timeline-node"
                    data-relation={r.relation}
                    data-latest={isLatest || undefined}
                  >
                    {isCurrent && <Check />}
                  </span>
                  {i < data.releases.length - 1 && <span className="release-timeline-line" />}
                </div>
                <div
                  className="glass release-card"
                  data-current={isCurrent || undefined}
                  data-latest={(isLatest && !isCurrent) || undefined}
                >
                  <div className="release-row-header">
                    <button
                      type="button"
                      onClick={() => toggle(r.version)}
                      className="release-version"
                      title={isOpen ? "Hide notes" : "Show notes"}
                    >
                      <b>v{r.version}</b>
                      <span>{fmtDate(r.publishedAt)}</span>
                    </button>
                    {isLatest && (
                      <StatusBadge tone="good" dot={false}>
                        latest
                      </StatusBadge>
                    )}
                    {isCurrent && <StatusBadge tone="good">current</StatusBadge>}
                    {r.prerelease && <StatusBadge dot={false}>pre-release</StatusBadge>}
                    <span className="flex-1" />
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="monitor-icon-btn"
                      title="Open on GitHub"
                      aria-label={`Open v${r.version} on GitHub`}
                    >
                      <ExternalLink aria-hidden="true" />
                    </a>
                    <MonitorButton
                      size="sm"
                      variant="ghost"
                      onClick={() => toggle(r.version)}
                      aria-expanded={isOpen}
                      icon={
                        isOpen ? (
                          <ChevronUp aria-hidden="true" />
                        ) : (
                          <ChevronDown aria-hidden="true" />
                        )
                      }
                    >
                      {isOpen ? "Hide notes" : "Notes"}
                    </MonitorButton>
                    {r.relation === "older" ? (
                      <ReleaseDowngradeButton
                        version={r.version}
                        disabled={busy}
                        onReview={() => setPending(r)}
                      />
                    ) : (
                      <MonitorButton
                        size="sm"
                        variant={r.relation === "newer" ? "primary" : "glass"}
                        onClick={() => setPending(r)}
                        disabled={busy}
                        title={`${v.label} to v${r.version}`}
                        icon={v.icon}
                      >
                        {v.label}
                      </MonitorButton>
                    )}
                  </div>
                  {isOpen && (
                    <div className="release-notes-wrap">
                      <Notes body={r.body} />
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </MonitorPanel>

      <MonitorDialog
        open={pending !== null}
        onOpenChange={(o) => !o && setPending(null)}
        confirm
        title={pending ? `${verb(pending.relation).label} to v${pending.version}?` : ""}
        description={pending ? verb(pending.relation).what : undefined}
        footer={
          <>
            <span className="flex-1" />
            <MonitorButton onClick={() => setPending(null)}>Cancel</MonitorButton>
            <MonitorButton
              variant={pending?.relation === "older" ? "danger" : "primary"}
              icon={pending ? verb(pending.relation).icon : null}
              onClick={() => pending && void install(pending.version)}
            >
              {pending ? verb(pending.relation).label : "Install"}
            </MonitorButton>
          </>
        }
      >
        {pending && (
          <div className="monitor-dialog-body flex flex-col gap-4">
            <p className="text-sm leading-[22px] text-fg-secondary">
              This runs the command below on the server. The server then relaunches on v
              {pending.version} and this connection drops for a moment. Reconnect after.
            </p>
            <pre className="monitor-pre">
              <span className="text-success">$</span> bun i -g {PKG}@{pending.version}
            </pre>
            <div className="release-swap">
              <div className="glass">
                <span className="monitor-hint">Now</span>
                <b>v{data.currentVersion}</b>
              </div>
              <ChevronRight
                aria-hidden="true"
                className={pending.relation === "older" ? "text-destructive" : "text-success"}
              />
              <div className="glass" data-tone={pending.relation === "older" ? "bad" : "good"}>
                <span className="monitor-hint">After restart</span>
                <b>v{pending.version}</b>
              </div>
            </div>
            {pending.relation === "older" && (
              <MonitorNote tone="bad" icon={<AlertTriangle aria-hidden="true" />}>
                <b>Downgrade.</b> A newer config may not load on an older build. Save a config
                checkpoint first if you are unsure.
              </MonitorNote>
            )}
          </div>
        )}
      </MonitorDialog>

      <p className="monitor-hint flex flex-wrap items-center gap-1.5">
        <Copy aria-hidden="true" className="size-[13px]" /> Prefer the CLI? Run{" "}
        <span className="monitor-chip">bun i -g {PKG}@latest</span>
      </p>
    </div>
  );
}
