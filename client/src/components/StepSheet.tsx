import React from "react";
import { StepEntry, StepListItem } from "./Steps";
import { BottomSheet } from "./BottomSheet";

interface StepSheetProps {
  entries: StepEntry[];
  live?: boolean;
  sessionId?: string;
  onClose: () => void;
}

// Bottom sheet with the details of a steps group (thought text + tool
// args/observations). Opened by clicking an inline "N steps" toggle in the
// chat; live groups stream into it.
export const StepSheet: React.FC<StepSheetProps> = ({ entries, live, sessionId, onClose }) => {
  const runningCount = entries.filter((e) => e.running || e.streaming).length;

  return (
    <BottomSheet onClose={onClose}>
      <div data-step-sheet>
        <div className="flex items-center gap-2 pl-4 pr-2 pb-1.5 select-none">
          {live && runningCount > 0 && (
            <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 dark:bg-zinc-500 animate-pulse flex-shrink-0" />
          )}
          <span className="flex-1 min-w-0 text-xs font-mono text-[12px] text-zinc-500 dark:text-zinc-400 truncate py-1">
            {entries.length} step{entries.length > 1 ? "s" : ""}
          </span>
        </div>

        <div className="px-4 pb-5 pt-1 max-h-[60dvh] overflow-y-auto border-t border-zinc-100 dark:border-zinc-800 space-y-3 font-sans text-xs">
          {entries.map((e, i) => (
            <StepListItem
              key={e.item.kind === "tool" ? e.item.id : `think_${i}`}
              entry={e}
              idx={i}
              sessionId={sessionId}
            />
          ))}
        </div>
      </div>
    </BottomSheet>
  );
};
