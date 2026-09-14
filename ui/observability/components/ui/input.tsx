import type { ComponentProps } from "react";
import { Input as BeuiInput } from "../beui/registry/components/motion/input";
import { cn } from "@/lib/utils";

/** BeUI field, preserving native change events and refs for existing forms. */
export function Input({
  className,
  value,
  defaultValue,
  onChange,
  ...props
}: ComponentProps<"input">) {
  return (
    <BeuiInput
      {...props}
      data-slot="input"
      value={value == null ? undefined : String(value)}
      defaultValue={defaultValue == null ? undefined : String(defaultValue)}
      onInputChange={onChange}
      className="min-w-0"
      classNames={{ field: "h-9 rounded-xl", input: cn("text-[13px] leading-5", className) }}
    />
  );
}
