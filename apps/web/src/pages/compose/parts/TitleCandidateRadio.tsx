import { cn } from "../../../lib/cn";

export interface TitleCandidateRadioProps {
  candidates: string[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  className?: string;
}

export function TitleCandidateRadio({ candidates, selectedIndex, onSelect, className }: TitleCandidateRadioProps) {
  return (
    <div className={cn("space-y-2", className)}>
      {candidates.map((title, i) => {
        const isSelected = i === selectedIndex;
        return (
          <label
            key={i}
            className={cn(
              "flex items-start gap-2.5 p-2.5 rounded-[var(--r-md)] cursor-pointer transition-colors border",
              isSelected
                ? "border-[var(--brand-500)] bg-[var(--brand-50)]"
                : "border-transparent hover:bg-[var(--ink-50)]"
            )}
          >
            {/* Radio circle */}
            <span
              className={cn(
                "mt-0.5 h-4 w-4 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors",
                isSelected
                  ? "border-[var(--brand-500)]"
                  : "border-[var(--ink-300)]"
              )}
            >
              {isSelected && (
                <span className="h-2 w-2 rounded-full bg-[var(--brand-500)]" />
              )}
            </span>

            {/* Hidden radio input */}
            <input
              type="radio"
              name="title-candidate"
              checked={isSelected}
              onChange={() => onSelect(i)}
              className="sr-only"
            />

            {/* Title text */}
            <span className={cn(
              "text-[var(--fs-sm)] leading-relaxed",
              isSelected ? "text-[var(--ink-950)] font-medium" : "text-[var(--ink-600)]"
            )}>
              {title}
            </span>
          </label>
        );
      })}
    </div>
  );
}
