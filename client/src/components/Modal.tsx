// Generic dialog primitive used by every settings/admin panel. Renders
// either a centered card (`side="center"`) or a slide-out drawer
// (`side="right"`). Closes on Escape and on backdrop click.
//
// On phones (html[data-form="phone"], see lib/device.ts) mobile.css turns
// the centred card into a bottom sheet sized to the visual viewport, so the
// on-screen keyboard never hides a field and the sheet clears the notch and
// the home indicator.

import { ReactNode, useEffect, type MouseEvent } from "react";
import { renderLayout } from "./LayoutView";
import { useLayout } from "./LayoutProvider";

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

  const { tree, blocks } = useLayout("window.large");
  if (!open) return null;

  // 4.13: the window is a layout ("window.large", lib/layouts/windows.ts).
  return renderLayout(tree, {
    blocks,
    data: { title, testId, side, width: WIDTH[size], closeLabel },
    actions: {
      backdrop: (event) => { const e = event as MouseEvent; if (e.target === e.currentTarget) onClose(); },
      stop: (event) => (event as MouseEvent).stopPropagation(),
      close: () => onClose(),
    },
    slots: { headerExtra: () => headerExtra, content: () => children },
  });
}
