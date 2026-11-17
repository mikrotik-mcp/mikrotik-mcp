/**
 * Dashboard terminal — run RouterOS commands from the browser.
 *
 * Every command goes through `executeMikrotikCommand`, the same choke point the
 * tools use, so Safe Mode routing, the connection pool and device selection
 * behave as they do for a tool call. Each command is written to the audit feed
 * and to the terminal history.
 *
 * This is arbitrary command execution on a router. It is served only when the
 * dashboard has a token or listens on loopback (see {@link terminalAccess}).
 */
import { createContext } from "../core/context";
import { bypassesSafeMode, executeMikrotikCommand } from "../core/connector";
import { DeviceConnectionError } from "../core/device-connection-error";
import { looksLikeError, quoteValue } from "../core/routeros";
import { getConfig, resolveDeviceName } from "../core/runtime";
import { getSafeModeManager } from "../ssh/safe-mode";
import { logger } from "../logger";
import { DashboardInputError, readOperationBody } from "./bounded-request";
import type { Risk } from "./event";
import { recordToolCall } from "./recorder";
import {
  closeShell,
  deleteRecording,
  listRecordings,
  openShell,
  readRecording,
  shellInput,
  shellResize,
} from "./terminal-shell";
import type { TerminalStore } from "./terminal-store";
import { z } from "zod";
import { configSnapshotTools } from "../tools/config-snapshot";
import { toolGatewayTools } from "../tools/tool-gateway";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/** Why the terminal is unavailable, or `null` when it may be used. */
export function terminalAccess(cfg: {
  host: string;
  token?: string;
  terminal?: boolean;
}): string | null {
  if (cfg.terminal === false) return "The terminal is turned off (dashboard.terminal = false).";
  if (cfg.token || LOOPBACK.has(cfg.host)) return null;
  return (
    "The terminal runs any command on your routers, so it needs a protected dashboard. " +
    "Set a dashboard token (--dashboard-token) or bind the dashboard to 127.0.0.1 (--dashboard-host)."
  );
}

/** Commands are capped here unless the caller asks for longer (max 10 minutes). */
const DEFAULT_MAX_MS = 30_000;
const DESTRUCTIVE_RE =
  /(?:^|[\s/;[{])(?:remove|reset-configuration|reset|reboot|shutdown|format|format-drive|downgrade|uninstall|wipe)(?:$|[\s;\]}])/;
const DIAGNOSTIC_RE =
  /^\/?(?:ping|tool[\s/]+(?:ping|traceroute|trace)|console[\s/]+inspect)(?:\s|$)|^:put\s+[^[\]]*$/;

/** Risk of a raw command, from its text alone. Unknown commands are WRITE. */
export function classifyCommand(command: string): Risk {
  const text = command.trim();
  if (bypassesSafeMode(text.startsWith("/") ? text : `/${text}`, {}) || DIAGNOSTIC_RE.test(text))
    return "READ";
  return DESTRUCTIVE_RE.test(text) ? "DESTRUCTIVE" : "WRITE";
}

/**
 * Token classes from `:put [/console/inspect request=highlight … as-value]`,
 * which prints `highlight=dir;dir;none;…;type=highlight`: one class per input byte.
 */
export function parseHighlight(output: string): string[] {
  const found = output.match(/highlight=([a-z0-9;-]*?);type=/i);
  return found?.[1] ? found[1].split(";") : [];
}

export interface TerminalCompletion {
  completion: string;
  /** RouterOS token class of the word (dir, cmd, arg, …). */
  style: string;
  /** Index in the input where the completed word starts. */
  offset: number;
}

