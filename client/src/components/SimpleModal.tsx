// The dialog every chat panel opens in: Escape and a click outside close
// it; content loaded on demand waits behind Suspense, and a crash inside
// stays inside (ErrorBoundary).

import { Suspense, useEffect, useRef } from "react";
import { ErrorBoundary } from "./ErrorBoundary";

export function SimpleModal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  // A modal dialog must be dismissable from the keyboard.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") onCloseRef.current(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div role="dialog" aria-modal="true" aria-label={title} className="modal-root fixed inset-0 z-40 flex items-stretch justify-center bg-black/45 p-3 sm:p-6" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal-shell modal-shell--center my-auto flex max-h-[92dvh] w-full max-w-xl flex-col" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-head flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="modal-close inline-flex h-9 w-9 items-center justify-center rounded-full hover:bg-accent">×</button>
        </header>
        <div className="modal-body flex-1 overflow-y-auto px-5 py-4">
          <ErrorBoundary scope="panel">
            <Suspense fallback={<div className="p-6 text-center text-sm text-muted-foreground" aria-busy="true">…</div>}>{children}</Suspense>
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}
