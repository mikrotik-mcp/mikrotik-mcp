import { useState } from "react";
import type { ComponentProps } from "react";
import { Switch as BeuiSwitch } from "../beui/registry/components/motion/switch";
import { cn } from "@/lib/utils";
export type SwitchProps = Omit<ComponentProps<"button">, "defaultChecked"> & {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  required?: boolean;
  size?: "sm" | "default";
};
export function Switch({
  checked,
  defaultChecked = false,
  onCheckedChange,
  className,
  disabled,
  size = "default",
  ...props
}: SwitchProps) {
  const [internal, setInternal] = useState(defaultChecked);
  return (
    <BeuiSwitch
      checked={checked ?? internal}
      disabled={disabled}
      className="shrink-0"
      controlClassName={cn(
        size === "sm" && "h-5 w-9 px-0.5 [&>div]:size-4 [&>div>div]:size-4",
        className,
      )}
      controlProps={props}
      ariaLabel={props["aria-label"]}
      onCheckedChange={(next) => {
        if (checked === undefined) setInternal(next);
        onCheckedChange?.(next);
      }}
    />
  );
}