/** Words RouterOS offers for the input, best first, from a `request=completion` print. */
export function parseCompletions(output: string): TerminalCompletion[] {
  const rows: (TerminalCompletion & { preference: number })[] = [];
  for (const line of output.split(/\r?\n/)) {
    // TYPE COMPLETION STYLE OFFSET PREFERENCE SHOW — COMPLETION may be empty.
    const cells = line.match(/^\s*completion\s+(\S*)\s+([a-z-]+)\s+(\d+)\s+(-?\d+)\s+(yes|no)/);
    if (!cells || !cells[1] || cells[5] !== "yes") continue;
    rows.push({
      completion: cells[1],
      style: cells[2] ?? "none",
      offset: Number(cells[3]),
      preference: Number(cells[4]),
    });
  }
  return rows
    .sort((x, y) => y.preference - x.preference)
    .map(({ completion, style, offset }) => ({ completion, style, offset }));
}

export interface SyntaxHelp {
  /** The word: a menu, a command, an argument or a value. Empty for a note. */
  symbol: string;
  /** RouterOS's own short explanation; may be empty. */
  text: string;
  /** Depth in the reply: 1 is a direct choice, 2 a value of that choice. */
  nested: number;
}

/**
 * Explanations from `:put [/console/inspect request=syntax … as-value]`, which
 * prints records as `nested=1;nonorm=false;symbol=address;symbol-type=explanation;text=…;type=syntax`.
 */
export function parseSyntaxHelp(output: string): SyntaxHelp[] {
  const items: SyntaxHelp[] = [];
  for (const record of output.trim().split(/;type=syntax(?:;|\s*$)/)) {
    const cells = record.match(
      /nested=(\d+);nonorm=\w+;symbol=(.*?);symbol-type=([\w-]+);text=(.*)$/s,
    );
    if (!cells) continue;
    const symbol = cells[2] ?? "";
    const text = (cells[4] ?? "").trim();
    if (!symbol && !text) continue;
    items.push({ symbol, text, nested: Number(cells[1]) });
  }
  return items;
}

/** Commands that hold the most words of a question, best first. */
export function rankCommands(question: string, commands: string[], limit = 8): string[] {
  const words = question
    .toLowerCase()
    .split(/[^a-z0-9.-]+/)
    .filter((word) => word.length > 1);
  if (!words.length) return [];
  const seen = new Set<string>();
  return commands
    .filter((command) => !seen.has(command) && seen.add(command))
    .map((command) => {
      const text = command.toLowerCase();
      return { command, score: words.filter((word) => text.includes(word)).length };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.command);
}

/** The tools named in a `find_tools` answer: `1. name  [module]` then `title — …`. */
export function parseFoundTools(answer: string): { name: string; title: string }[] {
  return Array.from(answer.matchAll(/^\d+\. (\S+)\s+\[[^\]]*\]\n\s+(.+?) — /gm), (match) => ({
    name: match[1] ?? "",
    title: match[2] ?? "",
  }));
}

/** Shared views: a link that shows one router's terminal activity from a moment on. */
const shares = new Map<string, { device: string; since: number }>();
const SHARE_TTL_MS = 24 * 3_600_000;
const MAX_SHARES = 20;

/** Shortest repeat of a scheduled command. */
export const MIN_SCHEDULE_MS = 60_000;
export const MAX_SCHEDULES = 50;
let schedulerTimer: ReturnType<typeof setInterval> | undefined;

/** Stop the scheduled-command loop (dashboard shutdown, tests). */
export function stopTerminalScheduler(): void {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = undefined;
}

/**
 * Run every schedule that is due. Only reads are scheduled (the routes refuse
 * anything else), so nothing changes a router while nobody is watching.
 */
