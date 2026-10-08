import { forwardRef, type ComponentPropsWithoutRef } from "react";
import * as RadixCheckbox from "@radix-ui/react-checkbox";
import { cn } from "../../lib/cn";
import { Check } from "../shared/LucideIcon";

export interface CheckboxProps extends ComponentPropsWithoutRef<typeof RadixCheckbox.Root> {
  label?: string;
}

export const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(
  ({ className, label, ...props }, ref) => (
    <div className="flex items-center gap-2">
      <RadixCheckbox.Root
        ref={ref}
        className={cn(
          "peer h-5 w-5 shrink-0 rounded-[var(--r-sm)] border border-[var(--ink-300)] bg-white transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)]/30",
          "data-[state=checked]:bg-[var(--brand-500)] data-[state=checked]:border-[var(--brand-500)] data-[state=checked]:text-white",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        {...props}
      >
        <RadixCheckbox.Indicator className="flex items-center justify-center">
          <Check className="h-3.5 w-3.5" />
        </RadixCheckbox.Indicator>
      </RadixCheckbox.Root>
      {label && (
        <label className="text-[var(--fs-sm)] text-[var(--ink-700)] leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
          {label}
        </label>
      )}
    </div>
  )
);
Checkbox.displayName = "Checkbox";
