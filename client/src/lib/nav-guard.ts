// While connected to a room, the page does not simply go away (4.0).
//
//   reload, closing the tab, typing another address
//       beforeunload — the browser asks with its own words (no page may set
//       the text any more), and only after the user has interacted
//   the Back / Forward button
//       a history entry of our own on top: going back lands on it, and the
//       page puts it back and says "Please disconnect from the room first"
//   F5, Ctrl/Cmd+R, Alt+←/→, Cmd+[ / Cmd+]
//       caught before the browser acts, with the same message
//
// Disconnecting removes all of it (and the extra history entry). A reload
// while connected keeps the entry (history outlives the document): the
// next guard adopts it instead of stacking another one, and only an entry
// this document pushed itself is ever popped — popping one of an earlier
// document would load the page again.

export type BlockedBy = "back" | "reload";

/** The guard in place, if any (one at a time). */
let active: { release: () => Promise<void> } | null = null;
/** Markers of the entries this document pushed. */
const pushedHere = new Set<string>();

const currentMarker = (): string => {
  const state = window.history.state as { m5guard?: unknown } | null;
  return typeof state?.m5guard === "string" ? state.m5guard : "";
};

/**
 * Takes the guard down and its history entry off — and waits until the
 * browser has done so. Leaving on purpose (Clear & Quit) calls this before
 * replacing the page, so no entry of the chat is left to go back to.
 */
export function releaseNavigationGuard(): Promise<void> {
  return active ? active.release() : Promise.resolve();
}

export function installNavigationGuard(onBlocked: (by: BlockedBy) => void): () => void {
  void active?.release();
  // Our entry from before a reload is still on top: use it again.
  const adopted = currentMarker();
  const marker = adopted || `m5guard-${Date.now().toString(36)}`;

  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    event.preventDefault();
    // Older browsers want a (ignored) string to show their prompt.
    event.returnValue = "";
    return "";
  };

  const onPop = () => {
    // Back (or forward) left our entry: put it back and explain.
    window.history.pushState({ m5guard: marker }, "", window.location.href);
    pushedHere.add(marker);
    onBlocked("back");
  };

  const onKey = (event: KeyboardEvent) => {
    const key = event.key;
    const mod = event.ctrlKey || event.metaKey;
    const reload = key === "F5" || (mod && !event.altKey && (key === "r" || key === "R"));
    const history = (event.altKey && !mod && (key === "ArrowLeft" || key === "ArrowRight"))
      || (event.metaKey && (key === "[" || key === "]"))
      || key === "BrowserBack" || key === "BrowserForward";
    if (!reload && !history) return;
    event.preventDefault();
    event.stopPropagation();
    onBlocked(reload ? "reload" : "back");
  };

  if (!adopted) {
    window.history.pushState({ m5guard: marker }, "", window.location.href);
    pushedHere.add(marker);
  }
  window.addEventListener("beforeunload", onBeforeUnload);
  window.addEventListener("popstate", onPop);
  window.addEventListener("keydown", onKey, true);

  let released: Promise<void> | null = null;
  const release = (): Promise<void> => {
    if (released) return released;
    window.removeEventListener("beforeunload", onBeforeUnload);
    window.removeEventListener("popstate", onPop);
    window.removeEventListener("keydown", onKey, true);
    if (active?.release === release) active = null;
    // Take our entry off the history again (same document, same address) —
    // an adopted one only loses its mark.
    if (currentMarker() === marker && !pushedHere.has(marker)) {
      window.history.replaceState(null, "", window.location.href);
      released = Promise.resolve();
      return released;
    }
    released = currentMarker() === marker
      ? new Promise<void>((resolve) => {
          const done = () => { window.clearTimeout(timer); window.removeEventListener("popstate", done); resolve(); };
          const timer = window.setTimeout(done, 1000);
          window.addEventListener("popstate", done);
          window.history.back();
        })
      : Promise.resolve();
    return released;
  };
  active = { release };
  return () => { void release(); };
}
