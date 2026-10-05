import { useId, useState } from "react";
import { format, isValid, startOfDay } from "date-fns";
import { CalendarIcon, Clock3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

/** Shadcn Calendar + Popover composition. Values stay in local time, never coerced to UTC.
 * min/max constrain calendar days; showTime=false is for date-only APIs.
 */
export function DateTimePicker({
  value,
  onChange,
  showTime = true,
  min,
  max,
  disabled,
  placeholder,
  id,
  className,
  "aria-label": label,
  "aria-invalid": invalid,
}: {
  value?: Date;
  onChange: (value: Date | undefined) => void;
  showTime?: boolean;
  min?: Date;
  max?: Date;
  disabled?: boolean;
  placeholder?: string;
  id?: string;
  className?: string;
  "aria-label": string;
  "aria-invalid"?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const timeId = useId();
  const selected = value && isValid(value) ? value : undefined;
  function select(date: Date | undefined) {
    if (date) {
      date = startOfDay(date);
      if ((min && date < startOfDay(min)) || (max && date > startOfDay(max))) return;
      if (showTime && selected)
        date.setHours(selected.getHours(), selected.getMinutes(), selected.getSeconds());
    }
    onChange(date);
    if (!showTime) setOpen(false);
  }
  return (
    <Popover open={open && !disabled} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          id={id}
          variant="outline"
          disabled={disabled}
          aria-label={label}
          aria-invalid={invalid}
          data-slot="date-time-picker"
          data-empty={!selected}
          className={cn(
            "h-9 w-full min-w-0 justify-start gap-2 px-3 text-left font-normal data-[empty=true]:text-muted-foreground",
            className,
          )}
        >
          <CalendarIcon className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs">
            {selected
              ? format(selected, showTime ? "MMM d, yyyy · HH:mm" : "MMM d, yyyy")
              : (placeholder ?? (showTime ? "Pick date & time" : "Pick a date"))}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-auto max-w-[calc(100vw-2rem)] rounded-xl p-0"
        aria-label={`${label} picker`}
      >
        <ScrollArea viewportProps={{ style: { maxHeight: "min(480px, calc(100dvh - 2rem))" } }}>
          <Calendar
            mode="single"
            selected={selected}
            defaultMonth={selected ?? min ?? max}
            captionLayout="dropdown"
            autoFocus
            disabled={[
              ...(disabled ? [true] : []),
              ...(min ? [{ before: startOfDay(min) }] : []),
              ...(max ? [{ after: startOfDay(max) }] : []),
            ]}
            onSelect={select}
          />
          {showTime && (
            <div className="grid gap-2 border-t p-3">
              <Label htmlFor={timeId} className="text-xs">
                <Clock3 className="size-3.5" />
                Time · local
              </Label>
              <Input
                id={timeId}
                type="time"
                step={60}
                disabled={!selected}
                value={selected ? format(selected, "HH:mm") : ""}
                className="h-9 font-mono [color-scheme:light_dark]"
                onChange={(event) => {
                  if (!selected || !/^([01]\d|2[0-3]):[0-5]\d$/.test(event.target.value)) return;
                  const [hours, minutes] = event.target.value.split(":").map(Number);
                  const next = new Date(selected);
                  next.setHours(hours, minutes, 0, 0);
                  onChange(next);
                }}
              />
            </div>
          )}
          <div className="flex items-center justify-between gap-3 border-t p-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!selected}
              onClick={() => {
                onChange(undefined);
                setOpen(false);
              }}
            >
              Clear
            </Button>
            <Button type="button" size="sm" onClick={() => setOpen(false)}>
              Done
            </Button>
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
