/**
 * Release notes: checks GitHub for a newer version and shows the notes in a
 * dialog with numbered sections, a rail to move between them and a version path.
 * Built from the "Release notes dialog" boards in the Signal canvas.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { animate, svg } from "animejs";
import { ExternalLink, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { api } from "./api";
import { MonitorButton } from "./monitoring-ui";
import { parseRelease, releasedAgo } from "./release-notes";
import type { ReleaseSection } from "./release-notes";
import "./monitoring.css";
import "./whats-new.css";

// ── Types ────────────────────────────────────────────────────────────────────

interface ReleaseInfo {
  version: string;
  name: string;
  body: string;
  publishedAt: string;
  url: string;
  isNewer: boolean;
  currentVersion: string;
}

// ── localStorage helpers ─────────────────────────────────────────────────────

const LS_KEY = "mt-whats-new-dismissed";
const LS_SEEN_KEY = "mt-whats-new-seen-version";

function isDismissed(version: string): boolean {
  try {
    return localStorage.getItem(LS_KEY) === version;
  } catch {
    return false;
  }
}

function dismiss(version: string): void {
  try {
    localStorage.setItem(LS_KEY, version);
  } catch {
    /* storage unavailable */
  }
}

/** Returns true when the running version changed since the last dashboard visit. */
function checkVersionChanged(version: string): boolean {
  try {
    const prev = localStorage.getItem(LS_SEEN_KEY);
    localStorage.setItem(LS_SEEN_KEY, version);
    return prev !== null && prev !== version;
  } catch {
    return false;
  }
}

// ── Rendered-markdown styling ────────────────────────────────────────────────
// The release body is injected HTML (see `./markdown`), so its descendant tags
// are styled via arbitrary variants on the container rather than a stylesheet.
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

// ── Hook ─────────────────────────────────────────────────────────────────────

const POLL_INTERVAL = 10 * 60 * 1000; // 10 minutes

export function useWhatsNew(currentVersion: string | undefined): {
  release: ReleaseInfo | null;
  showModal: boolean;
  showIndicator: boolean;
  openModal: () => void;
  dismissRelease: () => void;
} {
  const [release, setRelease] = useState<ReleaseInfo | null>(null);
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    if (!currentVersion) return;

    // Detect if the running server version changed since the last visit (user updated)
    const justUpdated = checkVersionChanged(currentVersion);
    let prevFetchedVersion: string | null = null;

    const fetchRelease = (): void => {
      api<ReleaseInfo>("/api/releases/latest")
        .then((r) => {
          setRelease(r);

          const isFirst = prevFetchedVersion === null;
          const newRemoteVersion = prevFetchedVersion !== null && r.version !== prevFetchedVersion;
          prevFetchedVersion = r.version;

          // Auto-show when user just updated the project (show current changelog)
          if (isFirst && justUpdated) {
            setTimeout(() => setShowModal(true), 1200);
            return;
          }
          // Auto-show when a newer version is discovered (on load or via poll)
          if (r.isNewer && !isDismissed(r.version) && (isFirst || newRemoteVersion)) {
            setTimeout(() => setShowModal(true), isFirst ? 1200 : 0);
          }
        })
        .catch(() => {
          /* silent — update check is best-effort */
        });
    };

    fetchRelease();
    const id = setInterval(fetchRelease, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [currentVersion]);

  const dismissRelease = useCallback(() => {
    if (release?.isNewer) dismiss(release.version);
    setShowModal(false);
  }, [release]);

  const openModal = useCallback(() => setShowModal(true), []);

  return {
    release,
    showModal,
    showIndicator: release !== null && release.isNewer,
    openModal,
    dismissRelease,
  };
}

// ── Component ────────────────────────────────────────────────────────────────

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** "6.15.0" → v6.15<faint .>0 */
function Version({ value }: { value: string }): ReactNode {
  const cut = value.lastIndexOf(".");
  if (cut < 0) return <>v{value}</>;
  return (
    <>
      v{value.slice(0, cut)}
      <span>.</span>
      {value.slice(cut + 1)}
    </>
  );
}