export async function runDueSchedules(store: TerminalStore, now = Date.now()): Promise<number> {
  let ran = 0;
  for (const item of store.listSchedules()) {
    if (item.nextRun === null || item.nextRun > now) continue;
    ran++;
    const ctx = createContext(undefined, item.device);
    let output = "";
    let error: string | undefined;
    try {
      // Checked again here: the stored row is not trusted to be a read.
      if (classifyCommand(item.command) !== "READ") throw new Error("Only reads may be scheduled.");
      output = await executeMikrotikCommand(item.command, ctx, { maxMs: DEFAULT_MAX_MS });
      if (looksLikeError(output)) error = "RouterOS rejected the command.";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const ms = Date.now() - now;
    store.addHistory({
      ts: now,
      device: item.device,
      command: item.command,
      output,
      ok: !error,
      ms,
      error,
    });
    recordToolCall({
      tool: "dashboard_terminal",
      title: "Dashboard Terminal",
      risk: "READ",
      device: item.device,
      deviceTransport: ctx.transport,
      ts: now,
      durationMs: ms,
      isError: Boolean(error),
      error,
      args: { command: item.command, scheduled: true },
      output,
      hasStructured: false,
    });
    store.markScheduleRun(item.id, {
      at: now,
      ok: !error,
      note: error ?? `${output.split(/\r?\n/).filter(Boolean).length} lines`,
      next: item.everyMs > 0 ? now + item.everyMs : null,
    });
  }
  return ran;
}

interface TerminalRouteOptions {
  /** Why the terminal is unavailable, or `null`. */
  denied: string | null;
  /** Opened on first use. */
  store: () => Promise<TerminalStore>;
}

const noStore = { "cache-control": "no-store" };
const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: noStore });

const MAX_MAX_MS = 600_000;

