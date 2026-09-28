import { useEffect, useState } from "react";
import {
  ArrowRight,
  BookOpen,
  Check,
  Copy,
  ExternalLink,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { composePrompt, missingPromptArguments, promptCategory } from "../../src/prompts/compose";
import type { PromptTemplate } from "../../src/prompts/compose";
import { api } from "./api";
import { Button, Input, Select, Spinner } from "./geist";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";

export function PromptsView() {
  const [prompts, setPrompts] = useState<PromptTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All workflows");
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
  const categories = [...new Set(prompts.map(promptCategory))].sort();
  const matches = prompts.filter(
    (p) =>
      (category === "All workflows" || promptCategory(p) === category) &&
      query
        .toLowerCase()
        .split(/\s+/)
        .every((word) => `${p.name} ${p.title} ${p.description}`.toLowerCase().includes(word)),
  );
  const current = prompts.find((p) => p.name === selected);
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <section className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-5">
        <div className="max-w-xl">
          <div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.18em] text-brand">
            <BookOpen size={14} /> Workflow library
          </div>
          <h2 className="text-2xl font-semibold tracking-tight">Start with a better brief.</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Choose a router workflow. Add your context. Take a complete request to your AI
            assistant.
          </p>
        </div>
        <Button
          ghost
          size="sm"
          onClick={() => {
            setLoading(true);
            setError("");
            setReload((n) => n + 1);
          }}
          disabled={loading}
          icon={<RefreshCw size={14} />}
        >
          Refresh library
        </Button>
      </section>
      {error && (
        <div role="alert" className="rounded-xl border border-destructive/40 p-5 text-sm">
          Could not load prompts: {error}. Check the dashboard connection and retry.
        </div>
      )}
      {loading && !prompts.length ? (
        <div role="status" className="p-10">
          <Spinner /> Loading workflows…
        </div>
      ) : (
        <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(260px,0.8fr)_minmax(0,1.6fr)]">
          <section
            aria-label="Workflow library"
            className="min-w-0 rounded-2xl border border-border bg-card"
          >
            <div className="grid gap-3 border-b border-border p-4">
              <div className="flex items-center gap-2">
                <Search size={16} className="shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <Input
                    aria-label="Search workflows"
                    placeholder="Search a task, tool or outcome…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
              </div>
              <Select
                aria-label="Workflow category"
                value={category}
                onValueChange={setCategory}
                options={["All workflows", ...categories].map((value) => ({ value, label: value }))}
              />
              <span className="text-xs text-muted-foreground" role="status">
                {matches.length} of {prompts.length} workflows
              </span>
            </div>
            <div className="max-h-[56vh] space-y-1 overflow-y-auto p-2 xl:max-h-[680px]">
              {matches.map((p) => (
                <button
                  key={p.name}
                  type="button"
                  aria-pressed={p.name === selected}
                  onClick={() => setSelected(p.name)}
                  className={cn(
                    "group w-full rounded-xl border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                    p.name === selected
                      ? "border-brand/40 bg-brand/10"
                      : "border-transparent hover:bg-accent",
                  )}
                >
                  <span className="flex items-center justify-between gap-3">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      {promptCategory(p)}
                    </span>
                    {p.name === selected && <ArrowRight size={14} className="text-brand" />}
                  </span>
                  <span className="mt-1.5 block text-sm font-semibold text-foreground">
                    {p.title}
                  </span>
                  <span className="mt-1 block line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                    {p.description}
                  </span>
                  <span className="mt-2 block font-mono text-[10px] text-muted-foreground">
                    {p.arguments.filter((a) => a.required).length} required · {p.arguments.length}{" "}
                    inputs
                  </span>
                </button>
              ))}
              {!matches.length && (
                <p className="p-6 text-sm text-muted-foreground">
                  No matching workflows. Try another search or category.
                </p>
              )}
            </div>
          </section>
          {current ? (
            <PromptComposer key={current.name} prompt={current} />
          ) : (
            <p className="p-6 text-sm text-muted-foreground">
              No prompts available. Check that the server includes its prompts directory.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function PromptComposer({ prompt }: { prompt: PromptTemplate }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [request, setRequest] = useState("");
  const [device, setDevice] = useState("");
  const [copied, setCopied] = useState("");
  const [preview, setPreview] = useState(false);
  const missing = missingPromptArguments(prompt, values);
  const text = missing.length ? "" : composePrompt(prompt, values, request, device);
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
    <section
      className="min-w-0 overflow-hidden rounded-2xl border border-border bg-card"
      aria-label="Prompt composer"
    >
      <div className="border-b border-border p-5 sm:p-6">
        <div className="mb-3 flex items-center gap-2 text-xs text-brand">
          <SlidersHorizontal size={15} /> Compose your request
        </div>
        <h3 className="text-xl font-semibold tracking-tight">{prompt.title}</h3>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{prompt.description}</p>
        <code className="mt-3 block break-all text-[11px] text-muted-foreground">
          /{prompt.name}
        </code>
      </div>
      <div className="grid gap-5 p-5 sm:p-6">
        <label className="grid gap-2 text-xs font-medium">
          Your request{" "}
          <span className="font-normal text-muted-foreground">
            Describe the outcome, symptoms or constraints.
          </span>
          <Textarea
            dir="auto"
            className="min-h-24 text-sm"
            aria-label="Your request"
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            maxLength={12000}
            placeholder="For example: investigate evening slowdowns without interrupting anyone…"
          />
        </label>
        <label className="grid gap-2 text-xs font-medium">
          Target router · optional
          <Input
            aria-label="Target router"
            value={device}
            onChange={(e) => setDevice(e.target.value)}
            maxLength={200}
            placeholder="Exact configured device name; leave blank to ask first"
          />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          {prompt.arguments.map((arg) => (
            <label key={arg.name} className="grid content-start gap-2 text-xs font-medium">
              <span>
                {arg.name.replaceAll("_", " ")}{" "}
                {arg.required ? (
                  <span className="text-brand">*</span>
                ) : (
                  <span className="font-normal text-muted-foreground">· optional</span>
                )}
              </span>
              <Input
                aria-label={arg.name}
                required={arg.required}
                value={values[arg.name] ?? ""}
                onChange={(e) => setValues({ ...values, [arg.name]: e.target.value })}
                maxLength={4000}
              />
              <span className="font-normal leading-relaxed text-muted-foreground">
                {arg.description}
              </span>
            </label>
          ))}
        </div>
        <div className="flex items-start gap-3 rounded-xl border border-border bg-background p-3 text-xs leading-relaxed text-muted-foreground">
          <ShieldCheck size={18} className="shrink-0 text-brand" />
          <span>
            Preparing a request runs no tools. Review the text before sharing; use an assistant
            connected to MikroTik MCP to execute the workflow.
          </span>
        </div>
        {missing.length > 0 && (
          <p className="text-xs text-muted-foreground" role="status">
            Complete required inputs: {missing.join(", ")}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() => void copy()}
            disabled={!text}
            icon={copied === text && text ? <Check size={15} /> : <Copy size={15} />}
          >
            {copied === text && text ? "Copied" : "Copy request"}
          </Button>
          <Button ghost onClick={() => setPreview(!preview)} aria-expanded={preview}>
            {preview ? "Hide preview" : "Preview request"}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span>Then paste into</span>
          {[
            ["ChatGPT", "https://chatgpt.com/"],
            ["Claude", "https://claude.ai/new"],
          ].map(([name, url]) => (
            <a
              key={name}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded text-brand underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
            >
              {name}
              <ExternalLink size={12} />
            </a>
          ))}
          <span>or any MCP client.</span>
        </div>
        {preview && (
          <div className="min-w-0">
            <div className="mb-2 flex justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
              <span>{text ? "Ready to share" : "Template · incomplete"}</span>
              <span>{(text || prompt.body).length.toLocaleString()} characters</span>
            </div>
            <pre
              tabIndex={0}
              aria-label="Request preview"
              className="max-h-[440px] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-background p-4 font-mono text-xs leading-relaxed"
            >
              {text || prompt.body}
            </pre>
          </div>
        )}
      </div>
    </section>
  );
}
