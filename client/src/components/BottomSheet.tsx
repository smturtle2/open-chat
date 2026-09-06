import React, { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

interface BottomSheetProps {
  title?: string;
  description?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  compact?: boolean;
  fullScreen?: boolean;
  hideHeader?: boolean;
  returnFocus?: HTMLElement | null;
}

/** Native modal behavior: inert background, focus containment and Escape. */
export const BottomSheet: React.FC<BottomSheetProps> = ({
  title = "상세 보기", description, onClose, children, footer, compact, fullScreen, hideHeader, returnFocus,
}) => {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const titleId = useId();
  const descriptionId = useId();
  const dragStart = useRef<number | null>(null);
  const triggerRef = useRef(returnFocus || document.activeElement as HTMLElement | null);

  useEffect(() => {
    const dialog = ref.current!;
    const trigger = triggerRef.current;
    dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => {
      dialog.close();
      if (trigger?.isConnected && !trigger.closest("[inert]")) trigger.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(
    <dialog
      ref={ref}
      className={`ui-dialog ${fullScreen ? "ui-dialog-fullscreen" : ""}`}
      aria-labelledby={hideHeader ? undefined : titleId}
      aria-label={hideHeader ? title : undefined}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(e) => { e.preventDefault(); closeRef.current(); }}
      onKeyDown={(e) => {
        if (e.key !== "Tab" || e.defaultPrevented) return;
        const controls = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button, a[href], input, textarea, select, iframe, [tabindex]')).filter(el => el.tabIndex >= 0 && !el.matches(":disabled") && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden");
        const first = controls[0], last = controls.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }}
      onClick={(e) => { if (e.target === e.currentTarget) closeRef.current(); }}
    >
      <div className={`ui-dialog-panel ${compact ? "ui-dialog-compact" : ""}`}>
        {!hideHeader && (
          <>
            <button
              type="button"
              className="ui-dialog-handle md:hidden"
              aria-label="창 닫기"
              onClick={onClose}
              onPointerDown={(e) => { dragStart.current = e.clientY; e.currentTarget.setPointerCapture(e.pointerId); }}
              onPointerUp={(e) => { if (dragStart.current !== null && e.clientY - dragStart.current > 70) onClose(); dragStart.current = null; }}
              onPointerCancel={() => { dragStart.current = null; }}
            >
              <span />
            </button>
            <div className="ui-dialog-header">
              <div className="min-w-0 flex-1">
                <h2 id={titleId} className="text-lg font-semibold tracking-tight">{title}</h2>
                {description && <p id={descriptionId} className="mt-1 text-sm text-muted leading-relaxed">{description}</p>}
              </div>
              <button type="button" className="ui-icon-button shrink-0" onClick={onClose} aria-label="창 닫기" title="닫기">
                <X className="size-5" />
              </button>
            </div>
          </>
        )}
        <div data-dialog-scroll className={`ui-dialog-body ${hideHeader ? "h-full" : ""}`}>{children}</div>
        {footer && <div className="ui-dialog-footer">{footer}</div>}
      </div>
    </dialog>,
    document.body,
  );
};
