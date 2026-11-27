import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { ArrowUpRight, ChevronDown, X } from "lucide-react";
import { Dialog } from "radix-ui";
import type { ReleasePayload } from "../../src/core/update-check";
import { api } from "./api";
import { BrandMark } from "./dashboard-shell";
import { parseRelease } from "./release-notes";
import type { ReleaseSection } from "./release-notes";
import "./whats-new.css";

export const MARKDOWN =
  "text-[13px] leading-[1.7] text-muted-foreground " +
  "[&_h2]:mt-[18px] [&_h2]:mb-1.5 [&_h2]:text-[17px] [&_h2]:font-bold [&_h2]:text-foreground " +
  "[&_h3]:mt-[18px] [&_h3]:mb-1.5 [&_h3]:text-[15px] [&_h3]:font-bold [&_h3]:text-foreground " +
  "[&_h4]:mt-[18px] [&_h4]:mb-1.5 [&_h4]:text-[14px] [&_h4]:font-bold [&_h4]:text-foreground " +
  "[&_h5]:mt-[18px] [&_h5]:mb-1.5 [&_h5]:text-[14px] [&_h5]:font-bold [&_h5]:text-foreground " +
  "[&_p]:my-[5px] " +
  // Preflight resets `list-style: none` on ul/ol, so the markers must be asked
  // for explicitly — without these the release notes render as unbulleted lines.
  "[&_ul]:my-[5px] [&_ul]:list-disc [&_ul]:pl-[18px] [&_ol]:my-[5px] [&_ol]:list-decimal [&_ol]:pl-[22px] " +
  "[&_li]:my-[3px] [&_li]:marker:text-brand " +
  "[&_img]:my-1.5 [&_img]:max-w-full [&_img]:rounded-md [&_img]:border [&_img]:border-border " +
  "[&_code]:rounded [&_code]:border [&_code]:border-border [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs [&_code]:text-brand " +
  "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border [&_pre]:bg-background [&_pre]:p-3 " +
  "[&_pre_code]:border-0 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-muted-foreground " +
  "[&_a]:text-brand [&_a]:underline [&_a]:underline-offset-2 " +
  "[&_strong]:font-semibold [&_strong]:text-foreground " +
  "[&_blockquote]:my-2 [&_blockquote]:border-l-[3px] [&_blockquote]:border-brand/40 [&_blockquote]:px-3.5 [&_blockquote]:py-1.5 [&_blockquote]:italic " +
  "[&_hr]:my-3.5 [&_hr]:border-0 [&_hr]:border-t [&_hr]:border-border " +
  "[&_del]:text-muted-foreground [&_del]:opacity-60 " +
  "[&_table]:w-full [&_table]:border-collapse [&_table]:font-mono [&_table]:text-xs " +
  "[&_th]:border-b [&_th]:border-border [&_th]:bg-muted [&_th]:px-3 [&_th]:py-[7px] [&_th]:text-left [&_th]:text-[11px] [&_th]:font-semibold [&_th]:tracking-wide [&_th]:text-foreground [&_th]:uppercase " +
  "[&_td]:border-b [&_td]:border-border [&_td]:px-3 [&_td]:py-[7px] [&_td]:text-muted-foreground " +
  "[&_.wn-table-wrap]:my-2.5 [&_.wn-table-wrap]:overflow-x-auto [&_.wn-table-wrap]:rounded-md [&_.wn-table-wrap]:border [&_.wn-table-wrap]:border-border " +
  "[&_.wn-task]:-ml-[18px] [&_.wn-task]:list-none [&_.wn-check]:inline-block [&_.wn-check]:w-4 [&_.wn-task.done_.wn-check]:text-success";

type Target = { installed: string; from?: string; available?: ReleasePayload };
const SEEN = "mt-whats-new-seen-version";
const DISMISSED = "mt-whats-new-dismissed";

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Storage can be disabled. */
  }
}

