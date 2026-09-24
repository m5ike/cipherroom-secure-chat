// The AI assistant's window (4.14): why it cannot be used yet (off, no model,
// sign in, no limit set), the model and how much it reasons, the
// conversation as it is written (reasoning, sources, errors, the answer as a
// live part that draws Markdown), inserting or copying the last answer, and
// the prompt. Drawn by AiPanel.tsx, which talks to the server.

import { treeBuilder, type LNode } from "../layout-tree";
import type { LayoutContract } from "./contracts";

export function aiTree(): LNode {
  const { n, text, icon } = treeBuilder("ai");
  const chip = (id: string, iconName: string, label: string, action: string, extra: Record<string, string> = {}) =>
    n("button", { id, attrs: { type: "button", class: "ai-chip", "data-testid": id, ...extra }, on: { click: { action } } }, [icon(iconName, "h-3.5 w-3.5", { "aria-hidden": "true" }, { id: `${id}-icon` }), text(` ${label}`, { id: `${id}-text` })]);
  return n("group", { id: "ai-panel", name: "AI assistant" }, [
    n("panel", { id: "ai-state", name: "Not yet", if: "$state !== 'ready'", attrs: { class: "space-y-3", "data-testid": "ai-state", "data-state": "{$state}" } }, [
      n("paragraph", { id: "ai-state-text", attrs: { class: "rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200" }, text: "{=('ai.state.' ~ $state)|t}" }),
      n("paragraph", { id: "ai-state-hint", if: "$state !== 'sign-in'", attrs: { class: "text-xs text-muted-foreground" }, text: "{_'ai.state.hint'}" }),
      n("button", { id: "ai-sign-in", if: "$state === 'sign-in'", attrs: { type: "button", class: "acc-btn acc-btn--primary", "data-testid": "ai-sign-in" }, on: { click: { action: "signIn" } }, text: "{_'id.need.open'}" }),
    ]),
    n("group", { id: "ai-ready", name: "The assistant", if: "$state === 'ready'" }, [
      n("panel", { id: "ai-bar", name: "Model", attrs: { class: "ai-bar" } }, [
        icon("sparkles", "h-4 w-4 shrink-0 text-primary", { "aria-hidden": "true" }, { id: "ai-bar-icon" }),
        n("select", { id: "ai-model", attrs: { class: "share-select min-w-0 flex-1", value: "=$model", "aria-label": "{_'ai.model'}", "data-testid": "ai-model" }, on: { change: { action: "model" } } }, [
          n("option", { id: "ai-model-option", each: "$models", as: "mo", key: "$mo.ref", attrs: { value: "{$mo.ref}" }, text: "{$mo.provider} · {$mo.label}" }),
        ]),
        n("select", { id: "ai-reasoning", if: "$canReason", attrs: { class: "share-select", value: "=$reasoning", "aria-label": "{_'ai.reasoning'}", title: "{_'ai.reasoning'}", "data-testid": "ai-reasoning" }, on: { change: { action: "reasoning" } } }, [
          n("option", { id: "ai-reasoning-option", each: "$levels", as: "lv", key: "$lv", attrs: { value: "{$lv}" }, text: "{$lv|t:'ai.reasoning.'}" }),
        ]),
        n("button", { id: "ai-new", if: "($turns|length) > 0", attrs: { type: "button", class: "ai-icon-btn", title: "{_'ai.new'}", "aria-label": "{_'ai.new'}", disabled: "=$busy", "data-testid": "ai-new" }, on: { click: { action: "newChat" } } }, [
          icon("square-pen", "h-4 w-4", { "aria-hidden": "true" }, { id: "ai-new-icon" }),
        ]),
      ]),
      n("panel", { id: "ai-thread", name: "The conversation", ref: "thread", attrs: { class: "ai-thread", "data-testid": "ai-thread", "aria-live": "polite" } }, [
        n("paragraph", { id: "ai-intro", if: "($turns|length) === 0", attrs: { class: "text-xs text-muted-foreground" }, text: "{_'ai.intro'}" }),
        n("panel", { id: "ai-msg", name: "A turn", each: "$turns", as: "tu", key: "$tu.key", attrs: { class: "ai-msg ai-msg--{$tu.role}{if $tu.pending} is-pending{/if}", "data-testid": "ai-msg", "data-role": "{$tu.role}" } }, [
          n("area", { id: "ai-msg-role", attrs: { class: "ai-msg__role" }, text: "{=$tu.role === 'user' ? ('ai.you'|t) : $tu.model}" }),
          n("panel", { id: "ai-msg-reasoning", name: "Reasoning", tag: "details", if: "$tu.reasoning", attrs: { class: "ai-msg__reasoning" } }, [
            n("panel", { id: "ai-msg-reasoning-label", tag: "summary", text: "{_'ai.thinking'}" }),
            n("paragraph", { id: "ai-msg-reasoning-text", attrs: { class: "ai-msg__reasoning-text" }, text: "{$tu.reasoning}" }),
          ]),
          n("slot", { id: "ai-msg-text", name: "The text (Markdown)", slot: "text", arg: "$tu" }),
          n("list", { id: "ai-sources", name: "Sources", tag: "ol", if: "($tu.citations|length) > 0", attrs: { class: "ai-sources", "aria-label": "{_'ai.sources'}" } }, [
            n("item", { id: "ai-source", each: "$tu.citations", as: "ci", key: "$ci.url" }, [
              n("link", { id: "ai-source-link", attrs: { href: "{$ci.url}", target: "_blank", rel: "noopener noreferrer" }, text: "{=$ci.title || $ci.url}" }),
            ]),
          ]),
          n("paragraph", { id: "ai-msg-error", if: "$tu.error", attrs: { class: "ai-msg__error", role: "alert", "data-testid": "ai-error" }, text: "{$tu.error}" }),
          n("area", { id: "ai-msg-stats", if: "$tu.stats", attrs: { class: "ai-msg__stats" }, text: "{$tu.stats}" }),
        ]),
      ]),
      n("panel", { id: "ai-actions", name: "The last answer", if: "$last && !$busy", attrs: { class: "flex flex-wrap gap-2" } }, [
        chip("ai-insert", "corner-down-left", "{_'ai.insert'}", "insert"),
        chip("ai-copy", "clipboard-copy", "{=($copied ? 'ai.copied' : 'common.copy')|t}", "copy"),
      ]),
      n("form", { id: "ai-compose", name: "The prompt", attrs: { class: "composer-bar", "data-testid": "ai-form" }, on: { submit: { action: "send" } } }, [
        n("textarea", {
          id: "ai-input",
          attrs: { class: "composer-input", rows: "1", value: "=$input", placeholder: "{_'ai.placeholder'}", "aria-label": "{_'ai.placeholder'}", maxlength: "=$maxInput", "data-testid": "ai-input" },
          on: { change: { action: "input" }, keydown: { action: "key" } },
        }),
        n("button", { id: "ai-send", if: "!$busy", attrs: { type: "submit", class: "composer-send", disabled: "=!$canSend", "aria-label": "{_'common.send'}", "data-testid": "ai-send" } }, [
          icon("send", "h-4 w-4", { "aria-hidden": "true" }, { id: "ai-send-icon" }),
        ]),
        n("button", { id: "ai-stop", if: "$busy", attrs: { type: "button", class: "composer-send", "aria-label": "{_'ai.stop'}", title: "{_'ai.stop'}", "data-testid": "ai-stop" }, on: { click: { action: "stop" } } }, [
          icon("square", "h-4 w-4", { "aria-hidden": "true" }, { id: "ai-stop-icon" }),
        ]),
      ]),
      n("paragraph", { id: "ai-note", attrs: { class: "text-[11px] text-muted-foreground" }, text: "{_'ai.note'}" }),
    ]),
  ]);
}

