/**
 * Combobox and MultiSelect (Kit-Combobox): fields you type into that also
 * offer known values. They replace <datalist> and free-text fields with a list.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ClipboardEvent, KeyboardEvent, ReactNode } from "react";
import { Plus, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Floating, useIsPhone } from "./floating";
import { edge, KeyHints, matches, OptionList, optionId, step } from "./listbox";
import type { KitOption } from "./listbox";
import { useField } from "./field-context";

interface ComboBase {
  options: readonly KitOption[];
  label: string;
  placeholder?: string;
  /** A value not in the list is allowed, offered as the last row. */
  allowCustom?: boolean;
  /** Noun for the empty state: "No interface called …". */
  noun?: string;
  loading?: boolean;
  loadingText?: string;
  invalid?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
}

function Loading({ text }: { text?: string }): ReactNode {
  return (
    <div className="flex flex-col gap-3 p-1.5" role="status">
      <div className="kit-sk" style={{ width: "80%" }} />
      <div className="kit-sk" style={{ width: "62%" }} />
      <div className="kit-sk" style={{ width: "72%" }} />
      {text && <p className="kit-help">{text}</p>}
    </div>
  );
}

function useListKeys(
  shown: readonly KitOption[],
  extra: number,
  setActive: (f: (a: number) => number) => void,
): (e: KeyboardEvent, onEnter: () => void, onEsc?: () => void) => boolean {
  // `extra` rows (the "use as typed" row) sit after the options.
  return (e, onEnter, onEsc) => {
    const total = shown.length + extra;
    const k = e.key;
    if (k === "ArrowDown")
      setActive((a) => (a >= shown.length - 1 && extra ? shown.length : step(shown, a, 1)));
    else if (k === "ArrowUp")
      setActive((a) => (a >= shown.length ? edge(shown, true) : step(shown, a < 0 ? 0 : a, -1)));
    else if (k === "Enter") onEnter();
    else if (k === "Escape" && onEsc) onEsc();
    else return false;
    if (total > 0 || k === "Enter" || k === "Escape") e.preventDefault();
    return true;
  };
}

/* ------------------------------------------------------------------ Combobox */

