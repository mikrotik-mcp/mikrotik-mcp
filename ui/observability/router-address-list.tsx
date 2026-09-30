import { Star } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

/** Draft addresses, not connection status: Primary never follows the active fallback. */
export function RouterAddressList({
  name,
  hosts,
  primary,
  port,
}: {
  name: string;
  hosts: string[];
  primary: string;
  port: string;
}) {
  if (!hosts.length) return <p className="text-muted-foreground">No addresses configured</p>;
  return (
    <ScrollArea
      className="max-h-40 min-w-0"
      viewportProps={{ className: "max-h-40 [&>div]:!block", "aria-label": `${name} addresses` }}
    >
      <ul aria-label={`${name} management addresses`} className="grid gap-1.5 pr-2">
        {hosts.map((host) => {
          const isPrimary = host === primary;
          const address = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
          return (
            <li
              key={host}
              data-primary={isPrimary}
              className={cn(
                "flex flex-wrap items-center justify-between gap-x-2 gap-y-1 rounded-md border px-2 py-1.5",
                isPrimary ? "border-primary/30 bg-primary/5" : "border-border/60",
              )}
            >
              <code dir="ltr" className="min-w-0 text-[11px] break-all">
                {address}:{port}
              </code>
              <small
                className={cn(
                  "inline-flex shrink-0 items-center gap-1 text-[10px]",
                  isPrimary ? "text-primary" : "text-muted-foreground",
                )}
              >
                {isPrimary && <Star size={11} aria-hidden="true" />}
                {isPrimary ? "Primary" : "Fallback"}
              </small>
            </li>
          );
        })}
      </ul>
    </ScrollArea>
  );
}
