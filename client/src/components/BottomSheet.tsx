import React, { useEffect, useRef, useState } from "react";

interface BottomSheetProps {
  onClose: () => void;
  children: React.ReactNode;
}

// Dismiss gestures: drag the grab zone down past this distance, or flick it,
// or tap it; backdrop click and Escape also close.
const CLOSE_THRESHOLD = 96;
const FLICK_VELOCITY = 0.55; // px per ms
const TAP_SLOP = 6;

// Mobile-style bottom sheet: rises from the very bottom edge of the screen,
// dimmed backdrop, draggable grab-handle bar (swipe down to dismiss).
export const BottomSheet: React.FC<BottomSheetProps> = ({ onClose, children }) => {
  const [dragY, setDragY] = useState<number | null>(null);
  const [closing, setClosing] = useState(false);
  const drag = useRef({ startY: 0, startT: 0, pointerId: -1, moved: false });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const dismiss = () => {
    if (closing) return;
    setClosing(true);
    setTimeout(onClose, 240);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (closing) return;
    drag.current = { startY: e.clientY, startT: performance.now(), pointerId: e.pointerId, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragY(0);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current.pointerId !== e.pointerId || dragY === null) return;
    const dy = Math.max(0, e.clientY - drag.current.startY);
    if (Math.abs(e.clientY - drag.current.startY) > TAP_SLOP) drag.current.moved = true;
    setDragY(dy);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current.pointerId !== e.pointerId || dragY === null) return;
    const dy = Math.max(0, e.clientY - drag.current.startY);
    const dt = Math.max(1, performance.now() - drag.current.startT);
    drag.current.pointerId = -1;
    setDragY(null);
    if (dy > CLOSE_THRESHOLD || (dy > 36 && dy / dt > FLICK_VELOCITY)) dismiss();
  };

  const transform = closing
    ? "translateY(105%)"
    : dragY !== null
      ? `translateY(${dragY}px)`
      : undefined;
  const transition = dragY !== null ? "none" : "transform 220ms cubic-bezier(0.32, 0.72, 0.3, 1)";

  return (
    <div className="fixed inset-0 z-[70]">
      {/* Backdrop */}
      <div
        className={`absolute inset-0 bg-black/30 ${closing ? "opacity-0 transition-opacity duration-200" : "animate-backdrop-in"}`}
        onClick={onClose}
      />

      {/* Panel */}
      <div
        className={`absolute inset-x-0 bottom-0 ${dragY === null && !closing ? "animate-panel-up" : ""}`}
        style={{ transform, transition }}
      >
        <div className="mx-auto max-w-3xl bg-white dark:bg-zinc-900 rounded-t-2xl border border-b-0 border-zinc-200 dark:border-zinc-700 shadow-2xl overflow-hidden">
          {/* Grab zone — swipe down / tap to dismiss */}
          <div
            role="button"
            aria-label="Close sheet"
            title="Drag down to close"
            className="flex justify-center pt-3 pb-2 cursor-grab active:cursor-grabbing select-none"
            style={{ touchAction: "none" }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={() => {
              drag.current.pointerId = -1;
              setDragY(null);
            }}
            onClick={() => {
              if (!drag.current.moved) onClose();
              drag.current.moved = false;
            }}
          >
            <div className={`w-10 h-1.5 rounded-full transition-colors ${
              dragY !== null
                ? "bg-zinc-500 dark:bg-zinc-300"
                : "bg-zinc-300 dark:bg-zinc-600 hover:bg-zinc-400 dark:hover:bg-zinc-500"
            }`} />
          </div>
          {children}
        </div>
      </div>
    </div>
  );
};
