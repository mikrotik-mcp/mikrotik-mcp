/**
 * View a text file of a router, and edit it in place. A `.rsc` file is coloured
 * with the RouterOS grammar of the Terminal page.
 */
import { ArrowDownToLine, FileText, Pencil, Save, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { bytes } from "./format";
import { baseName, filesApi, transferQueue, viewerStore, when } from "./files-lib";
import { loadHighlighter, staticSpans } from "./terminal-highlight";

export function FileViewer({ readOnly }: { readOnly: boolean }): ReactNode {
  const file = useSyncExternalStore(viewerStore.subscribe, viewerStore.get);
  const [loaded, setLoaded] = useState<{ text: string; size: number; mtime: number } | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [grammar, setGrammar] = useState(false);
  const dirty = draft !== null && draft !== loaded?.text;

  useEffect(() => {
    setLoaded(null);
    setDraft(null);
    setError("");
    setLeaving(false);
    if (!file) return;
    let current = true;
    filesApi
      .read(file)
      .then((answer) => current && setLoaded(answer))
      .catch((e: unknown) => current && setError(e instanceof Error ? e.message : String(e)));
    void loadHighlighter().then(() => current && setGrammar(true));
    return () => {
      current = false;
    };
  }, [file]);

  const close = (): void => (dirty && !leaving ? setLeaving(true) : viewerStore.set(null));
  useEffect(() => {
    if (!file) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const script = file ? /\.rsc$/i.test(file.path) : false;
  const lines = useMemo(() => {
    if (!loaded) return [];
    // `grammar` is read so the colours appear when the grammar has loaded.
    return script && grammar
      ? staticSpans(loaded.text)
      : loaded.text.split("\n").map((text) => [{ text, color: undefined }]);
  }, [loaded, script, grammar]);

  if (!file) return null;
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
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSaving(false));
  };

  return (
    <div className="term-modal" role="dialog" aria-modal="true" aria-label={`File ${file.path}`}>
      <div className="term-modal-card files-viewer">
        <header>
          <strong>
            <FileText size={15} /> {baseName(file.path)}
          </strong>
          <span className="files-viewer-meta">
            {file.device}:{file.path}
            {loaded && ` · ${bytes(loaded.size)} · ${when(loaded.mtime)}`}
            {dirty && " · changed"}
          </span>
          <span className="files-viewer-actions">
            {loaded && draft === null && !readOnly && (
              <button type="button" onClick={() => setDraft(loaded.text)}>
                <Pencil size={13} /> Edit
              </button>
            )}
            {draft !== null && (
              <>
                <button
                  type="button"
                  data-primary="true"
                  disabled={!dirty || saving}
                  onClick={save}
                >
                  <Save size={13} /> {saving ? "Saving…" : "Save to router"}
                </button>
                <button type="button" onClick={() => setDraft(null)}>
                  Discard
                </button>
              </>
            )}
            {loaded && (
              <button
                type="button"
                title="Download"
                onClick={() => transferQueue.download(file.device, file.path, loaded.size)}
              >
                <ArrowDownToLine size={14} />
              </button>
            )}
            <button type="button" onClick={close} aria-label="Close">
              <X size={16} />
            </button>
          </span>
        </header>
        {leaving && (
          <div
            className="files-strip"
            data-tone="warn"
            role="alertdialog"
            aria-label="Unsaved changes"
          >
            <span>The changes are not saved.</span>
            <button type="button" onClick={() => viewerStore.set(null)}>
              Close without saving
            </button>
            <button type="button" onClick={() => setLeaving(false)}>
              Keep editing
            </button>
          </div>
        )}
        {error && (
          <p className="files-empty" data-tone="danger">
            {error}
          </p>
        )}
        {!loaded && !error && <p className="files-empty">Reading the file…</p>}
        {loaded && draft === null && (
          <pre className="files-code" tabIndex={0}>
            {lines.map((line, row) => (
              // eslint-disable-next-line react/no-array-index-key -- lines have no identity
              <span key={row} className="files-code-line">
                {line.map((span, index) => (
                  // eslint-disable-next-line react/no-array-index-key -- spans have no identity
                  <span key={index} style={span.color ? { color: span.color } : undefined}>
                    {span.text}
                  </span>
                ))}
                {"\n"}
              </span>
            ))}
          </pre>
        )}
        {draft !== null && (
          <textarea
            className="files-editor"
            value={draft}
            spellCheck={false}
            aria-label="File contents"
            onChange={(event) => setDraft(event.target.value)}
          />
        )}
      </div>
    </div>
  );
}
