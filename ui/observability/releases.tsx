/**
 * Releases & Updates view — a version timeline that detects a newer release,
 * shows every published release with its rendered notes, and installs/upgrades/
 * downgrades to a specific version (`bun i -g @usex/mikrotik-mcp@<v>`) then
 * self-restarts the server onto it.
 */
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  ExternalLink,
  RefreshCw,
  RotateCw,
  Sparkles,
} from "lucide-react";
import { api, postJson } from "./api";
import { Button, Note, Spinner } from "./geist";
import { MARKDOWN } from "./whats-new";
import { renderMarkdown } from "./markdown";
import { toast } from "./toast-action";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ReleaseDowngradeButton } from "./release-actions";
import "./releases.css";

type Relation = "current" | "newer" | "older";

interface ReleaseItem {
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

/** What installing this version means relative to the running one. */
function verb(rel: Relation): { label: string; icon: ReactNode } {
  if (rel === "current") return { label: "Reinstall", icon: <RotateCw className="size-3.5" /> };
  if (rel === "newer") return { label: "Upgrade", icon: <ArrowUp className="size-3.5" /> };
  return { label: "Downgrade", icon: <ArrowDown className="size-3.5" /> };
}

/** Markdown release notes — sanitized/escaped by renderMarkdown (same as whats-new). */
function Notes({ body }: { body: string }): ReactNode {
  if (!body.trim()) return <p className="text-muted-foreground text-xs">No release notes.</p>;
  return (
    <div
      className={cn(MARKDOWN)}
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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<ReleasesPayload>("/api/releases");
      setData(r);
      setError(null);
      const latest = r.releases.find((x) => x.version === r.latestVersion);
      if (latest) setExpanded(new Set([latest.version]));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load releases");
    } finally {
      setLoading(false);
    }
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

  const latest = data?.releases.find((r) => r.version === data.latestVersion) ?? null;

  const hero = useMemo(() => {
    if (!data) return null;
    return (
      <div className="relative overflow-hidden rounded-xl border bg-card p-6">
        <div className="from-brand/10 pointer-events-none absolute -top-16 -right-16 size-56 rounded-full bg-gradient-to-br to-transparent blur-2xl" />
        <div className="relative flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-muted-foreground text-[11px] font-medium tracking-[0.18em] uppercase">
              Running version
            </span>
            <div className="flex items-baseline gap-3">
              <span className="text-foreground text-[40px] leading-none font-extrabold tracking-tight">
                v{data.currentVersion}
              </span>
              {data.updateAvailable ? (
                <span className="bg-brand/10 text-brand ring-brand/30 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ring-1">
                  <Sparkles className="size-3.5" /> v{data.latestVersion} available
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-500 ring-1 ring-emerald-500/30">
                  <Check className="size-3.5" /> Up to date
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={() => void load()} title="Re-check for updates">
              <RefreshCw className="size-3.5" /> Re-check
            </Button>
            {data.updateAvailable && latest && (
              <Button
                onClick={() => setPending(latest)}
                disabled={busy}
                className="bg-brand text-brand-foreground hover:bg-brand/90 border-transparent"
              >
                <ArrowUp className="size-3.5" /> Upgrade to latest
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }, [data, latest, busy, load]);

  if (loading) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 p-6 text-sm">
        <Spinner /> Loading releases…
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="p-4">
        <Note type="error" label="Couldn't load releases">
          {error ?? "No data."} Check network access to GitHub.
        </Note>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {hero}

      {log && (
        <div className="rounded-lg border bg-card p-3">
          <div className="text-muted-foreground mb-1.5 text-[11px] font-semibold tracking-wide uppercase">
            Install log
          </div>
          <pre className="text-muted-foreground max-h-52 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
            {log}
          </pre>
        </div>
      )}

      <ol className="release-timeline" aria-label="Release history">
        {data.releases.map((r) => {
          const isOpen = expanded.has(r.version);
          const isCurrent = r.relation === "current";
          const isLatest = r.version === data.latestVersion;
          const v = verb(r.relation);
          return (
            <li key={r.version}>
              <div className="release-timeline-rail" aria-hidden="true">
                <span className="release-timeline-node" data-relation={r.relation}>
                  {isCurrent ? <Check className="size-3" /> : <i />}
                </span>
              </div>

              <div
                className={cn(
                  "min-w-0 rounded-lg border bg-card transition-colors",
                  isCurrent && "border-emerald-500/40",
                  isLatest && !isCurrent && "border-brand/40",
                )}
              >
                <div className="release-row-header flex flex-wrap items-center gap-x-3 gap-y-1.5 p-3.5">
                  <button
                    type="button"
                    onClick={() => toggle(r.version)}
                    className="flex items-baseline gap-2 text-left"
                    title={isOpen ? "Hide notes" : "Show notes"}
                  >
                    <span className="text-foreground text-lg font-bold tracking-tight">
                      v{r.version}
                    </span>
                    <span className="text-muted-foreground text-xs">{fmtDate(r.publishedAt)}</span>
                  </button>

                  {isCurrent && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-500 uppercase">
                      current
                    </span>
                  )}
                  {isLatest && !isCurrent && (
                    <span className="bg-brand/10 text-brand rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase">
                      latest
                    </span>
                  )}
                  {r.prerelease && (
                    <span className="text-muted-foreground rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase">
                      pre-release
                    </span>
                  )}

                  <span className="flex-1" />

                  <a
                    href={r.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
                    title="Open on GitHub"
                  >
                    <ExternalLink className="size-3.5" />
                  </a>
                  <Button onClick={() => toggle(r.version)}>
                    {isOpen ? "Hide notes" : "Notes"}
                  </Button>
                  {r.relation === "older" ? (
                    <ReleaseDowngradeButton
                      version={r.version}
                      disabled={busy}
                      onReview={() => setPending(r)}
                    />
                  ) : (
                    <Button
                      onClick={() => setPending(r)}
                      disabled={busy}
                      className={cn(
                        r.relation === "newer" &&
                          "bg-brand text-brand-foreground hover:bg-brand/90 border-transparent",
                      )}
                      title={`${v.label} to v${r.version}`}
                    >
                      {v.icon} {v.label}
                    </Button>
                  )}
                </div>

                {isOpen && (
                  <div className="border-t px-4 py-3.5">
                    <Notes body={r.body} />
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <AlertDialog open={pending !== null} onOpenChange={(o) => !o && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending ? `${verb(pending.relation).label} to v${pending.version}?` : ""}
            </AlertDialogTitle>
            <AlertDialogDescription>
              This runs{" "}
              <code className="text-brand bg-muted rounded px-1.5 py-0.5 font-mono text-xs">
                bun i -g {PKG}@{pending?.version}
              </code>{" "}
              on the server, then the server relaunches on that version and this connection drops
              briefly. Reconnect after.
              {pending?.relation === "older" && (
                <>
                  {" "}
                  <b className="text-destructive">Downgrade</b> — a newer config may not load on an
                  older build; snapshot first if unsure.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={cn(
                buttonVariants({
                  variant: pending?.relation === "older" ? "destructive" : "default",
                }),
                "gap-1.5",
              )}
              onClick={() => pending && void install(pending.version)}
            >
              {pending ? verb(pending.relation).icon : null}
              {pending ? verb(pending.relation).label : "Install"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <p className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
        <Copy className="size-3" /> Prefer the CLI? Run{" "}
        <code className="bg-muted rounded px-1.5 py-0.5 font-mono">bun i -g {PKG}@latest</code>
      </p>
    </div>
  );
}
