import { forwardRef, type ComponentPropsWithoutRef } from "react";
import * as RadixSlider from "@radix-ui/react-slider";
import { cn } from "../../lib/cn";

export interface SliderProps extends ComponentPropsWithoutRef<typeof RadixSlider.Root> {}

export const Slider = forwardRef<HTMLSpanElement, SliderProps>(
  ({ className, ...props }, ref) => (
    <RadixSlider.Root
      ref={ref}
      className={cn(
        "relative flex w-full touch-none select-none items-center",
        className
      )}
      {...props}
    >
      <RadixSlider.Track className="relative h-2 w-full grow overflow-hidden rounded-[var(--r-full)] bg-[var(--ink-100)]">
        <RadixSlider.Range className="absolute h-full bg-[var(--brand-500)]" />
      </RadixSlider.Track>
      <RadixSlider.Thumb
        className="block h-5 w-5 rounded-[var(--r-full)] bg-white border-2 border-[var(--brand-500)] shadow-[var(--shadow-sm)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-500)]/30 cursor-grab active:cursor-grabbing"
      />
    </RadixSlider.Root>
  )
);
Slider.displayName = "Slider";
