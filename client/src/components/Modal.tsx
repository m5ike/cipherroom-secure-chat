// Generic dialog primitive used by every settings/admin panel. Renders
// either a centered card (`side="center"`) or a slide-out drawer
// (`side="right"`). Closes on Escape and on backdrop click.
//
// On phones (html[data-form="phone"], see lib/device.ts) mobile.css turns
// the centred card into a bottom sheet sized to the visual viewport, so the
// on-screen keyboard never hides a field and the sheet clears the notch and
// the home indicator.

import { ReactNode, useEffect } from "react";
import { X } from "lucide-react";

type ModalProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  side?: "center" | "right";
  size?: "md" | "lg" | "xl";
  closeLabel?: string;
  /** Extra controls rendered in the header, left of the close button. */
  headerExtra?: ReactNode;
  testId?: string;
};

const WIDTH: Record<NonNullable<ModalProps["size"]>, string> = {
  md: "max-w-2xl",
  lg: "max-w-4xl",
  xl: "max-w-6xl",
};

export function Modal({ open, onClose, title, children, side = "center", size = "md", closeLabel = "Close", headerExtra, testId }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid={testId}
      className="modal-root fixed inset-0 z-40 flex items-stretch justify-center bg-black/45 p-3 sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={
          side === "right"
            ? "modal-shell modal-shell--drawer ml-auto flex h-full w-full max-w-xl flex-col"
            : `modal-shell modal-shell--center my-auto flex max-h-[92dvh] w-full ${WIDTH[size]} flex-col`
        }
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-head flex items-center justify-between gap-2 border-b border-border px-5 py-3">
          <h2 className="min-w-0 truncate text-base font-semibold tracking-tight">{title}</h2>
          <div className="flex flex-none items-center gap-2">
            {headerExtra}
            <button
              type="button"
              onClick={onClose}
              aria-label={closeLabel}
              className="modal-close inline-flex h-9 w-9 items-center justify-center rounded-full hover:bg-accent"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>
        <div className="modal-body flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}