/** Two nodes joined by a line: the version you came from, and this release. */
function VersionPath({
  from,
  fromSub,
  to,
  toSub,
  isNew,
}: {
  from: string;
  fromSub: string;
  to: string;
  toSub: string;
  isNew: boolean;
}): ReactNode {
  const ref = useRef<SVGSVGElement>(null);
  const col = isNew ? "var(--page-accent)" : "var(--sig)";
  const dash = isNew ? "4 5" : undefined;
  // The line draws in, then a light pulse runs to the new node now and then.
  useEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion()) return;
    const lines = el.querySelectorAll<SVGLineElement>("line");
    const pulse = el.querySelector<SVGCircleElement>(".rn-pulse");
    const motion = [
      animate(svg.createDrawable(lines), { draw: ["0 0", "0 1"], duration: 700, ease: "outQuart" }),
    ];
    if (pulse)
      motion.push(
        animate(pulse, {
          cx: [30, 289],
          opacity: [0, 1, 1, 0],
          duration: 1400,
          delay: 500,
          ease: "inOutSine",
          loop: true,
          loopDelay: 2600,
        }),
      );
    return () => {
      for (const m of motion) m.revert();
    };
  }, []);
  return (
    <div className="rn-path" aria-hidden="true">
      <svg ref={ref} width="320" height="78" viewBox="0 0 320 78">
        <line
          x1="30"
          y1="26"
          x2="150"
          y2="26"
          stroke="var(--text-faint)"
          strokeWidth="2"
          strokeDasharray={dash}
        />
        <line
          x1="150"
          y1="26"
          x2="289"
          y2="26"
          stroke={col}
          strokeWidth="2"
          opacity=".75"
          strokeDasharray={dash}
        />
        <circle
          className="rn-pulse"
          cx="190"
          cy="26"
          r="3.5"
          fill={col}
          style={{ filter: `drop-shadow(0 0 6px ${col})` }}
        />
        <circle
          cx="24"
          cy="26"
          r="6"
          fill="var(--surface-2)"
          stroke="var(--text-faint)"
          strokeWidth="2"
        />
        <circle cx="296" cy="26" r="12" fill={col} opacity=".16" />
        <circle
          cx="296"
          cy="26"
          r="7"
          fill={col}
          style={{ filter: `drop-shadow(0 0 8px ${col})` }}
        />
        <text x="24" y="58" textAnchor="middle" className="lab">
          {from}
        </text>
        <text x="24" y="74" textAnchor="middle" className="sub">
          {fromSub}
        </text>
        <text x="296" y="58" textAnchor="middle" className="lab">
          {to}
        </text>
        <text x="296" y="74" textAnchor="middle" className="sub">
          {toSub}
        </text>
      </svg>
    </div>
  );
}

function Section({ s }: { s: ReleaseSection }): ReactNode {
  const count =
    s.count == null ? null : s.kind === "features" ? `${s.count} features` : String(s.count);
  return (
    <section className="rn-sec" id={s.id} data-kind={s.kind}>
      <div className="rn-sh">
        <span className="n">{s.index}</span>
        <h3>{s.title}</h3>
        {count && <span className="c">{count}</span>}
      </div>
      {s.introHtml && (
        // eslint-disable-next-line react/no-danger -- escaped by renderMarkdown
        <div className="rn-md" dangerouslySetInnerHTML={{ __html: s.introHtml }} />
      )}
      {s.features.map((f, j) => (
        <article key={f.id} id={f.id} className="rn-feat" data-lead={j === 0}>
          <h4>
            <span className="rn-led" data-tone={j === 0 ? undefined : "acc"} />
            {/* eslint-disable-next-line react/no-danger -- escaped by renderMarkdown */}
            <span dangerouslySetInnerHTML={{ __html: f.titleHtml }} />
          </h4>
          <div
            className="rn-md"
            data-tone={j === 0 ? undefined : "acc"}
            // eslint-disable-next-line react/no-danger -- escaped by renderMarkdown
            dangerouslySetInnerHTML={{ __html: f.html }}
          />
        </article>
      ))}
    </section>
  );
}

