// The message box's suggester (6.11), drawn: a popover anchored above the
// composer with what the typed trigger offers — commands / models (their icon,
// keyword, name, summary, signature and who sees the answer), people (their
// avatar), tags, a command argument's values — in sections, the matched
// letters highlighted, the selected command's detail beside (or below) the
// list; and, while a command's arguments are typed, the signature hint with
// the current argument, its help and its values. The logic is lib/suggest.ts
// (pure); this file is the drawing, the keys and the little state.
//
// Keys in the field: ↑ / ↓, PageUp / PageDown, Home / End move; Enter or Tab
// completes; Esc closes; Ctrl+Space opens it (everything that fits the word
// at the caret, or the values of the current argument). The field stays a
// textbox (a <textarea> cannot take the combobox role): it gets
// aria-autocomplete, aria-controls and aria-activedescendant pointing into the
// listbox, and aria-describedby the hint. The field may be any designable
// layout's — it is found by its id ("message").

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type Ref } from "react";
import { Bot, Calculator, ChartBar, CircleHelp, CloudSun, History, IdCard, List, Lock, MessageSquareText, Network, PhoneCall, PhoneForwarded, Receipt, SearchX, ToggleLeft, Users, X } from "lucide-react";
import type { Command } from "../lib/functions";
import { t, tf, tp, type Lang } from "../lib/i18n";
import { MENU_ICONS } from "../lib/menu-icons-data";
import { modelIdentity } from "../lib/system-messenger";
import {
  applyValue, itemUsageKey, loadUsage, recordUsage, saveUsage, suggest, usedIn, valueUsageKey,
  type ArgHint, type Range, type SuggestItem, type SuggestList, type SuggestPerson, type SuggestTrigger, type UsageMemory,
} from "../lib/suggest";
import { MenuIcon } from "./MenuIcon";
import { Avatar } from "./UserBadge";
import "./command-suggest.css";

export const SUGGEST_LIST_ID = "composer-suggest";
export const SUGGEST_HINT_ID = "composer-suggest-hint";
export const suggestOptionId = (i: number) => `${SUGGEST_LIST_ID}-opt-${i}`;
const PAGE = 5;

// ─── Small pieces ───────────────────────────────────────────────────────────

type IconComponent = typeof Bot;
/** The default model icons the menu catalog does not carry (system-messenger.ts › DEFAULT_MODEL_ICONS). */
const EXTRA_ICONS: Record<string, IconComponent> = {
  "phone-call": PhoneCall, "message-square-text": MessageSquareText, network: Network, "cloud-sun": CloudSun, calculator: Calculator,
  receipt: Receipt, "id-card": IdCard, "circle-help": CircleHelp, "phone-forwarded": PhoneForwarded, "chart-bar": ChartBar,
};

function firstGrapheme(s: string): string {
  try {
    const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
    if (Seg) for (const g of new Seg(undefined, { granularity: "grapheme" }).segment(s)) return g.segment;
  } catch { /* fall through */ }
  return [...s].slice(0, 2).join("");
}

/** A model's icon: a lucide name (the catalog's, or a default one), else one emoji; "bot" for an unknown name. */
export function ModelGlyph({ icon, className = "sug-glyph" }: { icon: string; className?: string }) {
  if (MENU_ICONS[icon]) return <MenuIcon name={icon} className={className} />;
  const Extra = EXTRA_ICONS[icon];
  if (Extra) return <Extra className={className} aria-hidden="true" />;
  if (/^[a-z0-9-]+$/i.test(icon)) return <Bot className={className} aria-hidden="true" />;
  return <span className="sug-emoji" aria-hidden="true">{firstGrapheme(icon)}</span>;
}

/** The model's icon in its coloured circle. */
export function ModelBadge({ command, size = "md" }: { command: Pick<Command, "keyword" | "name"> & { icon?: string }; size?: "sm" | "md" | "lg" }) {
  const id = modelIdentity(command);
  return (
    <span className={`sug-ico sug-ico--${size}`} style={{ "--sug-ico": id.color } as CSSProperties} aria-hidden="true">
      <ModelGlyph icon={id.icon} />
    </span>
  );
}

