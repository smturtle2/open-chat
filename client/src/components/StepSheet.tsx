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
    <BottomSheet title="실행 상세" description={`${entries.length}개 단계${live && runningCount > 0 ? ` · ${runningCount}개 진행 중` : ""}`} onClose={onClose}>
      <div data-step-sheet>
        <div className="px-5 pb-6 space-y-3 font-sans">
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
