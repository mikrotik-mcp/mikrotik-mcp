/**
 * Script runner: several commands, one per line, run in order in one pane.
 * "Check syntax" asks the router to validate each line without running anything.
 */
import { Pencil, Play, Square, Table2, TriangleAlert, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Checkbox, Switch, TextArea } from "./kit";
import { popIn } from "./kit/motion";
import { hasSyntaxError } from "./terminal-highlight";
import {
  destructiveWord,
  paneRegistry,
  scriptLines,
  scriptStore,
  terminalApi,
} from "./terminal-lib";

type LineState =
  | "idle"
  | "checking"
  | "valid"
  | "invalid"
  | "running"
  | "ok"
  | "failed"
  | "skipped";

/** The mark in the circle before a line. */
const MARK: Record<LineState, { tone: string; mark: string }> = {
  idle: { tone: "wait", mark: "" },
  checking: { tone: "run", mark: "•" },
  valid: { tone: "ok", mark: "✓" },
  invalid: { tone: "bad", mark: "!" },
  running: { tone: "run", mark: "•" },
  ok: { tone: "ok", mark: "✓" },
  failed: { tone: "bad", mark: "!" },
  skipped: { tone: "wait", mark: "" },
};
/** The word at the end of a line. */
const WORD: Record<LineState, string> = {
  idle: "waiting",
  checking: "checking",
  valid: "syntax ok",
  invalid: "syntax error",
  running: "running",
  ok: "",
  failed: "failed",
  skipped: "skipped",
};

export function ScriptDialog(): ReactNode {
  const paneId = useSyncExternalStore(scriptStore.subscribe, scriptStore.get);
  const [text, setText] = useState("");
  const [states, setStates] = useState<LineState[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [stopOnError, setStopOnError] = useState(true);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Show the lines and their states instead of the editor. */
  const [showLines, setShowLines] = useState(false);
  const cancelled = useRef(false);
  const card = useRef<HTMLDivElement>(null);
  const open = Boolean(paneId);
  useEffect(() => {
    if (open && card.current) return popIn(card.current);
  }, [open]);

  if (!paneId) return null;
  const pane = paneRegistry.get(paneId);
  const lines = scriptLines(text);
  const risky = lines.filter((line) => destructiveWord(line));
  const mark = (index: number, state: LineState, note = ""): void => {
    setStates((list) => list.with(index, state));
    setNotes((list) => list.with(index, note));
  };
  const reset = (state: LineState): void => {
    setStates(lines.map(() => state));
    setNotes(lines.map(() => ""));
    setShowLines(true);
  };

  const check = async (): Promise<void> => {
    if (!pane) return;
    setBusy(true);
    reset("checking");
    for (const [index, line] of lines.entries()) {
      try {
        const tokens = await terminalApi.highlight(pane.device, line);
        mark(index, hasSyntaxError(tokens) ? "invalid" : "valid");
      } catch (e) {
        mark(index, "invalid", e instanceof Error ? e.message : String(e));
      }
    }
    setBusy(false);
  };

  const run = async (): Promise<void> => {
    if (!pane) return;
    setBusy(true);
    cancelled.current = false;
    reset("idle");
    let failed = false;
    for (const [index, line] of lines.entries()) {
      if (cancelled.current || (failed && stopOnError)) {
        mark(index, "skipped");
        continue;
      }
      mark(index, "running");
      // The dialog asked about destructive lines already, so the pane does not ask again.
      const result = await pane.run(line, { fromBroadcast: true });
      if (result?.ok) mark(index, "ok", `${result.ms} ms`);
      else {
        failed = true;
        mark(index, "failed", result?.error ?? "This line needs values ({{…}}): fill them first.");
      }
    }
    setBusy(false);
  };
  const close = (): void => {
    cancelled.current = true;
    scriptStore.close();
  };

  return (
    <div
      className="term-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Run a script"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) close();
      }}
    >
      <div className="term-mod term-script" ref={card}>
        <header className="term-mod-hd">
          <Table2 size={16} />
          <h2>Run a script on {pane?.device ?? "a closed pane"}</h2>
          <span className="m">
            {lines.length} line{lines.length === 1 ? "" : "s"}
            {risky.length > 0 &&
              ` · ${risky.length} change${risky.length === 1 ? "s" : ""} configuration`}
          </span>
          <span className="sp" />
          <button type="button" className="term-ib" aria-label="Close" onClick={close}>
            <X size={15} />
          </button>
        </header>
        {showLines && lines.length > 0 ? (
          <ol className="term-scr">
            {lines.map((line, index) => {
              const state = states[index] ?? "idle";
              return (
                // eslint-disable-next-line react/no-array-index-key -- the same command may appear twice
                <li key={index} className="term-scr-l" data-cur={state === "running" || undefined}>
                  <span className="s" data-tone={MARK[state].tone}>
                    {MARK[state].mark}
                  </span>
                  <code>{line}</code>
                  <span
                    className="t"
                    data-bad={state === "failed" || state === "invalid" || undefined}
                  >
                    {notes[index] || WORD[state]}
                  </span>
                </li>
              );
            })}
          </ol>
        ) : (
          <div className="term-script-edit">
            <TextArea
              mono
              rows={7}
              value={text}
              spellCheck={false}
              placeholder={
                "# One command per line. Lines that start with # are skipped.\n/ip address print\n/interface print where running"
              }
              aria-label="Script"
              disabled={busy}
              onChange={(value) => {
                setText(value);
                setStates([]);
                setReviewed(false);
              }}
            />
          </div>
        )}
        <div className="term-strip" data-tone={risky.length > 0 ? "warn" : undefined}>
          {risky.length > 0 && (
            <>
              <span className="i">
                <TriangleAlert size={15} />
              </span>
              <Checkbox
                tone="warn"
                checked={reviewed}
                onCheckedChange={setReviewed}
                label={
                  risky.length === 1
                    ? "I reviewed the line that changes configuration"
                    : `I reviewed the ${risky.length} lines that change configuration`
                }
              />
            </>
          )}
          <span className="sp" />
          <Switch
            checked={stopOnError}
            onCheckedChange={setStopOnError}
            label="Stop at the first error"
          />
          {showLines && !busy && (
            <button type="button" className="term-act" onClick={() => setShowLines(false)}>
              <Pencil size={12} /> Edit
            </button>
          )}
          <button
            type="button"
            className="term-act"
            disabled={busy || !lines.length || !pane}
            onClick={() => void check()}
          >
            Check syntax
          </button>
          {busy ? (
            <button
              type="button"
              className="term-act"
              data-tone="go"
              onClick={() => {
                cancelled.current = true;
              }}
            >
              <Square size={11} /> Stop after this line
            </button>
          ) : (
            <button
              type="button"
              className="term-act"
              data-tone="go"
              disabled={!lines.length || !pane || (risky.length > 0 && !reviewed)}
              onClick={() => void run()}
            >
              <Play size={12} /> Run {lines.length} line{lines.length === 1 ? "" : "s"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