/** `text` with the matched ranges marked. */
function Marked({ text, ranges }: { text: string; ranges?: Range[] }) {
  if (!ranges || !ranges.length) return <>{text}</>;
  const out: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([a, b], i) => {
    if (a > at) out.push(text.slice(at, a));
    out.push(<mark key={i} className="sug-mark">{text.slice(Math.max(a, at), b)}</mark>);
    at = Math.max(at, b);
  });
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

function Visibility({ lang, visibility, long = false }: { lang: Lang; visibility: Command["visibility"]; long?: boolean }) {
  const room = visibility === "room";
  const title = t(lang, room ? "suggest.roomTitle" : "suggest.callerTitle");
  return (
    <span className={`sug-badge ${room ? "is-room" : "is-caller"}`} title={title}>
      {room ? <Users aria-hidden="true" /> : <Lock aria-hidden="true" />}
      {long ? title : t(lang, room ? "suggest.room" : "suggest.caller")}
    </span>
  );
}

const rangeText = (min?: number, max?: number) => (min !== undefined || max !== undefined ? ` ${min ?? "…"}–${max ?? "…"}` : "");

// ─── The view ───────────────────────────────────────────────────────────────

type ViewProps = {
  lang: Lang;
  list: SuggestList | null;
  hint: ArgHint | null;
  active: number;
  /** Where to sit (null: the stylesheet's place, centred above the composer). */
  position: { left: number; width: number; top: number } | null;
  onActive: (index: number) => void;
  onPick: (item: SuggestItem) => void;
  onValue: (value: string) => void;
  onHideHint: () => void;
  rootRef?: Ref<HTMLDivElement>;
};

