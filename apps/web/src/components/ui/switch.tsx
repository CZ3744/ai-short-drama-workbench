import { forwardRef, type ComponentPropsWithoutRef } from "react";
import * as RadixSwitch from "@radix-ui/react-switch";
import { cn } from "../../lib/cn";

export interface SwitchProps extends ComponentPropsWithoutRef<typeof RadixSwitch.Root> {
  label?: string;
}

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(
  ({ className, label, ...props }, ref) => (
    <div className="flex items-center gap-2">
      <RadixSwitch.Root
        ref={ref}
        className={cn(
          "peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-[var(--r-full)] border-2 border-transparent transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)]/30",
          "data-[state=checked]:bg-[var(--brand-500)] data-[state=unchecked]:bg-[var(--ink-200)]",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        {...props}
      >
        <RadixSwitch.Thumb
          className={cn(
            "pointer-events-none block h-5 w-5 rounded-[var(--r-full)] bg-white shadow-[var(--shadow-sm)] transition-transform",
            "data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0"
          )}
        />
      </RadixSwitch.Root>
      {label && (
        <label className="text-[var(--fs-sm)] text-[var(--ink-700)] peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
          {label}
        </label>
      )}
    </div>
  )
);
Switch.displayName = "Switch";
