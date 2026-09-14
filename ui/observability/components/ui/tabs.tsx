"use client";
import type { ComponentProps } from "react";
import {
  Tabs as BeuiTabs,
  TabsList as BeuiTabsList,
  TabsTrigger as BeuiTabsTrigger,
  TabsContent as BeuiTabsContent,
} from "../beui/registry/components/motion/tabs";
import { cn } from "@/lib/utils";

function Tabs({ className, ...props }: ComponentProps<typeof BeuiTabs>) {
  return (
    <BeuiTabs
      {...props}
      variant="segment"
      className={cn("flex min-w-0 flex-col gap-2", className)}
    />
  );
}
function TabsList({ className, ...props }: ComponentProps<typeof BeuiTabsList>) {
  return (
    <BeuiTabsList
      {...props}
      className={cn("w-fit max-w-full gap-1 rounded-xl border p-1", className)}
    />
  );
}
function TabsTrigger({ className, ...props }: ComponentProps<typeof BeuiTabsTrigger>) {
  return (
    <BeuiTabsTrigger
      {...props}
      className={cn(
        "gap-1.5 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
        className,
      )}
    />
  );
}
function TabsContent({ className, ...props }: ComponentProps<typeof BeuiTabsContent>) {
  return <BeuiTabsContent {...props} className={cn("flex-1 outline-none", className)} />;
}
export { Tabs, TabsList, TabsTrigger, TabsContent };