/** The popover and the hint bar (controlled: useComposerSuggest drives it). */
export function CommandSuggest({ lang, list, hint, active, position, onActive, onPick, onValue, onHideHint, rootRef }: ViewProps) {
  if (!list && !hint) return null;
  const index = new Map(list?.items.map((it, i) => [it.id, i]) ?? []);
  const activeItem = list && active >= 0 ? list.items[active] : undefined;
  const detail = activeItem?.kind === "command" ? activeItem.command : undefined;
  const real = list?.items.filter((i) => i.kind !== "more").length ?? 0;
  const style = position ? ({ left: position.left, width: position.width, top: position.top, bottom: "auto", transform: "translateY(-100%)", "--sug-room": `${position.top}px` } as CSSProperties) : undefined;

  const row = (item: SuggestItem) => {
    const i = index.get(item.id) ?? -1;
    const on = i === active;
    const common = {
      id: suggestOptionId(i),
      role: "option" as const,
      "aria-selected": on,
      "data-testid": `sug-${item.id}`,
      onMouseDown: (e: ReactMouseEvent) => e.preventDefault(), // the field keeps the focus (and the keyboard on phones)
      onMouseMove: () => { if (!on) onActive(i); },
      onClick: () => onPick(item),
    };
    if (item.kind === "more") {
      return (
        <div key={item.id} {...common} className={`sug-row sug-row--more${on ? " is-active" : ""}`}>
          {tp(lang, "suggest.more", item.more ?? 0)}
        </div>
      );
    }
    if (item.kind === "command" && item.command) {
      const c = item.command;
      const id = modelIdentity(c);
      return (
        <div key={item.id} {...common} className={`sug-row sug-row--command${on ? " is-active" : ""}`}>
          <ModelBadge command={c} />
          <span className="sug-row__main">
            <span className="sug-row__top">
              <span className="sug-row__kw"><span className="sug-row__trig">{item.prefix}</span><Marked text={c.keyword} ranges={item.ranges} /></span>
              {id.name && id.name.toLowerCase() !== c.keyword.toLowerCase() ? <span className="sug-row__name"><Marked text={id.name} ranges={item.nameRanges} /></span> : null}
              {item.used ? <History className="sug-row__used" aria-label={t(lang, "suggest.used")} /> : null}
            </span>
            {c.summary ? <span className="sug-row__sum"><Marked text={c.summary} ranges={item.summaryRanges} /></span> : null}
          </span>
          <span className="sug-row__side">
            {c.inputs.length ? (
              <span className="sug-sig" aria-hidden="true">
                {c.inputs.map((a) => <span key={a.name} className={`sug-arg ${a.required && a.default === undefined ? "is-req" : "is-opt"}`}>{a.name}</span>)}
              </span>
            ) : null}
            <span className="sug-row__badges">
              {c.mine ? <span className="sug-badge is-mine">{t(lang, "suggest.mine")}</span> : null}
              <Visibility lang={lang} visibility={c.visibility} />
            </span>
          </span>
        </div>
      );
    }
    if (item.kind === "person" && item.person) {
      return (
        <div key={item.id} {...common} className={`sug-row sug-row--person${on ? " is-active" : ""}${item.person.away ? " is-away" : ""}`}>
          <span className="sug-ico sug-ico--md sug-ico--plain" aria-hidden="true"><Avatar name={item.person.name.replace(/_/g, " ")} avatar={item.person.avatar} size={28} /></span>
          <span className="sug-row__main">
            <span className="sug-row__top">
              <span className="sug-row__kw"><span className="sug-row__trig">{item.prefix}</span><Marked text={item.key} ranges={item.ranges} /></span>
              {item.used ? <History className="sug-row__used" aria-label={t(lang, "suggest.used")} /> : null}
            </span>
          </span>
          {item.person.away ? <span className="sug-badge is-away">{t(lang, "suggest.away")}</span> : null}
        </div>
      );
    }
    if (item.kind === "tag") {
      return (
        <div key={item.id} {...common} className={`sug-row sug-row--tag${on ? " is-active" : ""}`}>
          <span className="sug-ico sug-ico--md sug-ico--tag" aria-hidden="true">{item.prefix || "#"}</span>
          <span className="sug-row__main">
            <span className="sug-row__top">
              <span className="sug-row__kw"><span className="sug-row__trig">{item.prefix}</span><Marked text={item.key} ranges={item.ranges} /></span>
              {item.used ? <History className="sug-row__used" aria-label={t(lang, "suggest.used")} /> : null}
            </span>
          </span>
        </div>
      );
    }
    // a value of the current argument
    const type = hint?.current?.type;
    return (
      <div key={item.id} {...common} className={`sug-row sug-row--value${on ? " is-active" : ""}`}>
        <span className="sug-ico sug-ico--md sug-ico--value" aria-hidden="true">
          {type === "user" ? <Avatar name={item.key} size={28} /> : type === "boolean" ? <ToggleLeft className="sug-glyph" /> : <List className="sug-glyph" />}
        </span>
        <span className="sug-row__main">
          <span className="sug-row__top">
            <span className="sug-row__kw sug-row__kw--value"><Marked text={item.key} ranges={item.ranges} /></span>
            {item.used ? <History className="sug-row__used" aria-label={t(lang, "suggest.used")} /> : null}
          </span>
        </span>
        {item.value?.isDefault ? <span className="sug-badge">{t(lang, "suggest.default")}</span> : null}
      </div>
    );
  };

  const sectionTitle = (title: string, vars?: Record<string, string | number>) => (vars ? tf(lang, title, vars) : t(lang, title));
  const noticeText = (n: NonNullable<SuggestList["notice"]>) =>
    n.kind === "off" ? t(lang, "functions.off")
      : n.kind === "none" ? t(lang, "functions.none")
        : n.kind === "loading" ? t(lang, "suggest.loading")
          : n.kind === "noMatch" ? tf(lang, "suggest.noMatch", { q: `${n.trigger}${n.query}`, help: `${n.trigger}help` })
            : tf(lang, "suggest.nothing", { q: n.query });

  return (
    <div ref={rootRef} className="sug" style={style} data-testid="cmd-suggest" data-mode={list?.mode ?? "hint"}>
      {list ? (
        <div className={`sug__panel${detail ? " has-detail" : ""}`}>
          <div className="sug__main">
            {list.items.length ? (
              <div className="sug__list" id={SUGGEST_LIST_ID} role="listbox" aria-label={t(lang, "suggest.label")} data-testid="cmd-menu">
                {list.sections.map((s) => (
                  <div key={s.id} role="group" aria-labelledby={`${SUGGEST_LIST_ID}-h-${s.id}`} className={`sug__group sug__group--${s.id}`}>
                    <div className="sug__head" id={`${SUGGEST_LIST_ID}-h-${s.id}`}>
                      <span>{sectionTitle(s.title, s.titleVars)}</span>
                      <span className="sug__count">{s.total}</span>
                    </div>
                    {s.items.map(row)}
                    {list.items.filter((it) => it.kind === "more" && it.section === s.id).map(row)}
                  </div>
                ))}
              </div>
            ) : null}
            {list.notice ? (
              <div className={`sug__empty sug__empty--${list.notice.kind}`} role="status" data-testid="cmd-suggest-empty">
                {list.notice.kind === "noMatch" || list.notice.kind === "nothing" ? <SearchX aria-hidden="true" /> : null}
                <span>{noticeText(list.notice)}</span>
              </div>
            ) : null}
          </div>
          {detail ? <CommandDetail lang={lang} command={detail} /> : null}
          {list.items.length ? (
            <div className="sug__keys" aria-hidden="true">
              <span><kbd>↑</kbd><kbd>↓</kbd> {t(lang, "suggest.k.move")}</span>
              <span><kbd>Enter</kbd><kbd>Tab</kbd> {t(lang, "suggest.k.pick")}</span>
              <span><kbd>Esc</kbd> {t(lang, "suggest.k.close")}</span>
            </div>
          ) : null}
          <span className="sr-only" role="status">{list.items.length ? tf(lang, "suggest.count", { n: real }) : ""}</span>
        </div>
      ) : null}
      {hint ? <HintBar lang={lang} hint={hint} onValue={onValue} onHide={onHideHint} /> : null}
    </div>
  );
}

