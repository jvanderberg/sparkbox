// Option rows extracted from T3 Code ComposerPendingUserInputPanel.tsx (MIT; LICENSE.txt).
// Civic Spark currently carries one text answer; expose single-question/single-choice rows only.
import { CheckIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
export type QuestionOption = { label: string; description?: string };
export function QuestionOptions({
  options,
  onChoose,
  disabled,
}: {
  options: QuestionOption[];
  onChoose: (value: string) => void;
  disabled: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  function choose(value: string) {
    if (disabled || timer.current) return;
    setSelected(value);
    timer.current = setTimeout(() => {
      timer.current = null;
      onChoose(value);
    }, 200);
  }
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey || disabled) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.matches("input,textarea") || target.isContentEditable)
      )
        return;
      const index = Number(event.key) - 1;
      if (index < 0 || index > 8 || !options[index]) return;
      event.preventDefault();
      choose(options[index].label);
    }
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  });
  return (
    <div className="mt-2 space-y-0.5">
      {options.map((option, index) => (
        <button
          key={option.label}
          type="button"
          disabled={disabled}
          onClick={() => choose(option.label)}
          className={`t3-question-option group flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left outline-none transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-primary/25 ${selected === option.label ? "bg-muted/55 text-foreground" : "bg-transparent text-foreground/85 hover:bg-muted/30"}`}
        >
          <span className="min-w-0 flex-1 flex flex-col gap-0.5">
            <span className="text-sm font-medium">{option.label}</span>
            {option.description && option.description !== option.label && (
              <span className="text-secondary-label text-[11px]">{option.description}</span>
            )}
          </span>
          {selected === option.label ? (
            <CheckIcon className="size-3.5 shrink-0 text-primary" />
          ) : (
            index < 9 && (
              <kbd className="flex size-5 shrink-0 items-center justify-center text-[10px] font-medium text-muted-foreground tabular-nums">
                {index + 1}
              </kbd>
            )
          )}
        </button>
      ))}
    </div>
  );
}
