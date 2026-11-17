/**
 * Interactive shell pane: a real RouterOS console (xterm.js over one SSH PTY),
 * for what the block terminal cannot do — entering a menu, y/n prompts, live
 * monitors, the built-in editor.
 */
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { IDockviewPanelProps } from "dockview-react";
import { Plug, RotateCw, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { withToken } from "./api";

type Link = "connecting" | "online" | "closed";
const TOKEN = new URLSearchParams(location.search).get("token") ?? "";
const post = (path: string, body: unknown, signal?: AbortSignal): Promise<Response> =>
  fetch(withToken(path), {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: JSON.stringify(body),
  });

/** A CSS variable of the terminal page, read once for the xterm theme. */
const ink = (element: Element, name: string): string =>
  getComputedStyle(element).getPropertyValue(name).trim();

export function ShellPane(
  props: IDockviewPanelProps<{ device: string; color?: string }>,
): ReactNode {
  const device = props.params.device;
  const host = useRef<HTMLDivElement>(null);
  const [link, setLink] = useState<Link>("connecting");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [size, setSize] = useState("");

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    setLink("connecting");
    setError("");
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: ink(element, "--term-mono") || "monospace",
      fontSize: 13,
      scrollback: 5000,
      theme: {
        background: ink(element, "--term-bg"),
        foreground: ink(element, "--term-ink"),
        cursor: ink(element, "--term-accent"),
        selectionBackground: ink(element, "--term-line"),
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    fit.fit();
    const abort = new AbortController();
    let id = "";
    // Keys are sent one request after another, so they arrive in order.
    let queue: Promise<unknown> = Promise.resolve();
    const send = (path: string, body: Record<string, unknown>): void => {
      queue = queue.then(() => (id ? post(path, { id, ...body }).catch(() => {}) : undefined));
    };
    const typing = term.onData((data) => send("/api/terminal/shell/input", { data }));
    const resizing = term.onResize(({ cols, rows }) => {
      setSize(`${cols}×${rows}`);
      send("/api/terminal/shell/resize", { cols, rows });
    });
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* the pane is hidden: fit again when it is shown */
      }
    });
    observer.observe(element);

    void (async () => {
      try {
        const res = await post(
          "/api/terminal/shell/open",
          { device, cols: term.cols, rows: term.rows },
          abort.signal,
        );
        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        id = res.headers.get("x-shell-id") ?? "";
        setLink("online");
        setSize(`${term.cols}×${term.rows}`);
        term.focus();
        const reader = res.body.getReader();
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          term.write(chunk.value);
        }
        setLink("closed");
      } catch (e) {
        if (abort.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
        setLink("closed");
      }
    })();

    return () => {
      // Aborting the stream closes the session on the server.
      abort.abort();
      observer.disconnect();
      typing.dispose();
      resizing.dispose();
      term.dispose();
    };
  }, [device, attempt]);

  return (
    <section
      className="term-pane term-shell"
      data-link={link}
      data-pane-color={props.params.color || undefined}
    >
      <header className="term-status">
        <span className="term-link" data-link={link === "closed" ? "reconnecting" : link}>
          <span className="term-dot" />
          {link === "online" && "interactive shell"}
          {link === "connecting" && "opening shell…"}
          {link === "closed" && "session closed"}
        </span>
        <span className="term-stat term-identity">{device}</span>
        {size && <span className="term-stat">{size}</span>}
        <span
          className="term-stat"
          title="What the router prints is recorded (toolbar: Recordings). Typed keys are not."
        >
          <Plug size={11} /> output recorded
        </span>
        <span className="term-status-actions">
          <button
            type="button"
            onClick={() => setAttempt((n) => n + 1)}
            title="Close this session and open a new one"
          >
            <RotateCw size={12} /> {link === "closed" ? "reconnect" : "restart"}
          </button>
        </span>
      </header>
      {error && (
        <div className="term-banner">
          <TriangleAlert size={13} /> {error}
        </div>
      )}
      <div className="term-shell-host" ref={host} />
    </section>
  );
}