export function WhatsNewModal({
  release,
  onDismiss,
}: {
  release: ReleaseInfo;
  onDismiss: () => void;
}): ReactNode {
  const parsed = useMemo(() => parseRelease(release.body), [release.body]);
  const { sections } = parsed;
  const date = new Date(release.publishedAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const ago = releasedAgo(release.publishedAt);
  const from = release.isNewer ? release.currentVersion : parsed.previousVersion;
  const stats = sections.filter((s) => s.count != null).slice(0, 4);

  // The portal mounts its children after the first effects run, so the nodes
  // the effects need are kept as state and the effects wait for them.
  const [overlay, setOverlay] = useState<HTMLDivElement | null>(null);
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const docRef = useRef<HTMLDivElement>(null);
  const [toc, setToc] = useState<HTMLDivElement | null>(null);
  const [active, setActive] = useState(sections[0]?.features[0]?.id ?? sections[0]?.id ?? "");
  const [read, setRead] = useState(0);

  // Scrim fades in, the panel scales up from 0.98 (as MonitorDialog).
  useEffect(() => {
    if (!overlay || !content || reducedMotion()) return;
    const motion = [
      animate(overlay, { opacity: [0, 1], duration: 160, ease: "outQuad" }),
      animate(content, { opacity: [0, 1], scale: [0.98, 1], duration: 220, ease: "outQuart" }),
    ];
    return () => {
      for (const m of motion) m.revert();
    };
  }, [overlay, content]);

  // The section or feature at the top of the reading area, and how far you are.
  const onScroll = useCallback(() => {
    const doc = docRef.current;
    if (!doc) return;
    const max = doc.scrollHeight - doc.clientHeight;
    setRead(max > 0 ? Math.min(100, Math.round((doc.scrollTop / max) * 100)) : 100);
    let current = "";
    for (const el of doc.querySelectorAll<HTMLElement>(".rn-sec, .rn-feat")) {
      if (el.offsetTop - doc.scrollTop <= 80) current = el.id;
      else break;
    }
    if (current) setActive(current);
  }, []);
  useEffect(onScroll, [onScroll, content]);

  // The rail's bar slides to the active entry. The rail mounts inside the
  // dialog's portal after the first effects run, so it is tracked as state.
  useEffect(() => {
    const bar = toc?.querySelector<HTMLElement>(".rn-toc-bar");
    const item = toc?.querySelector<HTMLElement>(`[data-target="${active}"]`);
    if (!bar || !item) return;
    const to = { translateY: item.offsetTop + 6, height: item.offsetHeight - 12 };
    if (reducedMotion() || !bar.style.height) {
      bar.style.transform = `translateY(${to.translateY}px)`;
      bar.style.height = `${to.height}px`;
      return;
    }
    const a = animate(bar, { ...to, duration: 260, ease: "outQuart" });
    return () => {
      a.pause();
    };
  }, [active, toc]);

  const jump = (id: string): void => {
    const doc = docRef.current;
    const el = doc?.querySelector<HTMLElement>(`#${id}`);
    if (!doc || !el) return;
    doc.scrollTo({ top: el.offsetTop - 8, behavior: reducedMotion() ? "auto" : "smooth" });
  };

  // Copy buttons inside the rendered body.
  const onDocClick = (e: MouseEvent<HTMLDivElement>): void => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-copy]");
    const code = btn?.parentElement?.querySelector("code");
    if (!btn || !code) return;
    void navigator.clipboard?.writeText(code.textContent ?? "").then(() => {
      const label = btn.lastChild;
      if (label?.nodeType !== Node.TEXT_NODE) return;
      label.textContent = "Copied";
      setTimeout(() => {
        label.textContent = "Copy";
      }, 1600);
    });
  };

  const activeSection =
    sections.find((s) => s.id === active || s.features.some((f) => f.id === active))?.id ?? "";

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(o) => {
        if (!o) onDismiss();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay ref={setOverlay} className="monitor-scrim fixed inset-0 z-50" />
        <DialogPrimitive.Content
          ref={setContent}
          className="rn"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            docRef.current?.focus({ preventScroll: true });
          }}
        >
          <div className="rn-pbar" aria-hidden="true">
            <i style={{ width: `${read}%` }} />
          </div>
          <div className="rn-hero">
            <div className="min-w-0">
              <p className="rn-eb" data-new={release.isNewer}>
                <span className="rn-led" data-tone={release.isNewer ? "acc" : undefined} />
                {release.isNewer ? "New release" : "Release notes"}
              </p>
              <DialogPrimitive.Title asChild>
                <h2 className="rn-ver">
                  <Version value={release.version} />
                </h2>
              </DialogPrimitive.Title>
              <DialogPrimitive.Description asChild>
                <p className="rn-meta">
                  Released {date}
                  {ago && (
                    <span className="rn-ago">
                      <i />
                      {ago}
                    </span>
                  )}
                  <i />
                  {release.isNewer ? `you run v${release.currentVersion}` : "you run this version"}
                </p>
              </DialogPrimitive.Description>
              {stats.length > 0 && (
                <div className="rn-stats">
                  {stats.map((s) => (
                    <span
                      key={s.id}
                      className="rn-stat"
                      data-tone={s.kind === "upgrade" ? "warn" : undefined}
                    >
                      <b>{s.count}</b>
                      {s.title.toLowerCase()}
                    </span>
                  ))}
                </div>
              )}
            </div>
            {from && (
              <VersionPath
                from={`v${from}`}
                fromSub={release.isNewer ? "you run" : "before"}
                to={`v${release.version}`}
                toSub={release.isNewer ? "available" : "running"}
                isNew={release.isNewer}
              />
            )}
            <DialogPrimitive.Close asChild>
              <button type="button" className="monitor-icon-btn rn-x" aria-label="Close">
                <X aria-hidden="true" />
              </button>
            </DialogPrimitive.Close>
          </div>

          {sections.length > 0 && (
            <nav className="rn-chips" aria-label="Release sections">
              {sections.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  data-on={s.id === activeSection}
                  onClick={() => jump(s.id)}
                >
                  {s.short}
                  {s.count != null && <span className="c">{s.count}</span>}
                </button>
              ))}
            </nav>
          )}

          <div className="rn-body">
            <nav className="rn-rail" aria-label="Release sections">
              <p className="rn-rail-lbl">On this page</p>
              <div className="rn-toc" ref={setToc}>
                <span className="rn-toc-bar" aria-hidden="true" />
                {sections.map((s) => (
                  <div key={s.id} className="contents">
                    <button
                      type="button"
                      data-target={s.id}
                      data-kind={s.kind}
                      data-on={s.id === active}
                      aria-current={s.id === active ? "location" : undefined}
                      onClick={() => jump(s.id)}
                    >
                      <span className="n">{s.index}</span>
                      <span className="t">{s.title}</span>
                      {s.count != null && <span className="c">{s.count}</span>}
                    </button>
                    {s.features.map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        data-sub="true"
                        data-target={f.id}
                        data-on={f.id === active}
                        aria-current={f.id === active ? "location" : undefined}
                        onClick={() => jump(f.id)}
                        title={f.title}
                      >
                        <span className="t">{f.title}</span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
              <div className="rn-prog">
                <div className="rn-prog-t">
                  <span>Read</span>
                  <b>{read}%</b>
                </div>
                <div className="rn-prog-bar">
                  <i style={{ width: `${read}%` }} />
                </div>
                <div className="rn-prog-t">
                  <span>About {parsed.minutes} min</span>
                </div>
              </div>
            </nav>
            {/* Clicks are delegated to the Copy buttons inside the body. */}
            {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
            <div
              className="rn-doc"
              ref={docRef}
              tabIndex={-1}
              onScroll={onScroll}
              onClick={onDocClick}
            >
              {parsed.introHtml && (
                // eslint-disable-next-line react/no-danger -- escaped by renderMarkdown
                <div className="rn-md" dangerouslySetInnerHTML={{ __html: parsed.introHtml }} />
              )}
              {sections.map((s) => (
                <Section key={s.id} s={s} />
              ))}
              {sections.length === 0 && !parsed.introHtml && (
                <p className="rn-hint">This release has no notes.</p>
              )}
            </div>
            <div className="rn-fade" aria-hidden="true" />
          </div>

          <div className="rn-foot">
            <a className="rn-gh" href={release.url} target="_blank" rel="noopener noreferrer">
              <ExternalLink aria-hidden="true" />
              View on GitHub
            </a>
            <span className="sp" />
            <span className="rn-hint">
              <kbd>Esc</kbd> to close
            </span>
            <MonitorButton variant="primary" onClick={onDismiss}>
              Got it
            </MonitorButton>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
