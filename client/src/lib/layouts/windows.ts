// The windows the app opens (4.13): the dialog every chat panel, the Room
// window and the dialogs open in (SimpleModal.tsx), and the larger window of
// the settings panels (Modal.tsx). One design for every window: its shade,
// frame, head, close button and body — the content is a live part.

import { treeBuilder, type LNode } from "../layout-tree";
import type { LayoutContract } from "./contracts";

/** SimpleModal: the dialog of the chat panels, the Room window, the dialogs. */
export function windowTree(): LNode {
  const { n } = treeBuilder("w");
  return n("panel", {
    id: "modal-root", name: "Shade",
    attrs: {
      role: "dialog", "aria-modal": "true", "aria-label": "=$title", "data-testid": "=$testId",
      class: "modal-root fixed inset-0 z-40 flex items-stretch justify-center p-3 sm:p-6 {if $stacked}modal-root--stacked bg-black/25{else}bg-black/45{/if}",
    },
    on: { mousedown: { action: "backdrop" } },
  }, [
    n("panel", {
      id: "modal-shell", name: "Window",
      attrs: { class: "modal-shell modal-shell--center my-auto flex max-h-[92dvh] w-full max-w-xl flex-col{if $className} {$className}{/if}" },
      on: { mousedown: { action: "stop" } },
    }, [
      n("panel", { id: "modal-head", name: "Head", tag: "header", attrs: { class: "modal-head flex items-center justify-between gap-2 border-b border-border px-5 py-3{if $customHeader} modal-head--custom{/if}" } }, [
        n("slot", { id: "header", name: "Own head (tabs…)", slot: "header", if: "$customHeader" }),
        n("heading", { id: "title", name: "Title", tag: "h2", if: "!$customHeader", attrs: { class: "text-base font-semibold tracking-tight" }, text: "{$title}" }),
        n("button", {
          id: "modal-close", name: "Close",
          attrs: { type: "button", "aria-label": "Close", class: "modal-close inline-flex h-9 w-9 flex-none items-center justify-center rounded-full hover:bg-accent" },
          on: { click: { action: "close" } }, text: "×",
        }),
      ]),
      n("panel", { id: "modal-body", name: "Body", attrs: { class: "modal-body flex-1 overflow-y-auto px-5 py-4" } }, [
        n("slot", { id: "content", name: "Content", slot: "content" }),
      ]),
    ]),
  ]);
}

/** Modal: the larger window of the settings panels (centred, or a drawer on the right). */
export function largeWindowTree(): LNode {
  const { n, icon } = treeBuilder("lw");
  return n("panel", {
    id: "modal-root", name: "Shade",
    attrs: { role: "dialog", "aria-modal": "true", "aria-label": "=$title", "data-testid": "=$testId", class: "modal-root fixed inset-0 z-40 flex items-stretch justify-center bg-black/45 p-3 sm:p-6" },
    on: { mousedown: { action: "backdrop" } },
  }, [
    n("panel", {
      id: "modal-shell", name: "Window",
      attrs: { class: "{if $side == 'right'}modal-shell modal-shell--drawer ml-auto flex h-full w-full max-w-xl flex-col{else}modal-shell modal-shell--center my-auto flex max-h-[92dvh] w-full {$width} flex-col{/if}" },
      on: { mousedown: { action: "stop" } },
    }, [
      n("panel", { id: "modal-head", name: "Head", tag: "header", attrs: { class: "modal-head flex items-center justify-between gap-2 border-b border-border px-5 py-3" } }, [
        n("heading", { id: "title", name: "Title", tag: "h2", attrs: { class: "min-w-0 truncate text-base font-semibold tracking-tight" }, text: "{$title}" }),
        n("panel", { id: "head-tools", name: "Head tools", attrs: { class: "flex flex-none items-center gap-2" } }, [
          n("slot", { id: "header-extra", name: "Extra controls", slot: "headerExtra" }),
          n("button", {
            id: "modal-close", name: "Close",
            attrs: { type: "button", "aria-label": "=$closeLabel", class: "modal-close inline-flex h-9 w-9 items-center justify-center rounded-full hover:bg-accent" },
            on: { click: { action: "close" } },
          }, [icon("x", "h-4 w-4", {}, { id: "close-icon" })]),
        ]),
      ]),
      n("panel", { id: "modal-body", name: "Body", attrs: { class: "modal-body flex-1 overflow-y-auto px-5 py-4" } }, [
        n("slot", { id: "content", name: "Content", slot: "content" }),
      ]),
    ]),
  ]);
}

/* ------------------------------------------------------------ contracts */

const WINDOW_ACTIONS: LayoutContract["actions"] = [
  { name: "backdrop", description: "A press on the shade outside the window closes it (the press on the shade itself only).", event: "mousedown" },
  { name: "stop", description: "Keeps a press inside the window from reaching the shade.", event: "mousedown" },
  { name: "close", description: "Close the window." },
];

export const WINDOW_CONTRACTS: Record<"window" | "window.large", LayoutContract> = {
  window: {
    description: "The window a chat panel, the Room window and every dialog open in (on top of each other when needed).",
    vars: [
      { path: "$title", type: "text", description: "The window's title (also its accessible name)." },
      { path: "$testId", type: "text", description: "The window's test id." },
      { path: "$stacked", type: "yes/no", description: "Opened over another window (a lighter shade)." },
      { path: "$className", type: "text", description: "Extra classes the panel asks for." },
      { path: "$customHeader", type: "yes/no", description: "The panel brings its own head (the Room window's tabs)." },
    ],
    actions: WINDOW_ACTIONS,
    slots: [
      { name: "header", description: "The panel's own head (the Room window: its tabs)." },
      { name: "content", description: "The panel itself." },
    ],
    refs: [],
  },
  "window.large": {
    description: "The larger window of the settings panels: centred, or a drawer on the right.",
    vars: [
      { path: "$title", type: "text", description: "The window's title." },
      { path: "$testId", type: "text", description: "The window's test id." },
      { path: "$side", type: "text", description: "center or right (a drawer)." },
      { path: "$width", type: "text", description: "The width class of its size (max-w-2xl, max-w-4xl, max-w-6xl)." },
      { path: "$closeLabel", type: "text", description: "The close button's label." },
    ],
    actions: WINDOW_ACTIONS,
    slots: [
      { name: "headerExtra", description: "Controls the panel adds to the head." },
      { name: "content", description: "The panel itself." },
    ],
    refs: [],
  },
};

export const WINDOW_VARIANTS: Record<"window" | "window.large", ReadonlyArray<{ id: string; label: string }>> = {
  window: [{ id: "plain", label: "A panel" }, { id: "stacked", label: "Over another window" }, { id: "tabs", label: "With its own head (Room)" }],
  "window.large": [{ id: "center", label: "Centred" }, { id: "right", label: "A drawer on the right" }],
};