export function Combobox({
  value,
  onChange,
  options,
  label,
  placeholder,
  allowCustom = true,
  noun = "value",
  loading = false,
  loadingText,
  invalid,
  disabled,
  id,
  className,
  mono = false,
  icon = <Search />,
}: ComboBase & {
  value: string;
  onChange: (value: string) => void;
  mono?: boolean;
  icon?: ReactNode;
}): ReactNode {
  const f = useField();
  const base = useId().replace(/:/g, "");
  const listId = `${base}-list`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [typing, setTyping] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const phone = useIsPhone(open);

  const query = typing ? value : "";
  const shown = useMemo(() => options.filter((o) => matches(o, query)), [options, query]);
  const exact = options.some((o) => o.value === value || o.label === value);
  const custom = allowCustom && value.trim() !== "" && !exact;
  const selected = useMemo(() => new Set([value]), [value]);
  const keys = useListKeys(shown, custom ? 1 : 0, setActive);

  useEffect(() => {
    if (open) setActive(shown.length > 0 ? edge(shown, false) : custom ? shown.length : -1);
  }, [query, open]); // eslint-disable-line react-hooks/exhaustive-deps -- reset on new text

  const pick = (o: KitOption): void => {
    onChange(o.value);
    setTyping(false);
    setOpen(false);
    inputRef.current?.focus({ preventScroll: true });
  };
  const onKey = (e: KeyboardEvent): void => {
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      setOpen(true);
      e.preventDefault();
      return;
    }
    keys(
      e,
      () => {
        if (!open) return;
        const o = shown[active];
        if (o && !o.disabled) pick(o);
        else if (active === shown.length && custom) {
          setTyping(false);
          setOpen(false);
        }
      },
      open ? () => setOpen(false) : undefined,
    );
  };

  const field = (
    <div
      ref={wrapRef}
      className={cn("kit-input", className)}
      data-invalid={invalid || f.invalid || undefined}
      data-disabled={disabled || undefined}
      data-mono={mono || undefined}
    >
      {icon}
      <input
        ref={inputRef}
        id={id ?? f.id}
        role="combobox"
        aria-label={f.id ? undefined : label}
        aria-describedby={f.describedBy}
        aria-invalid={invalid || f.invalid || undefined}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={
          open && active >= 0 && active < shown.length ? optionId(listId, active) : undefined
        }
        aria-busy={loading || undefined}
        disabled={disabled}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          setTyping(true);
          onChange(e.target.value);
          setOpen(true);
        }}
        onClick={() => {
          if (!open) setTyping(false);
          setOpen(true);
        }}
        onKeyDown={onKey}
        onBlur={(e) => {
          if (!phone && !e.relatedTarget?.closest?.(".kit-menu")) setOpen(false);
        }}
      />
      {loading && <span className="kit-spin" aria-hidden="true" />}
    </div>
  );

  const customRow = custom ? (
    <div
      id={optionId(listId, shown.length)}
      role="option"
      aria-selected={false}
      data-active={active === shown.length}
      className="kit-opt"
      onPointerMove={() => setActive(() => shown.length)}
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => {
        setTyping(false);
        setOpen(false);
      }}
    >
      <span className="ico" aria-hidden="true">
        <Plus />
      </span>
      <span className="t">Use “{value}” as typed</span>
    </div>
  ) : null;

  return (
    <Floating
      open={open && !disabled}
      onOpenChange={setOpen}
      anchor={field}
      title={label}
      phone={phone}
      keep={wrapRef}
      onOpenFocus={inputRef}
    >
      {phone && (
        <label className="kit-search">
          <Search aria-hidden="true" />
          <input
            aria-label={label}
            value={value}
            placeholder={placeholder}
            onChange={(e) => {
              setTyping(true);
              onChange(e.target.value);
            }}
            onKeyDown={onKey}
            autoComplete="off"
          />
        </label>
      )}
      {loading ? (
        <Loading text={loadingText} />
      ) : shown.length === 0 && !custom ? (
        <div className="kit-empty">
          <b>
            No {noun} called “{value}”
          </b>
          {allowCustom ? "Check the name, or add it as typed." : "Check the name."}
        </div>
      ) : (
        <OptionList
          id={listId}
          label={label}
          options={shown}
          active={active}
          selected={selected}
          query={query}
          onPick={pick}
          onHover={(i) => setActive(() => i)}
          footer={
            customRow && (
              <>
                {shown.length > 0 && <div className="kit-sep" role="presentation" />}
                {customRow}
              </>
            )
          }
        />
      )}
      {!phone && !loading && shown.length > 3 && <KeyHints />}
    </Floating>
  );
}

/* --------------------------------------------------------------- MultiSelect */

