// The dialog every chat panel opens in: Escape and a click outside close
// it; content loaded on demand waits behind Suspense, and a crash inside
// stays inside (ErrorBoundary).
//
// Dialogs can open on top of each other (Room › My connections › Share a
// connection): each one knows its place in the stack, Escape closes only the
// one on top, and the ones above the first dim the screen more lightly.
// Every dialog renders into <body>: a parent dialog's glass (backdrop-filter)
// would otherwise become the containing block of a fixed child.

import { Suspense, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ErrorBoundary } from "./ErrorBoundary";

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
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={title} data-testid={testId}
      className={`modal-root fixed inset-0 z-40 flex items-stretch justify-center p-3 sm:p-6 ${stacked ? "modal-root--stacked bg-black/25" : "bg-black/45"}`}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className={`modal-shell modal-shell--center my-auto flex max-h-[92dvh] w-full max-w-xl flex-col${className ? ` ${className}` : ""}`} onMouseDown={(event) => event.stopPropagation()}>
        <header className={`modal-head flex items-center justify-between gap-2 border-b border-border px-5 py-3${header ? " modal-head--custom" : ""}`}>
          {header ?? <h2 className="text-base font-semibold tracking-tight">{title}</h2>}
          <button type="button" onClick={onClose} aria-label="Close" className="modal-close inline-flex h-9 w-9 flex-none items-center justify-center rounded-full hover:bg-accent">×</button>
        </header>
        <div className="modal-body flex-1 overflow-y-auto px-5 py-4">
          <ErrorBoundary scope="panel">
            <Suspense fallback={<div className="p-6 text-center text-sm text-muted-foreground" aria-busy="true">…</div>}>{children}</Suspense>
          </ErrorBoundary>
        </div>
      </div>
    </div>,
    document.body,
  );
}