export const AI_CONTRACTS: Record<"panel.ai", LayoutContract> = {
  "panel.ai": {
    description: "The AI assistant: a conversation with the server's AI, streamed; the last answer can go into the message.",
    vars: [
      { path: "$state", type: "text", description: "ready, off (the module), no-model, sign-in (only signed-in users may), no-limit (the owner has not set a limit)." },
      { path: "$models", type: "list", description: "Models this user may use: .ref, .label, .provider, .reasoning." },
      { path: "$model", type: "text", description: "The chosen model (its ref)." },
      { path: "$canReason", type: "yes/no", description: "The chosen model can reason." },
      { path: "$levels", type: "list", description: "off, low, medium, high." },
      { path: "$reasoning", type: "text", description: "How much it reasons." },
      { path: "$turns", type: "list", description: "The conversation: .key, .role (user / assistant), .model, .text, .reasoning, .citations (.url, .title), .error, .stats, .pending." },
      { path: "$last", type: "yes/no", description: "There is an answer to insert or copy." },
      { path: "$copied", type: "yes/no", description: "Just copied." },
      { path: "$input", type: "text", description: "The prompt being written." },
      { path: "$maxInput", type: "number", description: "The longest prompt." },
      { path: "$busy", type: "yes/no", description: "An answer is being written." },
      { path: "$canSend", type: "yes/no", description: "There is something to send." },
    ],
    actions: [
      { name: "signIn", description: "Open the Connection window (sign in)." },
      { name: "model", description: "A model chosen.", event: "change" },
      { name: "reasoning", description: "How much it reasons.", event: "change" },
      { name: "newChat", description: "Start a new conversation." },
      { name: "insert", description: "Put the last answer into the message." },
      { name: "copy", description: "Copy the last answer." },
      { name: "input", description: "The prompt typed.", event: "change" },
      { name: "key", description: "Enter sends (Shift+Enter: a new line).", event: "keydown" },
      { name: "send", description: "Send the prompt.", event: "submit" },
      { name: "stop", description: "Stop the answer." },
    ],
    slots: [{ name: "text", description: "A turn's text: the answer as Markdown (and a cursor while it is written), the user's as typed." }],
    refs: [{ name: "thread", description: "The conversation (kept scrolled to the end)." }],
  },
};

export const AI_VARIANTS: Record<"panel.ai", ReadonlyArray<{ id: string; label: string }>> = {
  "panel.ai": [{ id: "ready", label: "A conversation" }, { id: "writing", label: "Writing an answer" }, { id: "no-limit", label: "No limit set yet" }, { id: "sign-in", label: "Signed out" }, { id: "off", label: "Switched off" }],
};
