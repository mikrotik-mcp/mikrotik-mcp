import * as React from "react";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import { Button as BeuiButton } from "../beui/registry/components/motion/button";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-full text-[13px] font-[510] whitespace-nowrap transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-40 disabled:saturate-0 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // Glass: the everyday action.
        default:
          "bg-secondary text-secondary-foreground shadow-[var(--shadow-button)] hover:bg-overlay-08",
        // Danger fill with dark ink: white on the pink fails contrast.
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline:
          "border border-input bg-transparent text-foreground hover:bg-accent hover:text-accent-foreground",
        // Solid inverse: one decisive action per view.
        secondary: "bg-primary text-primary-foreground hover:bg-primary/90",
        ghost: "font-normal text-muted-foreground hover:bg-accent hover:text-foreground",
        link: "text-brand underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 px-3 has-[>svg]:px-2.5",
        xs: "h-6 gap-1 px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 px-[14px] has-[>svg]:px-3",
        icon: "size-9 rounded-sm",
        "icon-xs": "size-6 rounded-sm [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8 rounded-sm",
        "icon-lg": "size-10 rounded-sm",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: Omit<
  React.ComponentProps<"button">,
  "onDrag" | "onDragStart" | "onDragEnd" | "onAnimationStart"
> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  if (asChild)
    return <Slot.Root className={cn(buttonVariants({ variant, size }), className)} {...props} />;

  return (
    <BeuiButton
      ripple
      pressScale={0.96}
      variant={
        variant === "default"
          ? "primary"
          : variant === "outline" || variant === "secondary"
            ? variant
            : "ghost"
      }
      size={
        size === "lg"
          ? "lg"
          : size === "sm" || size === "xs"
            ? "sm"
            : size?.startsWith("icon")
              ? "icon"
              : "md"
      }
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Button, buttonVariants };
