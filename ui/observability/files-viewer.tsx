/**
 * The file drawer: view a text file of a router, edit it in place, start a
 * compare, follow it as it grows, and read its details. A `.rsc` file is
 * coloured by RouterOS syntax.
 */
import {
  AlertTriangle,
  ArrowDownToLine,
  Copy,
  Fingerprint,
  GitCompareArrows,
  Upload,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { diffLines } from "../../src/core/diff";
import type { FileKind, FileRef } from "./files-lib";
import {
  baseName,
  compareStore,
  filesApi,
  joinPath,
  kindOf,
  parentOf,
  pickForCompare,
  tailStore,
  transferQueue,
  viewerStore,
} from "./files-lib";
import { Strip, size, stamp, viewerSiblings, viewerTab } from "./files-parts";
import { TailView } from "./files-tail";
import type { DrawerTab } from "./kit";
import { DetailList, RowDrawer } from "./kit";

const KIND_LABEL: Record<FileKind, string> = {
  folder: "Folder",
  backup: "Backup",
  script: "RouterOS script",
  package: "Package",
  text: "Text file",
  key: "Key or certificate",
  support: "Support output",
  web: "Web file",
  image: "Image",
  file: "File",
};

const DRAWER_KEY = "files-viewer";

/** The boards draw these drawers wide: start at the kit's widest unless the user chose a width. */
export function presetWidth(key: string): void {
  try {
    if (!localStorage.getItem(`kit-drawer-w:${key}`))
      localStorage.setItem(`kit-drawer-w:${key}`, "720");
  } catch {
    /* storage unavailable */
  }
}

/** One coloured piece of a line. */
interface Piece {
  text: string;
  cls?: string;
}

/** RouterOS colours: comments faint, menu paths teal, `name=` indigo, quoted values amber. */
function colour(line: string, script: boolean): Piece[] {
  if (!script) return [{ text: line }];
  if (/^\s*#/.test(line)) return [{ text: line, cls: "c4" }];
  if (/^\s*\//.test(line)) {
    const end = line.search(/\s(?:add|set|remove|print|enable|disable)\b/);
    if (end < 0) return [{ text: line, cls: "c1" }];
    return [{ text: line.slice(0, end), cls: "c1" }, ...colour(line.slice(end), true)];
  }
  const out: Piece[] = [];
  const re = /([a-z][a-z0-9-]*)(=)("(?:[^"\\]|\\.)*"?)?|("(?:[^"\\]|\\.)*"?)/gi;
  let at = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m.index > at) out.push({ text: line.slice(at, m.index) });
    if (m[1]) {
      out.push({ text: m[1], cls: "c2" });
      out.push({ text: "=" });
      if (m[3]) out.push({ text: m[3], cls: "c3" });
    } else out.push({ text: m[0], cls: "c3" });
    at = m.index + m[0].length;
  }
  if (at < line.length) out.push({ text: line.slice(at) });
  return out;
}

/** The code surface: line numbers, coloured text, changed lines marked, and a textarea on top when editing. */
function CodeSurface({
  text,
  script,
  changed,
  onChange,
}: {
  text: string;
  script: boolean;
  changed?: ReadonlySet<number>;
  onChange?: (text: string) => void;
}): ReactNode {
  const lines = useMemo(() => text.split("\n"), [text]);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (onChange) area.current?.focus({ preventScroll: true });
  }, [onChange]);
  return (
    <div className="fl-ed" data-edit={onChange ? true : undefined}>
      <div className="ln" aria-hidden="true">
        {lines.map((_, i) => (
          // eslint-disable-next-line react/no-array-index-key -- line numbers
          <span key={i}>{i + 1}</span>
        ))}
      </div>
      <div className="code">
        <pre className="tx" aria-hidden={onChange ? true : undefined} tabIndex={onChange ? -1 : 0}>
          {lines.map((line, i) => (
            // eslint-disable-next-line react/no-array-index-key -- lines have no identity
            <span key={i} className={changed?.has(i + 1) ? "line hl" : "line"}>
              {colour(line, script).map((piece, j) =>
                piece.cls ? (
                  // eslint-disable-next-line react/no-array-index-key -- pieces have no identity
                  <span key={j} className={piece.cls}>
                    {piece.text}
                  </span>
                ) : (
                  piece.text
                ),
              )}
              {"\n"}
            </span>
          ))}
        </pre>
        {onChange && (
          // kit-exempt: the code editor surface; the kit TextArea has no line numbers or colours.
          <textarea
            ref={area}
            className="tx-in"
            value={text}
            spellCheck={false}
            wrap="off"
            aria-label="File contents"
            onChange={(event) => onChange(event.target.value)}
          />
        )}
      </div>
    </div>
  );
}

