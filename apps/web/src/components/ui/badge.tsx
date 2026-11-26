import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import * as React from "react";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs leading-4 font-medium whitespace-nowrap transition-colors select-none",
  {
    variants: {
      variant: {
        default: "border-transparent bg-accent-soft px-2 text-accent-foreground",
        secondary: "border-border bg-surface text-foreground",
        accent: "border-primary/30 bg-accent-soft text-accent-foreground",
        outline: "border-border bg-background text-muted-foreground",
        destructive: "border-destructive/35 bg-destructive/15 text-destructive-text",
        live: "border-primary/40 bg-accent-soft font-semibold text-accent-foreground",
      },
    },
    defaultVariants: {
      variant: "secondary",
    },
  },
);

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
