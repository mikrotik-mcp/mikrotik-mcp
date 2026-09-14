"use client";

import type { ComponentProps } from "react";
import {
  Select as BeuiSelect,
  SelectTrigger as BeuiSelectTrigger,
  SelectValue,
  SelectContent as BeuiSelectContent,
  SelectItem,
} from "../beui/registry/components/motion/select";
import { cn } from "@/lib/utils";

function Select(props: ComponentProps<typeof BeuiSelect>) {
  return <BeuiSelect {...props} />;
}

function SelectTrigger({
  className,
  size = "default",
  ...props
}: ComponentProps<typeof BeuiSelectTrigger> & { size?: "sm" | "default" }) {
  return (
    <BeuiSelectTrigger
      {...props}
      data-slot="select-trigger"
      data-size={size}
      className={cn("min-w-0 shadow-xs", size === "sm" ? "h-8" : "h-9", className)}
    />
  );
}

function SelectContent({
  position: _position,
  align: _align,
  ...props
}: ComponentProps<typeof BeuiSelectContent> & {
  position?: "popper" | "item-aligned";
  align?: "start" | "center" | "end";
}) {
  return <BeuiSelectContent {...props} />;
}

export { Select, SelectTrigger, SelectValue, SelectContent, SelectItem };