export function useWhatsNew(installed: string | undefined) {
  const [target, setTarget] = useState<Target | null>(null);
  const [latest, setLatest] = useState<ReleasePayload | null>(null);
  const visit = useRef<{ version: string; from?: string } | null>(null);

  useEffect(() => {
    if (!installed) return;
    if (visit.current?.version !== installed) {
      const previous = stored(SEEN);
      visit.current = {
        version: installed,
        from: previous && previous !== installed ? previous : undefined,
      };
      remember(SEEN, installed);
    }
    const from = visit.current.from;
    if (from) setTarget({ installed, from });
    const controller = new AbortController();
    let lastNotification: string | undefined;
    const check = async () => {
      try {
        const release = await api<ReleasePayload>("/api/releases/latest", controller.signal);
        if (controller.signal.aborted || release.currentVersion !== installed) return;
        setLatest(release);
        if (
          release.isNewer &&
          release.version !== lastNotification &&
          stored(DISMISSED) !== release.version
        ) {
          if (!from || lastNotification)
            setTarget((open) => open ?? { installed, available: release });
          lastNotification = release.version;
        }
      } catch {
        /* Update notifications are best effort. */
      }
    };
    void check();
    const timer = setInterval(() => void check(), 600_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [installed]);

  return {
    target: target?.installed === installed ? target : null,
    showIndicator: latest?.currentVersion === installed && latest?.isNewer === true,
    openModal: installed ? () => setTarget({ installed, from: visit.current?.from }) : undefined,
    dismissRelease: () => {
      if (target?.available) remember(DISMISSED, target.available.version);
      setTarget(null);
    },
  };
}

function Markdown({ html }: { html: string }) {
  // eslint-disable-next-line react/no-danger -- rendered release Markdown
  return <div className="rn-md" dangerouslySetInnerHTML={{ __html: html }} />;
}

function Section({ section, fold }: { section: ReleaseSection; fold: boolean }) {
  const [expanded, setExpanded] = useState(!fold);
  const { count, title, features, introHtml } = section;
  return (
    <section
      className="rn-section"
      data-kind={section.kind}
      data-improved={/improv|changed/i.test(title) || undefined}
    >
      <h3>
        <i aria-hidden="true" />
        {title}
        {count !== null && <span>{count}</span>}
      </h3>
      {fold && (
        <button
          type="button"
          className="rn-disclose"
          aria-expanded={expanded}
          aria-controls={section.id}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Hide" : "Show"} {count ?? ""} {count === 1 ? "fix" : "fixes"}{" "}
          <ChevronDown aria-hidden="true" />
        </button>
      )}
      <div id={section.id} hidden={!expanded}>
        {introHtml && <Markdown html={introHtml} />}
        {features.map((f) => (
          <article className="rn-feature" key={f.id}>
            <h4>{f.title}</h4>
            <Markdown html={f.html} />
          </article>
        ))}
      </div>
    </section>
  );
}

function copyCommand(e: MouseEvent<HTMLDivElement>): void {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-copy]");
  const code = btn?.parentElement?.querySelector("code");
  if (!code || !btn) return;
  void navigator.clipboard
    ?.writeText(code.textContent ?? "")
    .then(() => {
      const label = btn.lastChild;
      if (label?.nodeType !== Node.TEXT_NODE) return;
      label.textContent = "Copied";
      setTimeout(() => {
        label.textContent = "Copy";
      }, 1600);
    })
    .catch(() => {});
}

export function WhatsNewModal({
  target,
  onDismiss,
}: {
  target: Target;
  onDismiss: () => void;
}): ReactNode {
  const { installed, available, from } = target;
  const version = available?.version ?? installed;
  const [notes, setNotes] = useState<ReleasePayload | null | undefined>(available);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (available) return;
    const controller = new AbortController();
    void api<ReleasePayload | null>("/api/releases/current", controller.signal)
      .then((r) => {
        if (controller.signal.aborted) return;
        if (r && r.version !== installed) throw new Error("Running version changed");
        setNotes(r);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [available, installed, retry]);

  const parsed = useMemo(() => parseRelease(notes?.body ?? ""), [notes?.body]);
  const date = Date.parse(notes?.publishedAt ?? "");
  const subtitle = available
    ? `v${version} available · Running v${installed}`
    : from
      ? `Updated from v${from} to v${version}`
      : `Version ${version}`;
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="monitor-scrim fixed inset-0 z-50" />
        <Dialog.Content
          className="rn"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            bodyRef.current?.focus();
          }}
        >
          <header className="rn-header">
            <div className="rn-mark">
              <BrandMark />
            </div>
            <Dialog.Title>What’s new in MikroTik MCP</Dialog.Title>
            <Dialog.Description>
              {subtitle}
              {Number.isFinite(date) && (
                <>
                  {" "}
                  ·{" "}
                  {new Date(date).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </>
              )}
            </Dialog.Description>
            <Dialog.Close className="rn-close" aria-label="Close release notes">
              <X size={16} />
            </Dialog.Close>
          </header>
          {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- delegated native Copy buttons */}
          <div className="rn-scroll" tabIndex={-1} ref={bodyRef} onClick={copyCommand}>
            {error ? (
              <div role="status">
                Couldn’t load the notes for v{version}.{" "}
                <button
                  className="rn-disclose"
                  onClick={() => {
                    setError(false);
                    setRetry((n) => n + 1);
                  }}
                >
                  Try again
                </button>
              </div>
            ) : notes === undefined ? (
              <p role="status">Loading release notes…</p>
            ) : (
              <>
                {parsed.introHtml && <Markdown html={parsed.introHtml} />}
                {parsed.sections.map((section, i) => (
                  <Section
                    key={section.id}
                    section={section}
                    fold={section.kind === "fixes" && i > 0}
                  />
                ))}
                {!parsed.introHtml && !parsed.sections.length && (
                  <p>No release notes have been published for v{version}.</p>
                )}
              </>
            )}
          </div>
          <footer className="rn-footer">
            {notes?.url && (
              <a href={notes.url} target="_blank" rel="noopener noreferrer">
                Full changelog <ArrowUpRight size={14} aria-hidden="true" />
              </a>
            )}
            <Dialog.Close className="rn-done">Got it</Dialog.Close>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
