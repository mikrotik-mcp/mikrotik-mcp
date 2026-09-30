import { useId, useRef, useState } from "react";
import { Plus, Tag, X } from "lucide-react";
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@/components/beui/registry/components/motion/combobox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

/** Shadcn-style chips composed with the dashboard's keyboard-accessible combobox. */
export function TagsInput({
  value,
  suggestions,
  onValueChange,
  disabled = false,
}: {
  value: string[];
  suggestions: string[];
  onValueChange: (value: string[]) => void;
  disabled?: boolean;
}) {
  const hintId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const term = query.trim();
  const available = [...new Set(suggestions.map((tag) => tag.trim()).filter(Boolean))]
    .filter((tag) => !value.includes(tag) && tag.toLowerCase().includes(term.toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
  const create = !!term && !value.includes(term) && !available.includes(term);
  const add = (tag: string) => {
    if (disabled) return;
    const next = tag.trim();
    if (next && !value.includes(next)) onValueChange([...value, next]);
    setQuery("");
  };
  return (
    <div className="grid min-w-0 gap-2" data-slot="tags-input">
      <span className="text-sm font-medium">Tags</span>
      <Combobox
        value=""
        query={query}
        onQueryChange={setQuery}
        open={open}
        onOpenChange={setOpen}
        onValueChange={add}
        disabled={disabled}
      >
        <ComboboxTrigger className="h-auto min-h-11 min-w-0 py-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {value.map((tag) => (
              <Badge
                key={tag}
                asChild
                variant="secondary"
                className="max-w-full gap-1 rounded-md ps-2 pe-0.5 py-0.5"
              >
                <span>
                  <Tag aria-hidden className="shrink-0" />
                  <span className="min-w-0 whitespace-normal [overflow-wrap:anywhere]">{tag}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="size-6 rounded-sm"
                    aria-label={`Remove tag ${tag}`}
                    disabled={disabled}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => {
                      onValueChange(value.filter((item) => item !== tag));
                      input.current?.focus();
                    }}
                  >
                    <X aria-hidden />
                  </Button>
                </span>
              </Badge>
            ))}
            <ComboboxInput
              ref={input}
              aria-label="Tags"
              aria-describedby={hintId}
              placeholder="Find or create a tag…"
              wrapperClassName="min-w-32 basis-40 [&>svg]:hidden"
              className="h-8"
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) {
                  event.preventDefault();
                  return;
                }
                if (event.key === "Escape" && open) {
                  event.preventDefault();
                  event.stopPropagation();
                  setOpen(false);
                  return;
                }
                if (event.key === ",") {
                  event.preventDefault();
                  add(query);
                } else if (event.key === "Backspace" && !query && value.length) {
                  event.preventDefault();
                  onValueChange(value.slice(0, -1));
                }
              }}
            />
          </div>
        </ComboboxTrigger>
        <ComboboxContent>
          <ScrollArea
            style={{
              height: `min(${Math.min(240, Math.max(1, available.length + Number(create)) * 40 + 40)}px, var(--combobox-available-height))`,
            }}
            viewportProps={{ className: "[&>div]:!block", "aria-label": "Tag suggestions" }}
          >
            <div className="px-3 pt-3 pb-1 text-[0.65rem] font-medium uppercase tracking-widest text-muted-foreground">
              Tags across your devices
            </div>
            <ComboboxList ariaLabel="Available tags" className="max-h-none overflow-visible">
              {available.map((tag) => (
                <ComboboxItem key={tag} value={tag} disabled={disabled}>
                  <span className="flex min-w-0 items-center gap-2">
                    <Tag aria-hidden className="size-3.5 shrink-0 text-primary" />
                    <span className="min-w-0 [overflow-wrap:anywhere]">{tag}</span>
                  </span>
                </ComboboxItem>
              ))}
              {create && (
                <ComboboxItem value={term} disabled={disabled}>
                  <span className="flex min-w-0 items-center gap-2 text-primary">
                    <Plus aria-hidden className="size-3.5 shrink-0" />
                    <span className="min-w-0 [overflow-wrap:anywhere]">Create “{term}”</span>
                  </span>
                </ComboboxItem>
              )}
              {!available.length && !create && (
                <p role="status" className="px-2 py-3 text-sm text-muted-foreground">
                  {term ? "This tag is already selected." : "Type to create a new tag."}
                </p>
              )}
            </ComboboxList>
          </ScrollArea>
        </ComboboxContent>
      </Combobox>
      <p id={hintId} className="text-xs text-muted-foreground">
        Choose an existing tag or type a new one. Enter or comma to add.
      </p>
    </div>
  );
}