/** Run a config-snapshot tool as the tools do, and return its text. */
async function snapshotTool(
  name: string,
  device: string,
  input: Record<string, unknown>,
): Promise<string> {
  const tool = configSnapshotTools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Snapshot tool ${name} is not available.`);
  const result = await tool.handler(
    z.object(tool.inputSchema).parse(input),
    createContext(undefined, device),
  );
  return typeof result === "string" ? result : JSON.stringify(result);
}

export function createTerminalRoutes(options: TerminalRouteOptions) {
  if (options.denied === null && !schedulerTimer) {
    schedulerTimer = setInterval(() => {
      void options
        .store()
        .then((store) => runDueSchedules(store))
        .catch((e) =>
          logger.warn(`Terminal schedules did not run: ${e instanceof Error ? e.message : e}`),
        );
    }, 20_000);
    schedulerTimer.unref?.();
  }

  /** Run one command and stream it as NDJSON: start, out…, end. */
  function run(
    req: Request,
    device: string,
    command: string,
    maxMs: number,
    snapshot: boolean,
  ): Response {
    const risk = classifyCommand(command);
    const encoder = new TextEncoder();
    const started = Date.now();
    const abort = new AbortController();
    req.signal.addEventListener("abort", () => abort.abort(), { once: true });

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let open = true;
        const send = (message: unknown): void => {
          if (!open) return;
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(message)}\n`));
          } catch {
            open = false;
          }
        };
        const ctx = createContext(undefined, device);
        // A restore point before a change, when the pane asked for one.
        const guarded = snapshot && risk !== "READ";
        send({ t: "start", ts: started, device, risk, snapshot: guarded });
        let streamed = false;
        let output = "";
        let error: string | undefined;
        let dispatched = true;
        let transportFailed = false;
        let snapshotFailed = false;
        try {
          if (guarded) {
            try {
              await snapshotTool("capture_config_snapshot", device, {
                label: `terminal: ${command.slice(0, 80)}`,
              });
            } catch (e) {
              snapshotFailed = true;
              throw new Error(
                `The command was NOT run: the snapshot before it failed (${e instanceof Error ? e.message : String(e)}).`,
                { cause: e },
              );
            }
          }
          output = await executeMikrotikCommand(command, ctx, {
            maxMs,
            signal: abort.signal,
            onData: (text) => {
              streamed = true;
              send({ t: "out", d: text });
            },
          });
          // Safe Mode, REST and MAC-Telnet return the output in one piece.
          if (!streamed && output) send({ t: "out", d: output });
          // RouterOS reports a rejected command as ordinary output.
          if (!abort.signal.aborted && looksLikeError(output))
            error = "RouterOS rejected the command.";
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
          // A failed snapshot is not a lost connection: the pane must not retry it.
          transportFailed = !snapshotFailed;
          // A failed connect never sent the command, so a retry cannot repeat it.
          dispatched = !snapshotFailed && !(e instanceof DeviceConnectionError);
        }
        const ms = Date.now() - started;
        const stopped = abort.signal.aborted;
        let historyId: number | undefined;
        try {
          historyId = (await options.store()).addHistory({
            ts: started,
            device,
            command,
            output,
            ok: !error,
            ms,
            error,
          });
        } catch (e) {
          logger.warn(`Terminal history was not saved: ${e instanceof Error ? e.message : e}`);
        }
        recordToolCall({
          tool: "dashboard_terminal",
          title: "Dashboard Terminal",
          risk,
          device,
          deviceTransport: ctx.transport,
          restFallback: ctx.restFallback,
          ts: started,
          durationMs: ms,
          isError: Boolean(error),
          error,
          args: { command },
          output,
          hasStructured: false,
        });
        send({
          t: "end",
          ok: !error,
          ms,
          error,
          stopped,
          historyId,
          snapshot: guarded && dispatched,
          transport: ctx.transport,
          // Safe to send again without repeating a change on the router.
          retryable: transportFailed && (!dispatched || risk === "READ"),
        });
        open = false;
        try {
          controller.close();
        } catch {
          /* the viewer already left */
        }
      },
      cancel() {
        abort.abort();
      },
    });
    return new Response(stream, {
      headers: { "content-type": "application/x-ndjson; charset=utf-8", ...noStore },
    });
  }

  return async function terminalRoutes(req: Request, url: URL): Promise<Response | null> {
    const path = url.pathname;
    if (!path.startsWith("/api/terminal")) return null;
    const key = `${req.method} ${path}`;

    if (key === "GET /api/terminal/state")
      return json({
        enabled: options.denied === null,
        reason: options.denied,
        readOnly: getConfig().readOnly,
      });
    if (options.denied !== null) return json({ error: options.denied }, 403);

    try {
      if (key === "GET /api/terminal/history") {
        const store = await options.store();
        return json({
          entries: store.listHistory({
            device: url.searchParams.get("device") || undefined,
            q: url.searchParams.get("q") || undefined,
            limit: Number(url.searchParams.get("limit")) || undefined,
          }),
        });
      }
      if (key === "GET /api/terminal/recordings") return json({ recordings: listRecordings() });
      if (key === "GET /api/terminal/recording") {
        const cast = readRecording(url.searchParams.get("id") ?? "");
        if (cast === undefined) return json({ error: "No such recording." }, 404);
        return new Response(cast, {
          headers: { "content-type": "text/plain; charset=utf-8", ...noStore },
        });
      }
      if (key === "GET /api/terminal/shared") {
        const share = shares.get(url.searchParams.get("id") ?? "");
        if (!share || Date.now() - share.since > SHARE_TTL_MS)
          return json({ error: "This shared view does not exist or has ended." }, 404);
        const entries = (await options.store())
          .listHistory({ device: share.device, limit: 300 })
          .filter((entry) => entry.ts >= share.since)
          .reverse();
        return json({ device: share.device, since: share.since, entries });
      }
      if (key === "GET /api/terminal/schedules")
        return json({ schedules: (await options.store()).listSchedules() });
      if (key === "GET /api/terminal/suggest") {
        // Word matching only: no language model is involved.
        const question = url.searchParams.get("q") ?? "";
        const store = await options.store();
        const known = [
          ...store.listFavorites().map((favorite) => favorite.command),
          ...store.listHistory({ limit: 1000 }).map((entry) => entry.command),
        ];
        let tools: { name: string; title: string }[] = [];
        const finder = toolGatewayTools.find((tool) => tool.name === "find_tools");
        if (finder && question.trim()) {
          try {
            const answer = await finder.handler({ query: question, limit: 6 }, createContext());
            tools = parseFoundTools(typeof answer === "string" ? answer : "");
          } catch {
            /* the catalog search is optional */
          }
        }
        return json({ commands: rankCommands(question, known), tools });
      }
      if (key === "GET /api/terminal/favorites")
        return json({ favorites: (await options.store()).listFavorites() });

      if (req.method !== "POST" && req.method !== "DELETE")
        return json({ error: "Unsupported terminal route" }, 405);
      // Also rejects a cross-origin browser request.
      const body = JSON.parse((await readOperationBody(req, 65_536)) || "{}") as Record<
        string,
        unknown
      >;
      const text = (name: string): string =>
        typeof body[name] === "string" ? (body[name] as string) : "";

      if (key === "DELETE /api/terminal/history") {
        const id = typeof body.id === "number" ? body.id : undefined;
        const store = await options.store();
        return json({ removed: store.deleteHistory({ id, device: text("device") || undefined }) });
      }
      if (key === "POST /api/terminal/favorites") {
        const command = text("command").trim();
        if (!command) return json({ error: "A command is required." }, 400);
        const label = (text("label").trim() || command).slice(0, 120);
        return json({ favorite: (await options.store()).saveFavorite(command, label) });
      }
      if (key === "DELETE /api/terminal/schedules") {
        if (typeof body.id !== "number") return json({ error: "A schedule id is required." }, 400);
        return json({ removed: (await options.store()).deleteSchedule(body.id) });
      }
      if (key === "POST /api/terminal/schedules") {
        const command = text("command").trim();
        if (!command) return json({ error: "A command is required." }, 400);
        if (classifyCommand(command) !== "READ")
          return json(
            {
              error:
                "Only commands that read (print, export, ping, traceroute) can be scheduled. A change must be run by a person.",
            },
            400,
          );
        const store = await options.store();
        if (store.listSchedules().length >= MAX_SCHEDULES)
          return json({ error: `At most ${MAX_SCHEDULES} schedules are kept.` }, 400);
        const everyMs = Math.max(0, Math.floor(Number(body.everyMs) || 0));
        if (everyMs > 0 && everyMs < MIN_SCHEDULE_MS)
          return json({ error: "The shortest repeat is one minute." }, 400);
        const at = Number(body.at);
        const nextRun = Number.isFinite(at) && at > Date.now() ? at : Date.now() + (everyMs || 0);
        const id = store.addSchedule({
          device: resolveDeviceName(text("device") || undefined),
          command,
          everyMs,
          nextRun,
        });
        return json({ id, schedules: store.listSchedules() });
      }
      if (key === "DELETE /api/terminal/favorites") {
        if (typeof body.id !== "number") return json({ error: "A favourite id is required." }, 400);
        return json({ removed: (await options.store()).deleteFavorite(body.id) });
      }

      // Interactive shell: keys and size go to an open session by its id.
      if (key === "POST /api/terminal/shell/input")
        return json({ ok: shellInput(text("id"), text("data")) });
      if (key === "POST /api/terminal/shell/resize")
        return json({ ok: shellResize(text("id"), body.cols, body.rows) });
      if (key === "POST /api/terminal/shell/close") return json({ ok: closeShell(text("id")) });

      // The remaining routes talk to a router.
      const device = resolveDeviceName(text("device") || undefined);

      if (key === "POST /api/terminal/share") {
        for (const [id, share] of shares)
          if (Date.now() - share.since > SHARE_TTL_MS) shares.delete(id);
        if (shares.size >= MAX_SHARES)
          return json({ error: `At most ${MAX_SHARES} shared views are open.` }, 400);
        const id = crypto.randomUUID();
        shares.set(id, { device, since: Date.now() });
        return json({ id, device });
      }
      if (key === "DELETE /api/terminal/recordings")
        return json({ ok: deleteRecording(text("id")) });
      if (key === "POST /api/terminal/unshare") return json({ ok: shares.delete(text("id")) });

      if (key === "POST /api/terminal/shell/open") {
        // Keys cannot be classified as reads, so a read-only server has no shell.
        if (getConfig().readOnly)
          return json(
            { error: "This server is in read-only mode: the interactive shell is not available." },
            403,
          );
        return await openShell(device, { cols: body.cols, rows: body.rows }, req.signal);
      }
      const quick = (command: string) => {
        const ctx = createContext(undefined, device);
        return { ctx, result: executeMikrotikCommand(command, ctx, { maxMs: 8000 }) };
      };

      if (key === "POST /api/terminal/probe") {
        const started = performance.now();
        const { ctx, result } = quick(":put [/system identity get name]");
        try {
          const out = await result;
          return json({
            ok: true,
            ms: Math.round(performance.now() - started),
            identity: out.trim().split(/\r?\n/)[0] ?? "",
            safeMode: getSafeModeManager(device).isActive,
            transport: ctx.transport,
          });
        } catch (e) {
          return json({
            ok: false,
            ms: Math.round(performance.now() - started),
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      if (key === "POST /api/terminal/safe-mode") {
        // Safe Mode: RouterOS undoes uncommitted changes if this session is lost.
        if (getConfig().readOnly)
          return json({ error: "This server is in read-only mode: Safe Mode is not needed." }, 403);
        const manager = getSafeModeManager(device);
        const action = text("action");
        const started = Date.now();
        let message: string;
        let ok = true;
        if (action === "enable") {
          message = await manager.enable();
          ok = !message.startsWith("Error");
        } else if (action === "commit") {
          const result = await manager.commit();
          message = result.message;
          ok = result.ok;
        } else if (action === "rollback") message = await manager.rollback();
        else return json({ error: "action must be enable, commit or rollback." }, 400);
        recordToolCall({
          tool: "dashboard_terminal",
          title: "Dashboard Terminal",
          risk: "WRITE",
          device,
          deviceTransport: "ssh",
          ts: started,
          durationMs: Date.now() - started,
          isError: !ok,
          error: ok ? undefined : message,
          args: { safeMode: action },
          output: message,
          hasStructured: false,
        });
        return json({ ok, message, active: manager.isActive });
      }

      if (key === "POST /api/terminal/highlight") {
        const input = text("input");
        if (!input.trim()) return json({ tokens: [] });
        const command = `:put [/console/inspect request=highlight input=${quoteValue(input)} as-value]`;
        return json({ tokens: parseHighlight(await quick(command).result) });
      }
      if (key === "POST /api/terminal/syntax") {
        const command = `:put [/console/inspect request=syntax input=${quoteValue(text("input"))} as-value]`;
        return json({ items: parseSyntaxHelp(await quick(command).result).slice(0, 200) });
      }
      if (key === "POST /api/terminal/complete") {
        const command = `/console/inspect request=completion input=${quoteValue(text("input"))}`;
        return json({ completions: parseCompletions(await quick(command).result) });
      }

      if (key === "POST /api/terminal/run") {
        const command = text("command").trim();
        if (!command) return json({ error: "Type a command first." }, 400);
        if (getConfig().readOnly && classifyCommand(command) !== "READ")
          return json(
            {
              error:
                "This server is in read-only mode: only print, export and diagnostic commands run here.",
            },
            403,
          );
        const asked = Number(body.maxMs);
        const maxMs =
          Number.isFinite(asked) && asked > 0 ? Math.min(asked, MAX_MAX_MS) : DEFAULT_MAX_MS;
        return run(req, device, command, maxMs, body.snapshot === true);
      }
      if (key === "POST /api/terminal/changes") {
        // What differs between the newest stored snapshot and the router now.
        return json({
          text: await snapshotTool("diff_config_snapshots", device, { from: "latest", to: "live" }),
        });
      }
      return json({ error: "Unsupported terminal route" }, 405);
    } catch (e) {
      if (e instanceof DashboardInputError) return json({ error: e.message }, e.status);
      if (e instanceof SyntaxError) return json({ error: "Invalid JSON body." }, 400);
      return json({ error: e instanceof Error ? e.message : "Terminal request failed." }, 400);
    }
  };
}