export function FileViewer({ readOnly }: { readOnly: boolean }): ReactNode {
  const file = useSyncExternalStore(viewerStore.subscribe, viewerStore.get);
  const siblings = useSyncExternalStore(viewerSiblings.subscribe, viewerSiblings.get);
  const askedTab = useSyncExternalStore(viewerTab.subscribe, viewerTab.get);
  const tail = useSyncExternalStore(tailStore.subscribe, tailStore.get);
  const [loaded, setLoaded] = useState<{ text: string; size: number; mtime: number } | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [leaving, setLeaving] = useState<null | (() => void)>(null);
  const [tab, setTab] = useState("view");
  const [sha, setSha] = useState("");
  const [live, setLive] = useState<"live" | "ended" | "error">("live");
  const dirty = draft !== null && draft !== loaded?.text;

  // "Follow (live tail)" from a row menu opens the drawer on its Follow tab.
  useEffect(() => {
    if (!tail) return;
    viewerTab.set("follow");
    viewerStore.set(tail);
    tailStore.set(null);
  }, [tail]);

  useEffect(() => {
    setTab(askedTab);
  }, [askedTab, file]);

  const fileName = file ? baseName(file.path) : "";
  const fileDir = file ? parentOf(file.path) : "";
  const meta =
    file && siblings && siblings.device === file.device && siblings.dir === fileDir
      ? siblings.meta[fileName]
      : undefined;
  const preview = meta ? meta.preview : true;

  useEffect(() => {
    setLoaded(null);
    setDraft(null);
    setError("");
    setLeaving(null);
    setSha("");
    if (!file || !preview) return;
    let current = true;
    filesApi
      .read(file)
      .then((answer) => current && setLoaded(answer))
      .catch((e: unknown) => current && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      current = false;
    };
  }, [file, preview]);

  const changed = useMemo(() => {
    if (draft === null || !loaded || !dirty) return { lines: new Set<number>(), count: 0 };
    const diff = diffLines(loaded.text, draft);
    const lines = new Set(diff.ops.filter((op) => op.type === "add").map((op) => op.bLine ?? 0));
    return { lines, count: Math.max(diff.summary.added, diff.summary.removed) };
  }, [draft, loaded, dirty]);

  /** Runs `go` now, or after the user agrees to drop unsaved changes. */
  const guard = useCallback(
    (go: () => void): void => {
      if (dirty) {
        setTab("edit");
        setLeaving(() => go);
      } else go();
    },
    [dirty],
  );
  const close = useCallback(() => guard(() => viewerStore.set(null)), [guard]);

  if (!file) return null;
  presetWidth(DRAWER_KEY);
  const name = fileName;
  const dir = fileDir;
  const kind = kindOf({ name, dir: false });
  const script = kind === "script";
  const previewable = preview;
  const info = loaded ?? meta;
  const index = meta && siblings ? siblings.names.indexOf(name) : -1;
  const go = (to: number): void => {
    const next = siblings?.names[to];
    if (!siblings || !next) return;
    guard(() => viewerStore.set({ device: file.device, path: joinPath(dir, next) }));
  };

  const save = (): void => {
    if (draft === null) return;
    setSaving(true);
    filesApi
      .write(file, draft)
      .then(() => {
        setLoaded({
          text: draft,
          size: new Blob([draft]).size,
          mtime: Math.floor(Date.now() / 1000),
        });
        setDraft(null);
        setError("");
        setTab("view");
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSaving(false));
  };
  const download = (): void => transferQueue.download(file.device, file.path, info?.size ?? 0);
  const ref: FileRef = file;

  const reading = !loaded && !error && <p className="fl-empty">Reading the file…</p>;
  const failed = error && (
    <Strip tone="danger" className="fl-ed-strip">
      {error}
    </Strip>
  );

  const tabs: DrawerTab[] = [];
  if (previewable) {
    tabs.push({
      id: "view",
      label: "View",
      content: (
        <div className="fl-dw-pane">
          {reading}
          {loaded && <CodeSurface text={loaded.text} script={script} />}
          {failed}
        </div>
      ),
    });
    if (!readOnly)
      tabs.push({
        id: "edit",
        label: "Edit",
        content: (
          <div className="fl-dw-pane">
            {reading}
            {loaded && (
              <CodeSurface
                text={draft ?? loaded.text}
                script={script}
                changed={changed.lines}
                onChange={setDraft}
              />
            )}
            {failed}
            {leaving ? (
              <Strip
                tone="danger"
                role="alertdialog"
                label="Unsaved changes"
                icon={<AlertTriangle size={15} />}
                className="fl-ed-strip"
                actions={
                  <>
                    <button type="button" className="fp-act" onClick={() => setLeaving(null)}>
                      Keep editing
                    </button>
                    <button
                      type="button"
                      className="fp-act"
                      data-tone="danger"
                      onClick={() => {
                        const then = leaving;
                        setLeaving(null);
                        setDraft(null);
                        then();
                      }}
                    >
                      Close without saving
                    </button>
                  </>
                }
              >
                The changes are not saved.
              </Strip>
            ) : (
              dirty && (
                <Strip
                  tone="warn"
                  icon={<AlertTriangle size={15} />}
                  className="fl-ed-strip"
                  actions={
                    <>
                      <button type="button" className="fp-act" onClick={() => setDraft(null)}>
                        Discard
                      </button>
                      <button
                        type="button"
                        className="fp-act"
                        data-tone="primary"
                        disabled={saving}
                        onClick={save}
                      >
                        <Upload size={13} />
                        {saving ? "Saving…" : "Save to router"}
                      </button>
                    </>
                  }
                >
                  The changes are not saved.
                </Strip>
              )
            )}
          </div>
        ),
      });
    tabs.push({
      id: "compare",
      label: "Compare",
      content: (
        <div className="fl-dw-list">
          <p className="fl-dw-note">
            Compare this file with another text file, on this router or on another one.
          </p>
          {(siblings?.names ?? [])
            .filter(
              (other) => other !== name && meta !== undefined && siblings?.meta[other]?.preview,
            )
            .map((other) => (
              <button
                key={other}
                type="button"
                className="fl-dw-row"
                onClick={() =>
                  compareStore.set([ref, { device: file.device, path: joinPath(dir, other) }])
                }
              >
                <GitCompareArrows size={14} />
                <span className="n">{other}</span>
                <span className="m">in {dir}</span>
              </button>
            ))}
          <div>
            <button
              type="button"
              className="fp-act"
              onClick={() => {
                pickForCompare(ref);
                viewerStore.set(null);
              }}
            >
              <GitCompareArrows size={13} />
              Pick a file in any pane…
            </button>
          </div>
        </div>
      ),
    });
    tabs.push({
      id: "follow",
      label: "Follow",
      content: tab === "follow" ? <TailView file={ref} onState={setLive} /> : null,
    });
  }
  tabs.push({
    id: "details",
    label: "Details",
    content: (
      <div className="fl-dw-list">
        <DetailList
          items={[
            { label: "Router", value: file.device },
            { label: "Folder", value: dir, mono: true },
            { label: "Name", value: name, mono: true },
            { label: "Kind", value: KIND_LABEL[kind] },
            { label: "Size", value: info ? size(info.size) : "—", mono: true },
            { label: "Modified", value: info ? stamp(info.mtime, ", ") : "—", mono: true },
            { label: "SHA-256", value: sha || "—", mono: true },
          ]}
        />
        <div className="fl-dw-acts">
          <button type="button" className="fp-act" onClick={download}>
            <ArrowDownToLine size={13} />
            Download
          </button>
          <button
            type="button"
            className="fp-act"
            onClick={() =>
              void navigator.clipboard?.writeText(`${file.device}:${file.path}`).catch(() => {})
            }
          >
            <Copy size={13} />
            Copy the path
          </button>
          <button
            type="button"
            className="fp-act"
            onClick={() =>
              filesApi
                .hash(ref)
                .then(setSha)
                .catch((e: unknown) => setSha(e instanceof Error ? e.message : String(e)))
            }
          >
            <Fingerprint size={13} />
            Checksum
          </button>
        </div>
      </div>
    ),
  });

  const current = tabs.some((t) => t.id === tab) ? tab : (tabs[0]?.id ?? "details");
  const status =
    current === "edit"
      ? {
          tone: "warn" as const,
          label: dirty
            ? `Editing · ${changed.count} ${changed.count === 1 ? "line" : "lines"} changed`
            : "Editing",
        }
      : current === "follow"
        ? {
            tone: live === "live" ? ("ok" as const) : ("off" as const),
            label: live === "live" ? "Following" : "Stopped",
          }
        : undefined;

  return (
    <>
      <button
        type="button"
        className="fl-scrim fl-scrim-dw"
        aria-label="Close the file"
        onClick={close}
      />
      <RowDrawer
        open
        onClose={close}
        label={`File ${file.device}:${file.path}`}
        storageKey={DRAWER_KEY}
        rowKey={file.path}
        status={status}
        title={name}
        meta={
          <>
            {file.device}:{dir}
            {info && ` · ${size(info.size)} · ${stamp(info.mtime, ", ")}`} · {KIND_LABEL[kind]}
          </>
        }
        nav={
          index >= 0 && siblings
            ? {
                index,
                total: siblings.names.length,
                onPrev: index > 0 ? () => go(index - 1) : undefined,
                onNext: index < siblings.names.length - 1 ? () => go(index + 1) : undefined,
              }
            : undefined
        }
        tabs={tabs}
        tab={current}
        onTab={(id) => {
          if (id === "edit" && draft === null && loaded) setDraft(loaded.text);
          setTab(id);
        }}
      />
    </>
  );
}
