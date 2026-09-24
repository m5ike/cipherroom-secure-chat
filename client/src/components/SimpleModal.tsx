// The dialog every chat panel opens in: Escape and a click outside close
// it; content loaded on demand waits behind Suspense, and a crash inside
// stays inside (ErrorBoundary).
//
// Dialogs can open on top of each other (Room › My connections › Share a
// connection): each one knows its place in the stack, Escape closes only the
// one on top, and the ones above the first dim the screen more lightly.
// Every dialog renders into <body>: a parent dialog's glass (backdrop-filter)
// would otherwise become the containing block of a fixed child.
//
// 4.13: the window is a layout ("window", lib/layouts/windows.ts) the
// operator can redesign; the stack, Escape and the portal stay here.

import { Suspense, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ErrorBoundary } from "./ErrorBoundary";
import { renderLayout } from "./LayoutView";
import { useLayout } from "./LayoutProvider";

const stack: number[] = [];
let nextId = 1;

export function SimpleModal({ title, onClose, children, header, testId, className }: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  /** Replaces the title in the header (e.g. tabs); `title` stays the dialog's accessible name. */
  header?: ReactNode;
  testId?: string;
  className?: string;
}) {
  // A modal dialog must be dismissable from the keyboard.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [id] = useState(() => nextId++);
  // Was another dialog already open underneath? Known once this one joins the
  // stack — before the first paint, and in tree order when several mount at once.
  const [stacked, setStacked] = useState(false);
  useLayoutEffect(() => {
    stack.push(id);
    setStacked(stack.indexOf(id) > 0);
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || stack[stack.length - 1] !== id) return;
      // One dialog per key press, even when several listen.
      event.stopImmediatePropagation();
      onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const at = stack.indexOf(id);
      if (at >= 0) stack.splice(at, 1);
    };
  }, [id]);
  const { tree, blocks } = useLayout("window");
  return createPortal(
    renderLayout(tree, {
      blocks,
      data: { title, testId, stacked, className: className ?? "", customHeader: header !== undefined && header !== null },
      actions: {
        backdrop: (event) => { const e = event as MouseEvent; if (e.target === e.currentTarget) onClose(); },
        stop: (event) => (event as MouseEvent).stopPropagation(),
        close: () => onClose(),
      },
      slots: {
        header: () => header,
        content: () => (
          <ErrorBoundary scope="panel">
            <Suspense fallback={<div className="p-6 text-center text-sm text-muted-foreground" aria-busy="true">…</div>}>{children}</Suspense>
          </ErrorBoundary>
        ),
      },
    }),
    document.body,
  );
}
