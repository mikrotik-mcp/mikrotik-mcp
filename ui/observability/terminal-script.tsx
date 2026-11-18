/**
 * Script runner: several commands, one per line, run in order in one pane.
 * "Check" asks the router to validate each line without running anything.
 */
import { FileCode2, Play, ShieldCheck, TriangleAlert, X } from "lucide-react";
import type { ReactNode } from "react";
import { useRef, useState, useSyncExternalStore } from "react";
import { Checkbox } from "@/components/ui/checkbox";
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

export function ScriptDialog(): ReactNode {
  const paneId = useSyncExternalStore(scriptStore.subscribe, scriptStore.get);
  const [text, setText] = useState("");
  const [states, setStates] = useState<LineState[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [stopOnError, setStopOnError] = useState(true);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const cancelled = useRef(false);

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

  return (
    <div className="term-modal" role="dialog" aria-modal="true" aria-label="Run a script">
      <div className="term-modal-card term-script">
        <header>
          <strong>
            <FileCode2 size={15} /> Script for {pane?.device ?? "a closed pane"}
          </strong>
          <button
            type="button"
            aria-label="Close"
            onClick={() => {
              cancelled.current = true;
              scriptStore.close();
            }}
          >
            <X size={16} />
          </button>
        </header>
        <textarea
          value={text}
          spellCheck={false}
          placeholder={
            "# One command per line. Lines that start with # are skipped.\n/ip address print\n/interface print where running"
          }
          aria-label="Script"
          disabled={busy}
          onChange={(event) => {
            setText(event.target.value);
            setStates([]);
            setReviewed(false);
          }}
        />
        {lines.length > 0 && (
          <ol className="term-script-lines">
            {lines.map((line, index) => (
              // eslint-disable-next-line react/no-array-index-key -- the same command may appear twice
              <li key={index} data-state={states[index] ?? "idle"}>
                <code>{line}</code>
                <span>
                  {states[index] && states[index] !== "idle" ? states[index] : ""}
                  {notes[index] ? ` · ${notes[index]}` : ""}
                </span>
              </li>
            ))}
          </ol>
        )}
        {risky.length > 0 && (
          <label className="term-script-risk">
            <Checkbox
              aria-label="I reviewed the lines that change or remove configuration"
              checked={reviewed}
              onCheckedChange={(value) => setReviewed(value === true)}
            />
            <TriangleAlert size={14} />
            {risky.length} line{risky.length > 1 ? "s" : ""} change or remove configuration (
            {risky.map((line) => destructiveWord(line)).join(", ")}). I reviewed them.
          </label>
        )}
        <footer>
          <label>
            <Checkbox
              aria-label="Stop at the first error"
              checked={stopOnError}
              onCheckedChange={(value) => setStopOnError(value === true)}
            />
            Stop at the first error
          </label>
          <button
            type="button"
            disabled={busy || !lines.length || !pane}
            onClick={() => void check()}
          >
            <ShieldCheck size={14} /> Check syntax
          </button>
          {busy ? (
            <button
              type="button"
              onClick={() => {
                cancelled.current = true;
              }}
            >
              Stop after this line
            </button>
          ) : (
            <button
              type="button"
              className="term-go"
              disabled={!lines.length || !pane || (risky.length > 0 && !reviewed)}
              onClick={() => void run()}
            >
              <Play size={14} /> Run {lines.length} line{lines.length === 1 ? "" : "s"}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
