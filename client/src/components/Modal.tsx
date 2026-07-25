// Generic dialog primitive used by every settings/admin panel. Renders
// either a centered card (`side="center"`) or a slide-out drawer
// (`side="right"`). Closes on Escape and on backdrop click.

import { ReactNode, useEffect } from "react";
import { X } from "lucide-react";

type ModalProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  side?: "center" | "right";
  closeLabel?: string;
};

export function Modal({ open, onClose, title, children, side = "center", closeLabel = "Close" }: ModalProps) {
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
      className="fixed inset-0 z-40 flex items-stretch justify-center bg-black/45 p-3 sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={
          side === "right"
            ? "ml-auto flex h-full w-full max-w-xl flex-col modal-shell"
            : "my-auto flex max-h-[92dvh] w-full max-w-2xl flex-col modal-shell"
        }
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full hover:bg-accent"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}