export function MultiSelect({
  value,
  onChange,
  options,
  label,
  placeholder = "Add…",
  allowCustom = false,
  noun = "value",
  loading = false,
  loadingText,
  invalid,
  disabled,
  id,
  className,
  maxVisible = 3,
}: ComboBase & {
  value: readonly string[];
  onChange: (value: string[]) => void;
  /** Tags shown before the rest collapse into "+N" while the field is idle. */
  maxVisible?: number;
}): ReactNode {
  const f = useField();
  const base = useId().replace(/:/g, "");
  const listId = `${base}-list`;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [active, setActive] = useState(-1);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const tagsRef = useRef<HTMLDivElement>(null);
  const phone = useIsPhone(open);

  const shown = useMemo(() => options.filter((o) => matches(o, text)), [options, text]);
  const custom =
    allowCustom &&
    text.trim() !== "" &&
    !options.some((o) => o.value === text.trim()) &&
    !value.includes(text.trim());
  const selected = useMemo(() => new Set(value), [value]);
  const keys = useListKeys(shown, custom ? 1 : 0, setActive);
  const labelOf = (v: string): string => options.find((o) => o.value === v)?.label ?? v;

  useEffect(() => {
    if (open) setActive(shown.length > 0 ? edge(shown, false) : custom ? shown.length : -1);
  }, [text, open]); // eslint-disable-line react-hooks/exhaustive-deps -- reset on new text

  const toggle = (v: string): void => {
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
    setText("");
    inputRef.current?.focus({ preventScroll: true });
  };
  const addMany = (raw: string): void => {
    const add = raw
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(
        (s) => s && !value.includes(s) && (allowCustom || options.some((o) => o.value === s)),
      );
    if (add.length) onChange([...value, ...add]);
  };

  const dup = text.trim() !== "" && value.includes(text.trim());
  const onKey = (e: KeyboardEvent): void => {
    // An input method (IME) is still composing: Enter belongs to it.
    if (e.nativeEvent.isComposing) return;
    if (e.key === "," && text.trim() !== "") {
      e.preventDefault();
      addMany(text);
      setText("");
      return;
    }
    if (e.key === "Backspace" && text === "" && value.length > 0) {
      onChange(value.slice(0, -1));
      e.preventDefault();
      return;
    }
    if (!open && e.key === "ArrowDown") {
      setOpen(true);
      e.preventDefault();
      return;
    }
    keys(
      e,
      () => {
        const o = shown[active];
        if (o && !o.disabled) toggle(o.value);
        else if (custom) {
          addMany(text);
          setText("");
        }
      },
      open ? () => setOpen(false) : undefined,
    );
  };

  const collapsed = !focused && !open && value.length > maxVisible;
  const visible = collapsed ? value.slice(0, maxVisible - 1) : value;

  const field = (
    <div
      ref={tagsRef}
      className={cn("kit-tags", className)}
      data-open={open}
      data-invalid={invalid || f.invalid || undefined}
      data-disabled={disabled || undefined}
      onClick={() => {
        inputRef.current?.focus();
        setOpen(true);
      }}
    >
      {visible.map((v) => (
        <span key={v} className="kit-tag">
          {labelOf(v)}
          <button
            type="button"
            aria-label={`Remove ${labelOf(v)}`}
            disabled={disabled}
            onClick={(e) => {
              e.stopPropagation();
              toggle(v);
            }}
          >
            <X aria-hidden="true" />
          </button>
        </span>
      ))}
      {collapsed && (
        <span className="kit-tag" data-more="true">
          +{value.length - visible.length}
        </span>
      )}
      <input
        ref={inputRef}
        id={id ?? f.id}
        role="combobox"
        aria-label={f.id ? undefined : label}
        aria-describedby={f.describedBy}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={
          open && active >= 0 && active < shown.length ? optionId(listId, active) : undefined
        }
        aria-autocomplete="list"
        disabled={disabled}
        value={text}
        placeholder={value.length === 0 ? placeholder : ""}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onPaste={(e: ClipboardEvent<HTMLInputElement>) => {
          const t = e.clipboardData.getData("text");
          if (/[,\n]/.test(t)) {
            e.preventDefault();
            addMany(t);
          }
        }}
        onFocus={() => setFocused(true)}
        onBlur={(e) => {
          setFocused(false);
          if (!phone && !e.relatedTarget?.closest?.(".kit-menu")) setOpen(false);
        }}
        onKeyDown={onKey}
      />
    </div>
  );

  return (
    <Floating
      open={open && !disabled}
      onOpenChange={setOpen}
      anchor={field}
      title={label}
      phone={phone}
      keep={tagsRef}
      onOpenFocus={inputRef}
    >
      {phone && (
        <label className="kit-search">
          <Search aria-hidden="true" />
          <input
            aria-label={label}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            autoComplete="off"
          />
        </label>
      )}
      {loading ? (
        <Loading text={loadingText} />
      ) : dup ? (
        <div className="kit-empty">
          <b>This {noun} is already selected.</b>
        </div>
      ) : shown.length === 0 && !custom ? (
        <div className="kit-empty">
          <b>{text ? `No ${noun} called “${text}”` : `No ${noun}s yet`}</b>
        </div>
      ) : (
        <OptionList
          id={listId}
          label={label}
          multi
          options={shown}
          active={active}
          selected={selected}
          query={text}
          onPick={(o) => toggle(o.value)}
          onHover={(i) => setActive(() => i)}
          footer={
            custom && (
              <div
                id={optionId(listId, shown.length)}
                role="option"
                aria-selected={false}
                data-active={active === shown.length}
                className="kit-opt"
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => {
                  addMany(text);
                  setText("");
                }}
              >
                <span className="ico" aria-hidden="true">
                  <Plus />
                </span>
                <span className="t">Add “{text.trim()}”</span>
              </div>
            )
          }
        />
      )}
      {!phone && !loading && shown.length > 3 && <KeyHints />}
    </Floating>
  );
}
