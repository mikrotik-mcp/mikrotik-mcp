import { useState } from "react";
import type { ComponentProps } from "react";
import { Checkbox as BeuiCheckbox } from "../beui/registry/components/motion/checkbox";
type Checked = boolean | "indeterminate";
export type CheckboxProps = Omit<ComponentProps<"button">, "defaultChecked"> & {
  checked?: Checked;
  defaultChecked?: Checked;
  onCheckedChange?: (checked: Checked) => void;
  required?: boolean;
};
export function Checkbox({
  checked,
  defaultChecked = false,
  onCheckedChange,
  className,
  disabled,
  id,
  ...props
}: CheckboxProps) {
  const [internal, setInternal] = useState<Checked>(defaultChecked);
  const state = checked ?? internal;
  return (
    <BeuiCheckbox
      checked={state === true}
      indeterminate={state === "indeterminate"}
      disabled={disabled}
      id={id}
      aria-label={props["aria-label"]}
      aria-describedby={props["aria-describedby"]}
      className={className}
      controlProps={props}
      onCheckedChange={(next) => {
        if (checked === undefined) setInternal(next);
        onCheckedChange?.(next);
      }}
    />
  );
}
