import { Fragment, useId, useMemo, useState } from "react";
import { Asterisk, Check, Plus, Terminal, X } from "lucide-react";
import { globMatch } from "../../src/core/tool-pattern";
import type { AccessSettings } from "../../src/observability/access-settings";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@/components/beui/registry/components/motion/combobox";
import { Button } from "./geist";

// Filtering happens before mounting options, so a large catalog stays responsive.
const RESULTS_LIMIT = 80;
const alreadyFiltered = () => true;

/** Adds named tools or persistent glob rules; selecting a glob never expands it into names. */
export function AccessToolPicker({
  kind,
  values,
  tools,
  onChange,
  disabled = false,
}: {
  kind: "allow" | "block";
  values: string[];
  tools: AccessSettings["tools"];
  onChange: (values: string[]) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const pattern = query.trim();
  const isGlob = pattern.includes("*");
  const validGlob = isGlob && pattern.length <= 200 && !/[\s,]/.test(pattern);
  const selected = useMemo(() => new Set(values.map((v) => v.toLowerCase())), [values]);
  const matches = useMemo(
    () =>
      tools.filter((tool) =>
        isGlob
          ? globMatch(pattern, tool.name)
          : tool.name.toLowerCase().includes(pattern.toLowerCase()),
      ),
    [tools, pattern, isGlob],
  );
  const rows = matches.slice(0, RESULTS_LIMIT);
  const matchedCount = useMemo(
    () => tools.filter((t) => values.some((v) => globMatch(v, t.name))).length,
    [tools, values],
  );
  const add = (value: string) => {
    if (disabled || selected.has(value.toLowerCase())) return;
    onChange([...values, value]);
    setQuery("");
  };
  const name = kind === "allow" ? "Allowed tools" : "Blocked tools";
  const helper = isGlob
    ? !validGlob
      ? "Use one pattern at a time, up to 200 characters. Only * is a wildcard."
      : selected.has(pattern.toLowerCase())
        ? "This pattern is already selected."
        : `${matches.length} current tools match. Add the pattern to include future matches too.`
    : `Search all ${tools.length} tools, or type a glob such as ${kind === "allow" ? "get_*" : "remove_*"}.`;

  return (
    <div className="access-tool-picker" data-kind={kind}>
      <div className="access-picker-label" id={`${id}-label`}>
        <span>{kind === "allow" ? "Allow matching tools" : "Always block"}</span>
        <small>{kind === "allow" ? "empty = all" : "takes precedence"}</small>
      </div>
      <Combobox
        value=""
        query={query}
        onQueryChange={setQuery}
        onValueChange={add}
        open={open}
        onOpenChange={setOpen}
        disabled={disabled}
        filter={alreadyFiltered}
      >
        <ComboboxTrigger className="access-tool-trigger">
          <ComboboxInput
            aria-label={name}
            aria-describedby={`${id}-hint`}
            placeholder="Search tools or add a * pattern…"
            className="access-tool-input"
            maxLength={200}
          />
        </ComboboxTrigger>
        <ComboboxContent className="access-tool-menu">
          <div className="access-tool-menu-heading">
            <span>{isGlob ? "PATTERN MATCHES" : "TOOL CATALOG"}</span>
            <span>{matches.length} tools</span>
          </div>
          <ComboboxList ariaLabel={`${name} options`} className="access-tool-options">
            {open && (
              // Re-register this bounded result set in visible order when the
              // query changes; the new glob action must also be first for keys.
              <Fragment key={pattern}>
                {validGlob && (
                  <ComboboxItem
                    key={`glob:${pattern}`}
                    value={pattern}
                    disabled={selected.has(pattern.toLowerCase())}
                    textValue={`Add pattern ${pattern}`}
                    className="access-tool-option access-glob-option"
                  >
                    <span className="access-tool-option-content">
                      <Asterisk aria-hidden="true" />
                      <span>
                        <strong>{pattern}</strong>
                        <small>Add glob rule · {matches.length} current matches</small>
                      </span>
                      <Plus aria-hidden="true" />
                    </span>
                  </ComboboxItem>
                )}
                {rows.map((tool) => (
                  <ComboboxItem
                    key={tool.name}
                    value={tool.name}
                    textValue={tool.name}
                    disabled={selected.has(tool.name.toLowerCase())}
                    className="access-tool-option"
                  >
                    <span className="access-tool-option-content">
                      <Terminal aria-hidden="true" />
                      <span>
                        <strong>{tool.name}</strong>
                        <small>
                          {tool.risk.replaceAll("_", " ")}
                          {tool.noDevice ? " · server tool" : ""}
                        </small>
                      </span>
                      {selected.has(tool.name.toLowerCase()) && <Check aria-hidden="true" />}
                    </span>
                  </ComboboxItem>
                ))}
              </Fragment>
            )}
            <ComboboxEmpty className="text-xs">
              No tools match. Add a * pattern to cover future tools.
            </ComboboxEmpty>
          </ComboboxList>
          <div className="access-tool-menu-footer">
            {matches.length > RESULTS_LIMIT
              ? `First ${RESULTS_LIMIT} of ${matches.length} matches · type to narrow`
              : "↑ ↓ navigate · Enter adds · Esc closes"}
          </div>
        </ComboboxContent>
      </Combobox>
      <p id={`${id}-hint`} className="access-picker-hint" role="status">
        {helper}
      </p>
      <div className="access-tool-tokens" aria-label={`${name} rules`}>
        {!values.length && (
          <span className="access-picker-empty">
            {kind === "allow"
              ? "All tool names · other boundaries still apply"
              : "No explicit tool exclusions"}
          </span>
        )}
        {values.map((value) => {
          const glob = value.includes("*");
          const count = tools.filter((t) => globMatch(value, t.name)).length;
          return (
            <span className="access-tool-token" key={value} data-glob={glob || undefined}>
              {glob ? <Asterisk aria-hidden="true" /> : <Terminal aria-hidden="true" />}
              <code>{value}</code>
              <small title="Matching tools in the current catalog">{count}</small>
              <Button
                ghost
                size="sm"
                disabled={disabled}
                aria-label={`Remove ${value} from ${name.toLowerCase()}`}
                onClick={() => onChange(values.filter((v) => v !== value))}
              >
                <X aria-hidden="true" />
              </Button>
            </span>
          );
        })}
      </div>
      <div className="access-picker-summary">
        <span>{values.length} rules</span>
        <span>
          {!values.length && kind === "allow" ? tools.length : matchedCount} / {tools.length} tool
          names
        </span>
      </div>
    </div>
  );
}