/** The selected command, in full: usage, arguments, the model's own guide, who sees the answer. */
function CommandDetail({ lang, command: c }: { lang: Lang; command: Command }) {
  const id = modelIdentity(c);
  return (
    <aside className="sug-detail" data-testid="cmd-suggest-detail" aria-label={id.name}>
      <div className="sug-detail__head">
        <ModelBadge command={c} size="lg" />
        <div className="sug-detail__title">
          <div className="sug-detail__name">{id.name}</div>
          <Visibility lang={lang} visibility={c.visibility} long />
        </div>
      </div>
      {c.summary ? <p className="sug-detail__sum">{c.summary}</p> : null}
      <div className="sug-detail__label">{t(lang, "suggest.usage")}</div>
      <code className="sug-detail__usage">
        <span className="sug-sigpart is-kw">/{c.keyword}</span>
        {c.inputs.map((a) => {
          const req = a.required && a.default === undefined;
          return <Fragment key={a.name}>{" "}<span className={`sug-sigpart ${req ? "is-req" : "is-opt"}`}>{req ? `<${a.name}>` : `[${a.name}]`}</span></Fragment>;
        })}
      </code>
      {c.inputs.length ? (
        <>
          <div className="sug-detail__label sug-detail__label--inputs">{t(lang, "suggest.inputs")}</div>
          <ul className="sug-detail__inputs">
            {c.inputs.map((a) => {
              const req = a.required && a.default === undefined;
              return (
                <li key={a.name}>
                  <span className="sug-detail__in">
                    <code className={req ? "is-req" : "is-opt"}>{a.name}</code>
                    <span className="sug-type">{a.type}{rangeText(a.min, a.max)}</span>
                    <span className={`sug-flag ${req ? "is-req" : ""}`}>{t(lang, req ? "suggest.required" : "suggest.optional")}</span>
                  </span>
                  {a.label && a.label !== a.name ? <span className="sug-detail__inlabel">{a.label}</span> : null}
                  {a.help ? <span className="sug-detail__help">{a.help}</span> : null}
                  {a.values && a.values.length ? <span className="sug-detail__vals">{a.values.slice(0, 12).map((v) => <span key={v} className="sug-chip is-static">{v}</span>)}</span> : null}
                  {a.default !== undefined ? <span className="sug-detail__help">{tf(lang, "suggest.defaultIs", { v: String(a.default) })}</span> : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : <p className="sug-detail__sum sug-detail__sum--muted">{t(lang, "suggest.noArgs")}</p>}
      {c.usage ? (
        <>
          <div className="sug-detail__label">{t(lang, "suggest.guide")}</div>
          <pre className="sug-detail__guide">{c.usage}</pre>
        </>
      ) : null}
    </aside>
  );
}

/** Above the field while a command's arguments are typed: the signature, the current argument, its values. */
function HintBar({ lang, hint, onValue, onHide }: { lang: Lang; hint: ArgHint; onValue: (v: string) => void; onHide: () => void }) {
  const cur = hint.current;
  const fq = hint.partial.toLowerCase();
  const shown = new Set(hint.values.map((v) => v.value));
  const def = cur?.default !== undefined ? String(cur.default) : undefined;
  return (
    <div className="sug-hint" id={SUGGEST_HINT_ID} role="group" aria-label={t(lang, "suggest.hint")} data-testid="cmd-hint">
      <div className="sug-hint__sig">
        <ModelBadge command={hint.command} size="sm" />
        <code className="sug-hint__usage">
          {hint.parts.map((p, i) => (
            <Fragment key={i}>
              {i ? " " : null}
              <span
                className={`sug-sigpart ${p.input ? (p.required ? "is-req" : "is-opt") : "is-kw"}${p.active ? " is-active" : ""}${p.given ? " is-given" : ""}`}
                data-active={p.active || undefined}
              >
                {p.text}
              </span>
            </Fragment>
          ))}
        </code>
        <button type="button" className="sug-hint__x" aria-label={t(lang, "suggest.hintClose")} title={t(lang, "suggest.hintClose")} onMouseDown={(e) => e.preventDefault()} onClick={onHide}>
          <X aria-hidden="true" />
        </button>
      </div>
      {cur ? (
        <div className="sug-hint__cur" data-testid="cmd-hint-current">
          <b className="sug-hint__label">{cur.label}</b>
          <span className="sug-type">{cur.type}{rangeText(cur.min, cur.max)}</span>
          <span className={`sug-flag ${cur.required ? "is-req" : ""}`}>{t(lang, cur.required ? "suggest.required" : "suggest.optional")}</span>
          {!cur.positional && !hint.byKey ? <span className="sug-flag">{tf(lang, "suggest.namedOnly", { name: cur.name })}</span> : null}
          {cur.help ? <span className="sug-hint__help">{cur.help}</span> : null}
          {cur.example && !(cur.values && cur.values.length) ? <span className="sug-hint__eg">{tf(lang, "suggest.example", { v: cur.example })}</span> : null}
        </div>
      ) : hint.extra ? (
        <div className="sug-hint__cur is-warn" data-testid="cmd-hint-extra">{t(lang, "suggest.extra")}</div>
      ) : null}
      {cur && hint.choices.length ? (
        <div className="sug-hint__chips" role="group" aria-label={tf(lang, "suggest.valuesFor", { label: cur.label })}>
          {hint.choices.slice(0, 24).map((v) => (
            <button
              key={v}
              type="button"
              className={`sug-chip${fq && v.toLowerCase() === fq ? " is-on" : ""}${fq && !shown.has(v) ? " is-dim" : ""}${v === def ? " is-default" : ""}`}
              title={v === def ? tf(lang, "suggest.defaultIs", { v }) : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onValue(v)}
            >
              {v}
            </button>
          ))}
        </div>
      ) : null}
      {hint.missing.length ? <div className="sug-hint__missing">{tf(lang, "suggest.missing", { names: hint.missing.join(", ") })}</div> : null}
      {/* what a screen reader hears when the current argument changes (not on every letter) */}
      <span className="sr-only" aria-live="polite">{cur ? `${cur.label}, ${t(lang, cur.required ? "suggest.required" : "suggest.optional")}${cur.help ? `. ${cur.help}` : ""}` : ""}</span>
    </div>
  );
}

// ─── The state and the keys ─────────────────────────────────────────────────

export type ComposerSuggestOptions = {
  lang: Lang;
  /** The field's text, and how to change it. */
  text: string;
  setText: (text: string) => void;
  /** The field's id (any designable composer layout's "message"). */
  inputId?: string;
  /** The operator's trigger characters (ComposerPolicy.triggers). */
  triggers: readonly SuggestTrigger[];
  commands: readonly Command[];
  commandsEnabled: boolean | null;
  people: readonly SuggestPerson[];
  tags: readonly string[];
  /** Whose usage memory (the account, or "local"). */
  user: string;
};

export type ComposerSuggest = {
  /** A key in the field; true: it was the suggester's (do nothing more with it). */
  onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => boolean;
  /** The field changed by typing: the list may open again. */
  onInput: () => void;
  /** Close the list (until the next typing). */
  dismiss: () => void;
  /** A message went: remember the command, people and tags it used. */
  noteSent: (text: string) => void;
  /** The list is showing. */
  open: boolean;
  /** The popover and the hint, to render once (it positions itself). */
  view: ReactNode;
};

const listSig = (l: SuggestList | null) => (l ? `${l.mode}|${l.query}|${l.items.map((i) => i.id).join(",")}` : "");

export function useComposerSuggest(o: ComposerSuggestOptions): ComposerSuggest {
  const inputId = o.inputId ?? "message";
  const getField = useCallback(() => (typeof document === "undefined" ? null : document.getElementById(inputId) as HTMLTextAreaElement | HTMLInputElement | null), [inputId]);
  const [caret, setCaret] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [forced, setForced] = useState(false);
  const [expanded, setExpanded] = useState<{ mode: string; ids: string[] }>({ mode: "", ids: [] });
  const [sel, setSel] = useState<{ sig: string; index: number }>({ sig: "", index: -1 });
  const [hintOff, setHintOff] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageMemory>(() => loadUsage(o.user));
  const userRef = useRef(o.user);
  useEffect(() => { if (userRef.current !== o.user) { userRef.current = o.user; setUsage(loadUsage(o.user)); } }, [o.user]);

  const ctxBase = { text: o.text, caret: caret ?? undefined, triggers: o.triggers, commands: o.commands, commandsEnabled: o.commandsEnabled, people: o.people, tags: o.tags, usage, forced };
  const result = useMemo(() => {
    const first = suggest({ ...ctxBase, expanded: [] });
    if (!first.list || expanded.mode !== first.list.mode || !expanded.ids.length) return first;
    return suggest({ ...ctxBase, expanded: expanded.ids });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.text, caret, o.triggers, o.commands, o.commandsEnabled, o.people, o.tags, usage, forced, expanded]);

  const list = !dismissed && result.list && (result.list.items.length || result.list.notice) ? result.list : null;
  const hint = result.hint && hintOff !== result.hint.command.keyword ? result.hint : null;
  const sig = listSig(list);
  const items = list?.items ?? [];
  const active = !list ? -1 : sel.sig === sig ? Math.min(sel.index, items.length - 1) : list.autoSelect && items.length ? 0 : -1;
  const move = (index: number) => setSel({ sig, index });

  // The caret: typing, clicking and the arrow keys move it (the field may be re-created by its layout, so listen on the document).
  // In the BUBBLE phase and deferred: a state update made while the browser is still delivering a typed
  // character — before React's own change handler (on the root) has run — re-renders the controlled field
  // with the text from before the keystroke and the character is lost (6.11 regression: nothing could be typed).
  useEffect(() => {
    if (typeof document === "undefined") return;
    const sync = (e: Event) => {
      const el = e.target as HTMLTextAreaElement | null;
      if (!el || el.id !== inputId) return;
      const caretAt = typeof el.selectionStart === "number" ? el.selectionStart : null;
      // a space or a new line typed ends the word Ctrl+Space opened the list for
      const ends = e.type === "input" && (((e as InputEvent).data && /\s/.test((e as InputEvent).data as string)) || (e as InputEvent).inputType === "insertLineBreak");
      queueMicrotask(() => { setCaret(caretAt); if (ends) setForced(false); });
    };
    const evs = ["input", "keyup", "mouseup", "select", "focusin"];
    for (const ev of evs) document.addEventListener(ev, sync);
    return () => { for (const ev of evs) document.removeEventListener(ev, sync); };
  }, [inputId]);
  // …and a text changed from elsewhere puts it where the field has it — or, after a pick, where the pick leaves it.
  const pendingCaret = useRef<number | null>(null);
  const [placed, setPlaced] = useState(0);
  useLayoutEffect(() => {
    const el = getField();
    if (!el || typeof document === "undefined") return;
    if (pendingCaret.current !== null) {
      const pos = Math.min(pendingCaret.current, el.value.length);
      pendingCaret.current = null;
      if (document.activeElement !== el) el.focus();
      try { el.setSelectionRange(pos, pos); } catch { /* not a text field */ }
      setCaret(pos);
      return;
    }
    if (document.activeElement === el && typeof el.selectionStart === "number") setCaret(el.selectionStart);
  }, [o.text, placed, getField]);
  useEffect(() => { if (!o.text) { setForced(false); setHintOff(null); } }, [o.text]);

  // Where to sit: above the composer bar, as wide as it (within the screen).
  const [position, setPosition] = useState<{ left: number; width: number; top: number } | null>(null);
  const visible = Boolean(list || hint);
  useLayoutEffect(() => {
    if (!visible || typeof window === "undefined") return;
    const el = getField();
    const anchor = (el?.closest(".composer-bar") as HTMLElement | null) ?? el;
    const place = () => {
      const r = anchor?.getBoundingClientRect();
      if (!r || !r.width) { setPosition(null); return; }
      const vw = window.innerWidth;
      const gutter = vw < 640 ? 8 : 12;
      const width = Math.round(Math.min(Math.max(r.width, Math.min(380, vw - 2 * gutter)), 760, vw - 2 * gutter));
      const left = Math.round(Math.max(gutter, Math.min(r.left + (r.width - Math.min(width, r.width)) / 2, vw - width - gutter)));
      const top = Math.round(r.top - 6);
      setPosition((p) => (p && p.left === left && p.width === width && p.top === top ? p : { left, width, top }));
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    const ro = typeof ResizeObserver !== "undefined" && anchor ? new ResizeObserver(place) : null;
    if (ro && anchor) ro.observe(anchor);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
      ro?.disconnect();
    };
  }, [visible, getField]);

  // The field points at the list, the selected row and the hint.
  useEffect(() => {
    const el = getField();
    if (!el) return;
    el.setAttribute("aria-autocomplete", "list");
    if (list && items.length) el.setAttribute("aria-controls", SUGGEST_LIST_ID); else el.removeAttribute("aria-controls");
    if (list && active >= 0) el.setAttribute("aria-activedescendant", suggestOptionId(active)); else el.removeAttribute("aria-activedescendant");
    const described = (el.getAttribute("aria-describedby") || "").split(/\s+/).filter((x) => x && x !== SUGGEST_HINT_ID);
    if (hint) described.push(SUGGEST_HINT_ID);
    if (described.length) el.setAttribute("aria-describedby", described.join(" ")); else el.removeAttribute("aria-describedby");
  });
  useEffect(() => () => {
    const el = getField();
    el?.removeAttribute("aria-controls");
    el?.removeAttribute("aria-activedescendant");
  }, [getField]);

  // The selected row in view.
  useEffect(() => {
    if (active < 0 || typeof document === "undefined") return;
    const el = document.getElementById(suggestOptionId(active));
    if (!el || typeof el.scrollIntoView !== "function") return;
    const reduce = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [active, sig]);

  // A press outside the field and the popover closes the list.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listShown = Boolean(list);
  useEffect(() => {
    if (!listShown || typeof document === "undefined") return;
    const onDown = (e: Event) => {
      const target = e.target as Node | null;
      if (target && (rootRef.current?.contains(target) || getField()?.contains(target))) return;
      setDismissed(true);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [listShown, getField]);

  const remember = (keys: string[]) => {
    if (!keys.length) return;
    const now = Date.now();
    const next = keys.reduce((m, k) => recordUsage(m, k, now), usage);
    setUsage(next);
    saveUsage(o.user, next);
  };

  const focusAt = (pos: number) => {
    setCaret(pos);
    pendingCaret.current = pos;
    setPlaced((n) => n + 1);
  };

  const fill = (next: { text: string; caret: number }) => {
    o.setText(next.text);
    setForced(false);
    setDismissed(false);
    setHintOff(null);
    focusAt(next.caret);
  };

  const pick = (item: SuggestItem | undefined) => {
    if (!item) return;
    if (item.kind === "more" && item.section && list) {
      const ids = [...(expanded.mode === list.mode ? expanded.ids : []), item.section];
      setExpanded({ mode: list.mode, ids });
      // keep the selection where the "more" row was: the first row it opened
      const at = items.indexOf(item);
      const opened = suggest({ ...ctxBase, expanded: ids }).list;
      setSel({ sig: listSig(opened), index: Math.max(0, at) });
      return;
    }
    if (!item.apply) return;
    const key = itemUsageKey(item);
    if (key) remember([key]);
    setExpanded({ mode: "", ids: [] });
    fill(item.apply);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>): boolean => {
    if ((e.nativeEvent as KeyboardEvent | undefined)?.isComposing) return false;
    if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === " " || e.code === "Space" || e.key === "Spacebar")) {
      e.preventDefault();
      setForced(true);
      setDismissed(false);
      setHintOff(null);
      return true;
    }
    if (list) {
      const n = items.length;
      if (n) {
        switch (e.key) {
          case "ArrowDown": e.preventDefault(); move(active < 0 ? 0 : (active + 1) % n); return true;
          case "ArrowUp": e.preventDefault(); move(active < 0 ? n - 1 : (active - 1 + n) % n); return true;
          case "PageDown": e.preventDefault(); move(Math.min(n - 1, Math.max(0, active) + PAGE)); return true;
          case "PageUp": e.preventDefault(); move(Math.max(0, active - PAGE)); return true;
          case "Home": if (!e.shiftKey) { e.preventDefault(); move(0); return true; } break;
          case "End": if (!e.shiftKey) { e.preventDefault(); move(n - 1); return true; } break;
          case "Tab": if (!e.shiftKey) { e.preventDefault(); pick(items[active < 0 ? 0 : active]); return true; } break;
          case "Enter": if (!e.shiftKey && active >= 0) { e.preventDefault(); pick(items[active]); return true; } break;
          default: break;
        }
      }
      if (e.key === "Escape") { e.preventDefault(); setDismissed(true); setForced(false); return true; }
    }
    if (hint && e.key === "Escape") { e.preventDefault(); setHintOff(hint.command.keyword); return true; }
    return false;
  };

  const view = (
    <CommandSuggest
      lang={o.lang}
      list={list}
      hint={hint}
      active={active}
      position={position}
      onActive={move}
      onPick={pick}
      onValue={(v) => { const h = result.hint; if (!h) return; if (h.current) remember([valueUsageKey(h.command.keyword, h.current.name, v)]); fill(applyValue(o.text, h, v)); }}
      onHideHint={() => { if (result.hint) setHintOff(result.hint.command.keyword); }}
      rootRef={rootRef}
    />
  );

  return {
    onKeyDown,
    onInput: () => { setDismissed(false); },
    dismiss: () => { setDismissed(true); setForced(false); },
    noteSent: (text: string) => remember(usedIn(text, o.triggers, o.commands, o.people)),
    open: Boolean(list),
    view,
  };
}
