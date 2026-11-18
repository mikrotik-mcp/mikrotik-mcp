import { LoadingState } from "./loading-state";
import { Fragment, useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  Check,
  ChevronRight,
  Copy,
  Eye,
  RefreshCw,
  Server,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { composePrompt, missingPromptArguments, promptCategory } from "../../src/prompts/compose";
import type { PromptTemplate } from "../../src/prompts/compose";
import { api } from "./api";
import {
  Metric,
  MetricStrip,
  MonitorButton,
  MonitorEmpty,
  MonitorNote,
  MonitorPanel,
  MonitorSearch,
  PageIntro,
  StatusBadge,
} from "./monitoring-ui";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import "./monitoring.css";
import "./prompts.css";

const ALL = "All workflows";
/** Cards the library shows before the list scrolls. */
const VISIBLE_CARDS = 5;

export function PromptsView() {
  const [prompts, setPrompts] = useState<PromptTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState(ALL);
  useEffect(() => {
    const controller = new AbortController();
    api<{ prompts: PromptTemplate[] }>("/api/catalog", controller.signal)
      .then((data) => {
        setPrompts(data.prompts);
        setSelected((value) =>
          data.prompts.some((p) => p.name === value) ? value : (data.prompts[0]?.name ?? ""),
        );
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reload]);
  const counts = new Map<string, number>();
  for (const p of prompts) counts.set(promptCategory(p), (counts.get(promptCategory(p)) ?? 0) + 1);
  const categories = [...counts.keys()].sort();
  const matches = prompts.filter(
    (p) =>
      (category === ALL || promptCategory(p) === category) &&
      query
        .toLowerCase()
        .split(/\s+/)
        .every((word) => `${p.name} ${p.title} ${p.description}`.toLowerCase().includes(word)),
  );
  const current = prompts.find((p) => p.name === selected);
  const required = current?.arguments.length ?? 0;
  const more = matches.length - VISIBLE_CARDS;
  return (
    <div className="flex min-w-0 flex-col gap-[18px]">
      <PageIntro
        eyebrow="Workflow library"
        heading="Start with a better brief."
        lead="Choose a router workflow, add your context, and take a complete request to your AI assistant. Nothing here touches a router."
        actions={
          <MonitorButton
            variant="ghost"
            onClick={() => {
              setLoading(true);
              setError("");
              setReload((n) => n + 1);
            }}
            disabled={loading}
            icon={<RefreshCw aria-hidden="true" />}
          >
            Refresh library
          </MonitorButton>
        }
      />
      {error && (
        <MonitorNote tone="bad" role="alert">
          Could not load prompts: {error}. Check the dashboard connection and retry.
        </MonitorNote>
      )}
      {loading && !prompts.length ? (
        <LoadingState label="Loading workflows" layout="cards" />
      ) : (
        <>
          <MetricStrip label="Workflow library" minCell={200}>
            <Metric
              label="Workflows"
              value={prompts.length}
              hint="Loaded from the prompts directory"
            />
            <Metric label="Categories" value={categories.length} hint={categories.join(", ")} />
            <Metric
              label="Inputs for this one"
              tone={current ? "good" : "default"}
              value={
                <>
                  {current ? required : 0}
                  <small>/{required}</small>
                </>
              }
              hint={
                current?.arguments.length
                  ? current.arguments.map((a) => a.name.replaceAll("_", " ")).join(" and ")
                  : "This workflow takes no inputs"
              }
            />
            <Metric label="Tools run" value="0" hint="Preparing a request is offline" />
          </MetricStrip>
          <div className="grid min-w-0 items-start gap-3.5 lg:grid-cols-[340px_minmax(0,1fr)]">
            <MonitorPanel
              title="Workflows"
              description="Pick one to start."
              flush
              aria-label="Workflow library"
            >
              <div className="flex flex-col gap-2.5 px-3.5 pb-3.5">
                <MonitorSearch
                  label="Search workflows"
                  placeholder="Search a task, tool or outcome…"
                  value={query}
                  onChange={setQuery}
                />
                <div role="radiogroup" aria-label="Workflow category" className="flex flex-col">
                  {[ALL, ...categories].map((c) => {
                    const n = c === ALL ? prompts.length : (counts.get(c) ?? 0);
                    return (
                      <button
                        key={c}
                        type="button"
                        role="radio"
                        aria-checked={c === category}
                        className="prompts-cat"
                        onClick={() => setCategory(c)}
                      >
                        <span className="min-w-0 flex-1 truncate">{c}</span>
                        <span className="text-xs text-muted-foreground tabular-nums">{n}</span>
                        <span className="monitor-bar w-12 flex-none" aria-hidden="true">
                          <span
                            data-tone="good"
                            style={{ width: `${prompts.length ? (n / prompts.length) * 100 : 0}%` }}
                          />
                        </span>
                      </button>
                    );
                  })}
                </div>
                <span className="monitor-hint px-0.5 pt-1" role="status">
                  {matches.length} of {prompts.length} workflows
                </span>
              </div>
              <div className="prompts-cards">
                {matches.map((p) => (
                  <WorkflowCard
                    key={p.name}
                    prompt={p}
                    selected={p.name === selected}
                    onSelect={() => setSelected(p.name)}
                  />
                ))}
                {!matches.length && (
                  <MonitorEmpty compact title="No matching workflows">
                    Try another search or category.
                  </MonitorEmpty>
                )}
              </div>
              <div className="monitor-foot">
                {more > 0 ? `Scroll for ${more} more` : `${matches.length} shown`}
                <span className="flex-1" />
                <span className="font-mono">{prompts.length} total</span>
              </div>
            </MonitorPanel>
            {current ? (
              <PromptComposer key={current.name} prompt={current} />
            ) : (
              <MonitorPanel title="No prompts available">
                <MonitorEmpty title="No prompts available">
                  Check that the server includes its prompts directory.
                </MonitorEmpty>
              </MonitorPanel>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function WorkflowCard({
  prompt,
  selected,
  onSelect,
}: {
  prompt: PromptTemplate;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button type="button" aria-pressed={selected} onClick={onSelect} className="prompts-card">
      <span className="flex items-center gap-2">
        <span className="prompts-card-cat">{promptCategory(prompt)}</span>
        <span className="flex-1" />
        {selected && <ChevronRight aria-hidden="true" className="size-3.5 text-success" />}
      </span>
      <b className="text-[13px] font-semibold text-foreground">{prompt.title}</b>
      <span className="monitor-hint line-clamp-2">{prompt.description}</span>
      <span className="font-mono text-[11px] text-faint">
        {prompt.arguments.filter((a) => a.required).length} required · {prompt.arguments.length}{" "}
        inputs
      </span>
    </button>
  );
}

/** The four steps from picking a workflow to running it, with `active` the current one. */
function Steps({ items, active }: { items: [string, string][]; active: number }) {
  return (
    <ol className="prompts-steps" aria-label="Progress">
      {items.map(([title, sub], i) => {
        const state = i < active ? "done" : i === active ? "current" : "todo";
        return (
          <Fragment key={title}>
            <li className="prompts-step" data-state={state}>
              <span className="prompts-step-dot" aria-hidden="true">
                {state === "done" ? <Check className="size-3" /> : i + 1}
              </span>
              <span className="flex min-w-0 flex-col">
                <b className="truncate">{title}</b>
                <span className="monitor-hint truncate">{sub}</span>
              </span>
            </li>
            {i < items.length - 1 && (
              <li
                aria-hidden="true"
                className="prompts-step-line"
                data-done={i < active || undefined}
              />
            )}
          </Fragment>
        );
      })}
    </ol>
  );
}

/** Colours the labels of a composed request: headings and "Label:" prefixes. */
function highlight(text: string): ReactNode {
  return text.split("\n").map((line, i) => {
    const heading = /^#{1,2} /.test(line);
    const label = /^([A-Za-z][A-Za-z ()_-]{0,48}:)(.*)$/.exec(line);
    return (
      <Fragment key={i}>
        {i > 0 && "\n"}
        {heading ? (
          <span className="k">{line}</span>
        ) : label ? (
          <>
            <span className="k">{label[1]}</span>
            {label[2]}
          </>
        ) : (
          line
        )}
      </Fragment>
    );
  });
}

function PromptComposer({ prompt }: { prompt: PromptTemplate }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [request, setRequest] = useState("");
  const [device, setDevice] = useState("");
  const [copied, setCopied] = useState("");
  const [preview, setPreview] = useState(false);
  const missing = missingPromptArguments(prompt, values);
  const text = missing.length ? "" : composePrompt(prompt, values, request, device);
  const filled = prompt.arguments.filter((a) => (values[a.name] ?? "").trim()).length;
  const isCopied = copied === text && text !== "";
  const active = missing.length ? 1 : isCopied ? 3 : 2;
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      toast.success("Request copied. Paste it into your MCP-connected assistant.");
    } catch {
      toast.error("Clipboard unavailable. Select and copy the preview text below.");
      setPreview(true);
    }
  }
  return (
    <section className="monitor-panel" aria-label="Prompt composer">
      <div className="border-b border-line px-[22px] py-[18px]">
        <Steps
          active={active}
          items={[
            ["Pick a workflow", promptCategory(prompt)],
            ["Add your context", `${filled} of ${prompt.arguments.length} inputs filled`],
            ["Copy the request", "Runs no tools"],
            ["Paste and run", "Any MCP client"],
          ]}
        />
      </div>
      <div className="flex flex-col gap-1.5 px-[22px] pt-[18px] pb-1.5">
        <span className="flex items-center gap-2 text-xs font-medium text-success">
          <SlidersHorizontal aria-hidden="true" className="size-[15px]" /> Compose your request
        </span>
        <h2 className="text-[22px] leading-7 font-semibold tracking-[-0.02em] text-emphasis">
          {prompt.title}
        </h2>
        <p className="text-[13px] text-fg-secondary">{prompt.description}</p>
        <code className="font-mono text-xs break-all text-faint">/{prompt.name}</code>
      </div>
      <div className="grid gap-4 px-[22px] pt-3 pb-5 sm:grid-cols-2">
        <label className="monitor-fl sm:col-span-2">
          <span className="monitor-label">
            Your request · describe the outcome, symptoms or constraints
          </span>
          <textarea
            dir="auto"
            className="monitor-input prompts-request"
            aria-label="Your request"
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            maxLength={12000}
            placeholder="For example: investigate evening slowdowns without interrupting anyone…"
          />
        </label>
        <label className="monitor-fl">
          <span className="monitor-label">Target router · optional</span>
          <span className="monitor-input">
            <Server aria-hidden="true" className="size-[15px] flex-none text-muted-foreground" />
            <input
              className="prompts-bare"
              aria-label="Target router"
              value={device}
              onChange={(e) => setDevice(e.target.value)}
              maxLength={200}
              placeholder="core-router-01"
            />
          </span>
          <span className="monitor-hint">
            Exact configured device name. Leave blank and the assistant asks first.
          </span>
        </label>
        <div className="hidden sm:block" />
        {prompt.arguments.map((arg) => (
          <label key={arg.name} className="monitor-fl">
            <span className="monitor-label">
              {arg.name.replaceAll("_", " ")}{" "}
              {arg.required ? (
                <span className="text-success">*</span>
              ) : (
                <span className="font-normal text-faint">· optional</span>
              )}
            </span>
            <input
              className="monitor-input font-mono"
              aria-label={arg.name}
              required={arg.required}
              value={values[arg.name] ?? ""}
              onChange={(e) => setValues({ ...values, [arg.name]: e.target.value })}
              maxLength={4000}
            />
            {arg.description && <span className="monitor-hint">{arg.description}</span>}
          </label>
        ))}
        <MonitorNote
          tone="good"
          icon={<ShieldCheck aria-hidden="true" />}
          className="sm:col-span-2"
        >
          <b>Preparing a request runs no tools.</b> Review the text before you share it, then run
          the workflow in an assistant connected to MikroTik MCP.
        </MonitorNote>
        {missing.length > 0 && (
          <p className="monitor-hint sm:col-span-2" role="status">
            Complete required inputs: {missing.join(", ")}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
          <MonitorButton
            variant="primary"
            onClick={() => void copy()}
            disabled={!text}
            icon={isCopied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          >
            {isCopied ? "Copied" : "Copy request"}
          </MonitorButton>
          <MonitorButton
            variant="ghost"
            onClick={() => setPreview(!preview)}
            aria-expanded={preview}
            icon={<Eye aria-hidden="true" />}
          >
            {preview ? "Hide preview" : "Preview request"}
          </MonitorButton>
          <span className="flex-1" />
          <span className="monitor-hint">
            Then paste into{" "}
            <a
              className="prompts-link"
              href="https://chatgpt.com/"
              target="_blank"
              rel="noopener noreferrer"
            >
              ChatGPT
            </a>{" "}
            ·{" "}
            <a
              className="prompts-link"
              href="https://claude.ai/new"
              target="_blank"
              rel="noopener noreferrer"
            >
              Claude
            </a>{" "}
            or any MCP client.
          </span>
        </div>
        {preview && (
          <div className="flex min-w-0 flex-col gap-2 sm:col-span-2">
            <div className="flex items-center gap-2">
              <StatusBadge tone={text ? "good" : "warn"}>
                {text ? "Ready to share" : "Template · incomplete"}
              </StatusBadge>
              <span className="flex-1" />
              <span className="font-mono text-xs text-muted-foreground">
                {(text || prompt.body).length.toLocaleString()} characters
              </span>
            </div>
            <pre
              tabIndex={0}
              aria-label="Request preview"
              className={cn("monitor-pre prompts-pre max-h-[440px] overflow-auto break-words")}
            >
              {highlight(text || prompt.body)}
            </pre>
          </div>
        )}
      </div>
    </section>
  );
}
