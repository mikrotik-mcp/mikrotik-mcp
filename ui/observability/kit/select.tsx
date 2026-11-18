/**
 * Select (Kit-Select): one value from a list. Replaces every native <select>.
 * A search box appears when there are more than 8 options. Keyboard: arrows,
 * Home/End, Enter/Space, Esc, and typeahead on the closed trigger.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { ChevronDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Floating, useIsPhone } from "./floating";
import { edge, KeyHints, Led, matches, OptionList, optionId, step } from "./listbox";
import type { KitOption } from "./listbox";
import { useField } from "./field-context";

export interface SelectProps<V extends string> {
  value: V | "" | null | undefined;
  onChange: (value: V) => void;
  options: readonly KitOption<V>[];
  /** Accessible name. Also the sheet heading on a phone. */
  label: string;
  placeholder?: string;
  size?: "md" | "sm";
  invalid?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  loading?: boolean;
  /** Shown before the value, e.g. an icon. Defaults to the chosen option's LED or icon. */
  leading?: ReactNode;
  /** Show the chosen option's meta on the trigger ("12 ms"). */
  showMeta?: boolean;
  /** true / false forces the search box; default: more than 8 options. */
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyText?: string;
  id?: string;
  className?: string;
  style?: CSSProperties;
  "aria-describedby"?: string;
  "aria-labelledby"?: string;
}

const TYPEAHEAD_MS = 600;

export function Select<V extends string>({
  value,
  onChange,
  options,
  label,
  placeholder = "Choose…",
  size = "md",
  invalid = false,
  disabled = false,
  readOnly = false,
  loading = false,
  leading,
  showMeta = false,
  searchable,
  searchPlaceholder,
  emptyText = "Nothing matches",
  id,
  className,
  style,
  ...aria
}: SelectProps<V>): ReactNode {
  const f = useField();
  const bad = invalid || f.invalid;
  const base = useId().replace(/:/g, "");
  const listId = `${base}-list`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listFocusRef = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const phone = useIsPhone(open);

  const chosen = options.find((o) => o.value === value);
  const withSearch = searchable ?? options.length > 8;
  const shown = useMemo(
    () => (withSearch && query ? options.filter((o) => matches(o, query)) : options),
    [options, query, withSearch],
  );
  const selected = useMemo(() => new Set(value ? [value] : []), [value]);

  const show = (start?: "first" | "last"): void => {
    if (disabled || readOnly || loading) return;
    setQuery("");
    const idx = chosen ? options.indexOf(chosen) : -1;
    setActive(
      start === "last" ? edge(options, true) : idx >= 0 && !start ? idx : edge(options, false),
    );
    setOpen(true);
  };
  const close = (): void => {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  };
  const pick = (o: KitOption<V>): void => {
    if (o.value !== value) onChange(o.value);
    close();
  };

  // Keep the active row valid while the search narrows the list.
  useEffect(() => {
    if (!open) return;
    if (active >= shown.length || (active >= 0 && shown[active]?.disabled))
      setActive(edge(shown, false));
  }, [shown, active, open]);

  // Typing letters jumps to the next option that starts with them.
  const typeahead = (key: string, go: (i: number) => void): void => {
    const now = Date.now();
    const t = typed.current;
    t.text = now - t.at > TYPEAHEAD_MS ? key : t.text + key;
    t.at = now;
    const q = t.text.toLowerCase();
    const from = Math.max(
      0,
      options.findIndex((o) => o.value === value),
    );
    for (let i = 0; i < options.length; i++) {
      const j = (from + (t.text.length === 1 ? i + 1 : i)) % options.length;
      const o = options[j]!;
      if (!o.disabled && o.label.toLowerCase().startsWith(q)) return go(j);
    }
  };

  const onListKey = (e: KeyboardEvent): void => {
    const k = e.key;
    if (k === "ArrowDown") setActive((a) => step(shown, a, 1));
    else if (k === "ArrowUp") setActive((a) => step(shown, a < 0 ? 0 : a, -1));
    else if (k === "Home") setActive(edge(shown, false));
    else if (k === "End") setActive(edge(shown, true));
    else if (k === "Enter" || (k === " " && !withSearch)) {
      const o = shown[active];
      if (o && !o.disabled) pick(o as KitOption<V>);
    } else if (k === "Tab") {
      setOpen(false);
      return;
    } else if (!withSearch && k.length === 1) {
      typeahead(k, (i) => setActive(i));
    } else return;
    e.preventDefault();
  };

  const onTriggerKey = (e: KeyboardEvent): void => {
    if (open) return;
    const k = e.key;
    if (k === "ArrowDown" || k === "Enter" || k === " ") show();
    else if (k === "ArrowUp") show("last");
    else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey)
      typeahead(k, (i) => {
        const o = options[i]!;
        if (o.value !== value) onChange(o.value);
      });
    else return;
    e.preventDefault();
  };

  const lead =
    leading ??
    (chosen?.led ? (
      <Led tone={chosen.led} />
    ) : chosen?.icon ? (
      <span className="lead" aria-hidden="true">
        {chosen.icon}
      </span>
    ) : null);

  const trigger = (
    <button
      ref={triggerRef}
      id={id ?? f.id}
      type="button"
      role="combobox"
      aria-label={aria["aria-labelledby"] || (f.id && !id) ? undefined : label}
      aria-labelledby={aria["aria-labelledby"]}
      aria-describedby={aria["aria-describedby"] ?? f.describedBy}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? listId : undefined}
      aria-invalid={bad || undefined}
      aria-readonly={readOnly || undefined}
      aria-busy={loading || undefined}
      disabled={disabled}
      data-open={open}
      data-size={size}
      data-readonly={readOnly || undefined}
      className={cn("kit-trigger", className)}
      style={style}
      onClick={() => (open ? close() : show())}
      onKeyDown={onTriggerKey}
    >
      {typeof lead === "string" ? null : lead}
      <span className={cn("v", !chosen && "ph")}>{chosen ? chosen.label : placeholder}</span>
      {showMeta && chosen?.meta != null && <span className="sub">{chosen.meta}</span>}
      {loading ? (
        <span className="kit-spin" aria-hidden="true" />
      ) : (
        !readOnly && (
          <span className="kit-chev" aria-hidden="true">
            <ChevronDown />
          </span>
        )
      )}
    </button>
  );

  return (
    <Floating
      open={open}
      onOpenChange={(o) => (o ? show() : close())}
      anchor={trigger}
      title={label}
      phone={phone}
      keep={triggerRef}
      onOpenFocus={withSearch ? searchRef : listFocusRef}
    >
      {withSearch && (
        <label className="kit-search">
          <Search aria-hidden="true" />
          <input
            ref={searchRef}
            type="text"
            role="searchbox"
            aria-label={`Search ${label}`}
            aria-controls={listId}
            aria-activedescendant={active >= 0 ? optionId(listId, active) : undefined}
            placeholder={searchPlaceholder ?? `Search ${options.length} options`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onListKey}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      )}
      <OptionList
        id={listId}
        label={label}
        options={shown}
        active={active}
        selected={selected}
        query={withSearch ? query : ""}
        onPick={(o) => pick(o as KitOption<V>)}
        onHover={setActive}
        focusRef={withSearch ? undefined : listFocusRef}
        onKeyDown={withSearch ? undefined : onListKey}
      >
        {shown.length === 0 && (
          <div className="kit-empty">
            <b>{emptyText}</b>
          </div>
        )}
      </OptionList>
      {!phone && options.length > 4 && <KeyHints />}
    </Floating>
  );
}
