// Edit Mode inspector — pick any element (Ctrl + right mouse button, a long
// tap, or ⌖ then tap) and restyle it:
//
//   Styles   scope (this element / its test id / a class / tag + class …),
//            state (:hover, :active = clicked, :focus, :visited, ::before …),
//            device scope, the declarations as editable rows or raw source,
//            quick controls, and the matched stylesheet rules — the "source
//            code" of the element's classes — each editable as an override.
//   Classes  remove / restore the element's classes, find any class defined
//            in the app's stylesheets and add it, or create a new one.
//   Box      box model + computed values (copy any into the editor).
//   Changes  unsaved + saved rules of this session, undo.
//
// Edits preview live on the page (a working copy of the overrides) and are
// persisted on Save (Ctrl/⌘+S). The inspector lives in a Shadow DOM: its own
// look is immune to whatever CSS the user writes, so a bad rule can never
// lock you out of the tool that fixes it.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDown, ArrowUp, Box, Check, ChevronDown, ChevronUp, Code2, Copy, Crosshair, Eye, EyeOff, History, Layers,
  ListTree, PanelLeft, PanelRight, Plus, Power, RotateCcw, Search, SlidersHorizontal, Tag, Trash2, Undo2, X,
} from "lucide-react";
import inspectorCss from "./inspector.css?inline";
import { t, type Lang } from "@/lib/i18n";
import {
  EDITOR_ATTR, boxModel, classRules, computedSnapshot, countMatches, createPicker, describeElement, matchedRules,
  onInspectRequest, selectorOptions, setPreviewOverrides, styleStore, stylesheetClasses, useStyleOverrides,
  type MatchedRule, type Picker,
} from "@/lib/style-editor";
import {
  CSS_PROPERTIES, STYLE_STATES, baseSelector, findRule, parseDeclarations, patchClass, prettyDeclarations,
  ruleKey, sanitizeClassName, sanitizeSelector, sanitizeState, serializeDeclarations, stateOf, upsertRule,
  type Declaration, type StyleOverrides, type StyleScope,
} from "@/lib/style-overrides";
import { cssColorToHex } from "@/lib/color";
import { FONTS, ensureFonts } from "@/lib/fonts";

type Props = { active: boolean; lang: Lang; onExit: () => void; allowGoogleFonts: boolean };
type Tab = "styles" | "classes" | "box" | "changes";
type SheetSize = "min" | "half" | "full";
const UI_KEY = "m5cet:inspector:ui";
const SCOPES: StyleScope[] = ["all", "phone", "tablet", "desktop", "touch", "mouse"];

type UiState = { dock: "right" | "left"; width: number; sheet: SheetSize; minimized: boolean };
function loadUi(): UiState {
  const base: UiState = { dock: "right", width: 380, sheet: "half", minimized: false };
  try {
    const raw = JSON.parse(localStorage.getItem(UI_KEY) || "{}") as Partial<UiState>;
    return {
      dock: raw.dock === "left" ? "left" : "right",
      width: typeof raw.width === "number" ? Math.max(300, Math.min(640, raw.width)) : base.width,
      sheet: raw.sheet === "min" || raw.sheet === "full" ? raw.sheet : "half",
      minimized: raw.minimized === true,
    };
  } catch { return base; }
}

const same = (a: StyleOverrides, b: StyleOverrides) => JSON.stringify(a) === JSON.stringify(b);
const isPhoneLayout = () =>
  document.documentElement.getAttribute("data-form") === "phone" || window.innerWidth < 640;

/* ================================================================ host */

/** Mounts a shadow root on <body> for the inspector; returns the container. */
function useShadowContainer(active: boolean): HTMLElement | null {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!active) return;
    const host = document.createElement("div");
    host.id = "m5-inspector-host";
    host.setAttribute(EDITOR_ATTR, "");
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = inspectorCss;
    root.appendChild(style);
    const mount = document.createElement("div");
    mount.className = "ins-root";
    root.appendChild(mount);
    setContainer(mount);
    document.documentElement.classList.add("m5-edit-mode");
    return () => {
      document.documentElement.classList.remove("m5-edit-mode");
      setContainer(null);
      host.remove();
    };
  }, [active]);
  return container;
}

export function StyleInspector({ active, lang, onExit, allowGoogleFonts }: Props) {
  const container = useShadowContainer(active);
  if (!active || !container) return null;
  return createPortal(<Inspector lang={lang} onExit={onExit} allowGoogleFonts={allowGoogleFonts} />, container);
}

/* ============================================================ overlays */

function useTracker(el: Element | null, draw: (rect: DOMRect | null, el: Element | null) => void) {
  const drawRef = useRef(draw);
  drawRef.current = draw;
  useEffect(() => {
    if (!el) { drawRef.current(null, null); return; }
    let raf = 0;
    let last = "";
    const loop = () => {
      if (!el.isConnected) { drawRef.current(null, null); return; }
      const r = el.getBoundingClientRect();
      const sig = `${r.x}|${r.y}|${r.width}|${r.height}`;
      if (sig !== last) { last = sig; drawRef.current(r, el); }
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [el]);
}

function Overlays({ hover, target }: { hover: Element | null; target: Element | null }) {
  const hoverRef = useRef<HTMLDivElement>(null);
  const hoverLabel = useRef<HTMLDivElement>(null);
  const marginRef = useRef<HTMLDivElement>(null);
  const borderRef = useRef<HTMLDivElement>(null);
  const paddingRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const selLabel = useRef<HTMLDivElement>(null);

  const place = (node: HTMLDivElement | null, x: number, y: number, w: number, h: number) => {
    if (!node) return;
    node.style.display = "block";
    node.style.transform = `translate(${x}px, ${y}px)`;
    node.style.width = `${Math.max(0, w)}px`;
    node.style.height = `${Math.max(0, h)}px`;
  };
  const hide = (...nodes: Array<HTMLDivElement | null>) => nodes.forEach((n) => { if (n) n.style.display = "none"; });
  const label = (node: HTMLDivElement | null, el: Element, r: DOMRect) => {
    if (!node) return;
    node.textContent = `${describeElement(el)}  ${Math.round(r.width)}×${Math.round(r.height)}`;
    node.style.display = "block";
    const y = r.top > 28 ? r.top - 24 : r.bottom + 4;
    node.style.transform = `translate(${Math.max(4, Math.min(window.innerWidth - 260, r.left))}px, ${y}px)`;
  };

  useTracker(hover, (r, el) => {
    if (!r || !el || el === target) { hide(hoverRef.current, hoverLabel.current); return; }
    place(hoverRef.current, r.left, r.top, r.width, r.height);
    label(hoverLabel.current, el, r);
  });
  useTracker(target, (r, el) => {
    if (!r || !el) { hide(marginRef.current, borderRef.current, paddingRef.current, contentRef.current, selLabel.current); return; }
    const b = boxModel(el);
    const [mt, mr, mb, ml] = b.margin;
    const [bt, br, bb, bl] = b.border;
    const [pt, pr, pb, pl] = b.padding;
    place(marginRef.current, r.left - ml, r.top - mt, r.width + ml + mr, r.height + mt + mb);
    place(borderRef.current, r.left, r.top, r.width, r.height);
    place(paddingRef.current, r.left + bl, r.top + bt, r.width - bl - br, r.height - bt - bb);
    place(contentRef.current, r.left + bl + pl, r.top + bt + pt, r.width - bl - br - pl - pr, r.height - bt - bb - pt - pb);
    label(selLabel.current, el, r);
  });

  return (
    <div className="ins-overlays" aria-hidden="true">
      <div ref={marginRef} className="ins-ov ins-ov--margin" />
      <div ref={borderRef} className="ins-ov ins-ov--border" />
      <div ref={paddingRef} className="ins-ov ins-ov--padding" />
      <div ref={contentRef} className="ins-ov ins-ov--content" />
      <div ref={selLabel} className="ins-ov-label is-selected" />
      <div ref={hoverRef} className="ins-ov ins-ov--hover" />
      <div ref={hoverLabel} className="ins-ov-label" />
    </div>
  );
}

/* ============================================================ inspector */

function Inspector({ lang, onExit, allowGoogleFonts }: { lang: Lang; onExit: () => void; allowGoogleFonts: boolean }) {
  const store = useStyleOverrides();
  const [working, setWorking] = useState<StyleOverrides>(store);
  const dirty = !same(working, store);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  // External changes (Appearance → Editor) rebase a clean working copy.
  useEffect(() => { if (!dirtyRef.current) setWorking(store); }, [store]);
  useEffect(() => { setPreviewOverrides(dirty ? working : null); }, [working, dirty]);
  useEffect(() => () => setPreviewOverrides(null), []);

  const [ui, setUi] = useState<UiState>(loadUi);
  useEffect(() => { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch { /* ignore */ } }, [ui]);
  const [phone, setPhone] = useState(isPhoneLayout);
  useEffect(() => {
    const onResize = () => setPhone(isPhoneLayout());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const [target, setTarget] = useState<Element | null>(null);
  const [hover, setHover] = useState<Element | null>(null);
  const [armed, setArmed] = useState(false);
  const [tab, setTab] = useState<Tab>("styles");
  const [status, setStatus] = useState("");
  const [tick, setTick] = useState(0); // re-read DOM-derived data after edits

  const [sel, setSel] = useState("");
  const [pseudo, setPseudo] = useState("");
  const [scope, setScope] = useState<StyleScope>("all");
  const [rows, setRows] = useState<Declaration[]>([]);
  const [important, setImportant] = useState(true);
  const key = ruleKey(sel, pseudo, scope);

  const pickerRef = useRef<Picker | null>(null);

  const selectElement = useCallback((el: Element, opts?: { keepSelector?: boolean }) => {
    setTarget(el);
    setArmed(false);
    pickerRef.current?.armTapPick(false);
    setUi((u) => ({ ...u, minimized: false, sheet: u.sheet === "min" ? "half" : u.sheet }));
    if (!opts?.keepSelector) {
      const first = selectorOptions(el)[0];
      setSel(first?.selector ?? describeElement(el));
      setPseudo("");
      setScope("all");
    }
  }, []);

  // Picker lifecycle.
  useEffect(() => {
    const picker = createPicker({ onPick: (el) => selectElement(el), onHover: setHover });
    pickerRef.current = picker;
    return () => { picker.destroy(); pickerRef.current = null; };
  }, [selectElement]);

  // Open a rule requested from the Appearance screen.
  useEffect(() => onInspectRequest((r) => {
    setSel(r.selector);
    setPseudo(r.state ?? "");
    setScope(r.scope ?? "all");
    setTab("styles");
    let el: Element | null = null;
    try { el = document.querySelector(baseSelector(r.selector.split(",")[0] ?? r.selector)); } catch { el = null; }
    if (el) selectElement(el, { keepSelector: true });
  }), [selectElement]);

  // Load the rows of the current (selector, state, scope) from the working copy.
  // "Edit source" of a stylesheet rule starts from that rule's declarations
  // (pendingRows) when nothing is overridden for it yet — they enter the
  // working copy only once actually edited.
  const workingRef = useRef(working);
  workingRef.current = working;
  const pendingRowsRef = useRef<Declaration[] | null>(null);
  useEffect(() => {
    const pending = pendingRowsRef.current;
    pendingRowsRef.current = null;
    if (!sel) { setRows([]); return; }
    const r = findRule(workingRef.current, sel, pseudo, scope);
    if (!r && pending) { setRows(pending); setImportant(false); return; }
    setRows(r ? parseDeclarations(r.declarations) : []);
    setImportant(r ? r.important : !/^\.[\w-]+$/.test(sel.trim()));
  }, [key, sel, pseudo, scope]);
  const openRule = (selector: string, state: string, initial?: Declaration[]) => {
    if (ruleKey(selector, state, scope) === key) {
      if (initial && !findRule(workingRef.current, selector, state, scope)) { setRows(initial); setImportant(false); }
      return;
    }
    pendingRowsRef.current = initial ?? null;
    setSel(selector);
    setPseudo(state);
  };
  // After Discard / external rebase the rows must follow the working copy.
  const reloadRows = () => {
    const r = findRule(workingRef.current, sel, pseudo, scope);
    setRows(r ? parseDeclarations(r.declarations) : []);
  };

  const pushRule = (nextRows: Declaration[], imp = important) => {
    setRows(nextRows);
    if (!sel.trim()) return;
    setWorking((w) => upsertRule(w, { selector: sel, state: pseudo, scope, declarations: serializeDeclarations(nextRows), important: imp, enabled: true }));
  };

  const save = () => {
    if (!dirty) return;
    const ok = styleStore.commit(working);
    setStatus(ok ? t(lang, "ins.saved") : t(lang, "ins.saveFailed"));
    setTick((x) => x + 1);
  };
  const discard = () => {
    setWorking(store);
    workingRef.current = store;
    reloadRows();
    setStatus(t(lang, "ins.discarded"));
  };
  const exit = () => {
    if (dirty) {
      if (window.confirm(t(lang, "ins.exitSave"))) styleStore.commit(working);
    }
    setPreviewOverrides(null);
    onExit();
  };

  // Keyboard: Ctrl/⌘+S saves, Esc disarms / deselects.
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
    if (e.key === "Escape") {
      if (armed) { setArmed(false); pickerRef.current?.armTapPick(false); }
      else if (target) setTarget(null);
    }
  };

  const toggleArm = () => {
    const next = !armed;
    setArmed(next);
    pickerRef.current?.armTapPick(next);
    if (next) setStatus(t(lang, "ins.armed"));
  };

  const layout = phone ? "sheet" : "dock";
  const minimized = ui.minimized || (phone && ui.sheet === "min");
  const style = phone ? undefined : { width: `${ui.width}px` };

  return (
    <>
      <Overlays hover={hover} target={target} />
      <section
        className="ins"
        data-layout={layout}
        data-dock={ui.dock}
        data-sheet={phone ? ui.sheet : undefined}
        data-min={minimized ? "true" : undefined}
        style={style}
        onKeyDown={onKeyDown}
        aria-label="Inspector"
        data-testid="inspector"
      >
        {phone ? <SheetGrip ui={ui} setUi={setUi} /> : <ResizeEdge ui={ui} setUi={setUi} />}
        <header className="ins-head">
          <div className="ins-head__brand">
            <span className="ins-dot" aria-hidden="true" />
            <span className="ins-title">Inspector</span>
          </div>
          <div className="ins-head__actions">
            <button type="button" className={`ins-btn ins-btn--icon ${armed ? "is-active" : ""}`} onClick={toggleArm} title={t(lang, "ins.pick")} aria-label={t(lang, "ins.pick")} aria-pressed={armed} data-testid="ins-pick">
              <Crosshair size={16} />
            </button>
            <button type="button" className="ins-btn ins-btn--icon" disabled={!target?.parentElement || target === document.body} onClick={() => target?.parentElement && selectElement(target.parentElement)} title={t(lang, "ins.parent")} aria-label={t(lang, "ins.parent")} data-testid="ins-parent">
              <ArrowUp size={16} />
            </button>
            <button type="button" className="ins-btn ins-btn--icon" disabled={!target?.firstElementChild} onClick={() => target?.firstElementChild && selectElement(target.firstElementChild)} title={t(lang, "ins.child")} aria-label={t(lang, "ins.child")}>
              <ArrowDown size={16} />
            </button>
            {!phone ? (
              <button type="button" className="ins-btn ins-btn--icon" onClick={() => setUi((u) => ({ ...u, dock: u.dock === "right" ? "left" : "right" }))} title={t(lang, "ins.dock")} aria-label={t(lang, "ins.dock")}>
                {ui.dock === "right" ? <PanelLeft size={16} /> : <PanelRight size={16} />}
              </button>
            ) : null}
            <button
              type="button"
              className="ins-btn ins-btn--icon"
              onClick={() => setUi((u) => (phone ? { ...u, sheet: u.sheet === "min" ? "half" : "min" } : { ...u, minimized: !u.minimized }))}
              title={minimized ? t(lang, "ins.expand") : t(lang, "ins.minimize")}
              aria-label={minimized ? t(lang, "ins.expand") : t(lang, "ins.minimize")}
            >
              {minimized ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
            <button type="button" className="ins-btn ins-btn--exit" onClick={exit} title={t(lang, "ins.exit")} data-testid="ins-exit">
              <Power size={15} /> <span>{t(lang, "ins.exitShort")}</span>
            </button>
          </div>
        </header>

        {!minimized ? (
          <>
            {target ? (
              <div className="ins-target">
                <code className="ins-chip" title={describeElement(target)}>{describeElement(target)}</code>
                <Breadcrumb el={target} onSelect={(el) => selectElement(el)} />
              </div>
            ) : null}
            <nav className="ins-tabs" role="tablist">
              {([
                ["styles", SlidersHorizontal],
                ["classes", Tag],
                ["box", Box],
                ["changes", History],
              ] as const).map(([id, Icon]) => (
                <button key={id} type="button" role="tab" aria-selected={tab === id} className="ins-tab" onClick={() => setTab(id)} data-testid={`ins-tab-${id}`}>
                  <Icon size={14} /> {t(lang, `ins.tab.${id}`)}
                  {id === "changes" && dirty ? <span className="ins-badge">●</span> : null}
                </button>
              ))}
            </nav>
            <div className="ins-body">
              {!target && !sel ? <EmptyState lang={lang} armed={armed} onArm={toggleArm} /> : null}
              {tab === "styles" && (target || sel) ? (
                <StylesTab
                  lang={lang}
                  target={target}
                  sel={sel} setSel={(s) => setSel(s)}
                  pseudo={pseudo} setPseudo={setPseudo}
                  scope={scope} setScope={setScope}
                  rows={rows} setRows={pushRule}
                  important={important} setImportant={(v) => { setImportant(v); pushRule(rows, v); }}
                  working={working}
                  tick={tick}
                  ruleKey={key}
                  openRule={openRule}
                  allowGoogleFonts={allowGoogleFonts}
                />
              ) : null}
              {tab === "classes" && target ? (
                <ClassesTab lang={lang} target={target} sel={sel} working={working} setWorking={setWorking} onEditClass={(c) => { setSel(`.${c}`); setPseudo(""); setTab("styles"); }} tick={tick} />
              ) : null}
              {tab === "box" && target ? (
                <BoxTab lang={lang} target={target} onCopy={(prop, value) => { setTab("styles"); pushRule([...rows.filter((r) => r.prop !== prop), { prop, value, important: false, enabled: true }]); }} />
              ) : null}
              {tab === "changes" ? (
                <ChangesTab lang={lang} working={working} store={store} onOpen={(r) => { setSel(r.selector); setPseudo(r.state); setScope(r.scope); setTab("styles"); }} setWorking={setWorking} />
              ) : null}
              {(tab === "classes" || tab === "box") && !target ? <p className="ins-muted ins-pad">{t(lang, "ins.needElement")}</p> : null}
            </div>
            <footer className="ins-foot">
              <span className={`ins-status ${dirty ? "is-dirty" : ""}`} role="status">
                {dirty ? t(lang, "ins.unsaved") : status || t(lang, "ins.allSaved")}
              </span>
              <button type="button" className="ins-btn" disabled={!dirty} onClick={discard} data-testid="ins-discard">
                <RotateCcw size={14} /> {t(lang, "ins.discard")}
              </button>
              <button type="button" className="ins-btn ins-btn--primary" disabled={!dirty} onClick={save} data-testid="ins-save">
                <Check size={14} /> {t(lang, "ins.save")}
              </button>
            </footer>
          </>
        ) : null}
      </section>
    </>
  );
}

/* ---------------------------------------------------------- chrome bits */

function SheetGrip({ ui, setUi }: { ui: UiState; setUi: (f: (u: UiState) => UiState) => void }) {
  const start = useRef<{ y: number; h: number } | null>(null);
  return (
    <div
      className="ins-grip"
      role="separator"
      aria-orientation="horizontal"
      onPointerDown={(e) => {
        const sheet = (e.currentTarget.parentElement as HTMLElement);
        start.current = { y: e.clientY, h: sheet.getBoundingClientRect().height };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const sheet = (e.currentTarget.parentElement as HTMLElement);
        const h = Math.max(56, Math.min(window.innerHeight * 0.92, start.current.h + (start.current.y - e.clientY)));
        sheet.style.height = `${h}px`;
      }}
      onPointerUp={(e) => {
        if (!start.current) return;
        const sheet = (e.currentTarget.parentElement as HTMLElement);
        const h = sheet.getBoundingClientRect().height;
        const moved = Math.abs(start.current.y - e.clientY) > 6;
        start.current = null;
        sheet.style.height = "";
        const vh = window.innerHeight;
        const next: SheetSize = !moved
          ? (ui.sheet === "min" ? "half" : ui.sheet === "half" ? "full" : "half")
          : h < vh * 0.22 ? "min" : h < vh * 0.7 ? "half" : "full";
        setUi((u) => ({ ...u, sheet: next }));
      }}
    >
      <span />
    </div>
  );
}

function ResizeEdge({ ui, setUi }: { ui: UiState; setUi: (f: (u: UiState) => UiState) => void }) {
  const start = useRef<{ x: number; w: number } | null>(null);
  return (
    <div
      className="ins-resize"
      role="separator"
      aria-orientation="vertical"
      onPointerDown={(e) => { start.current = { x: e.clientX, w: ui.width }; e.currentTarget.setPointerCapture(e.pointerId); }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const dx = ui.dock === "right" ? start.current.x - e.clientX : e.clientX - start.current.x;
        const w = Math.max(300, Math.min(640, start.current.w + dx));
        setUi((u) => ({ ...u, width: w }));
      }}
      onPointerUp={() => { start.current = null; }}
    />
  );
}

function Breadcrumb({ el, onSelect }: { el: Element; onSelect: (el: Element) => void }) {
  const ref = useRef<HTMLElement>(null);
  // Keep the selected element (the last crumb) in view.
  useEffect(() => { if (ref.current) ref.current.scrollLeft = ref.current.scrollWidth; }, [el]);
  const chain: Element[] = [];
  let node: Element | null = el;
  while (node && node !== document.documentElement && chain.length < 5) { chain.unshift(node); node = node.parentElement; }
  return (
    <nav className="ins-crumbs" aria-label="DOM" ref={ref}>
      <ListTree size={13} />
      {chain.map((n, i) => (
        <button key={i} type="button" className={`ins-crumb ${n === el ? "is-current" : ""}`} onClick={() => onSelect(n)} title={describeElement(n)}>
          {describeElement(n)}
        </button>
      ))}
    </nav>
  );
}

function EmptyState({ lang, armed, onArm }: { lang: Lang; armed: boolean; onArm: () => void }) {
  return (
    <div className="ins-empty">
      <p className="ins-empty__title">{t(lang, "ins.emptyTitle")}</p>
      <ul className="ins-gestures">
        <li><kbd>Ctrl</kbd> + <kbd>{t(lang, "ap.edit.rightClick")}</kbd> <span>{t(lang, "ap.edit.gestureMouse")}</span></li>
        <li><kbd>{t(lang, "ap.edit.longTap")}</kbd> <span>{t(lang, "ap.edit.gestureTouch")}</span></li>
        <li><kbd>⌖</kbd> <span>{t(lang, "ap.edit.gestureTap")}</span></li>
      </ul>
      <button type="button" className={`ins-btn ins-btn--primary ${armed ? "is-active" : ""}`} onClick={onArm}>
        <Crosshair size={15} /> {armed ? t(lang, "ins.armedShort") : t(lang, "ins.pick")}
      </button>
    </div>
  );
}

/* ================================================================ styles */

type StylesProps = {
  lang: Lang;
  target: Element | null;
  sel: string; setSel: (s: string) => void;
  pseudo: string; setPseudo: (s: string) => void;
  scope: StyleScope; setScope: (s: StyleScope) => void;
  rows: Declaration[]; setRows: (r: Declaration[]) => void;
  important: boolean; setImportant: (v: boolean) => void;
  working: StyleOverrides;
  tick: number;
  ruleKey: string;
  openRule: (selector: string, state: string, initial?: Declaration[]) => void;
  allowGoogleFonts: boolean;
};

function StylesTab(p: StylesProps) {
  const { lang, target } = p;
  const [selDraft, setSelDraft] = useState(p.sel);
  useEffect(() => setSelDraft(p.sel), [p.sel]);
  const [customState, setCustomState] = useState("");
  const [raw, setRaw] = useState(false);
  const [showQuick, setShowQuick] = useState(true);
  const [ruleFilter, setRuleFilter] = useState("");

  const options = useMemo(() => (target ? selectorOptions(target) : []), [target, p.tick]);
  const matchCount = countMatches(baseSelector(p.sel.split(",")[0] ?? p.sel));
  // Recomputed on selection and after each save (walking every stylesheet
  // on each keystroke would make typing sluggish on phones).
  const rules = useMemo(() => (target ? matchedRules(target) : []), [target, p.tick]);
  const filteredRules = rules.filter((r) => !ruleFilter || r.selector.toLowerCase().includes(ruleFilter.toLowerCase()) || r.declarations.toLowerCase().includes(ruleFilter.toLowerCase()));

  const commitSelector = () => {
    const clean = sanitizeSelector(selDraft);
    if (clean && clean !== p.sel) p.setSel(clean);
    else setSelDraft(p.sel);
  };
  const editRule = (r: MatchedRule) => {
    p.openRule(baseSelector(r.selector), sanitizeState(stateOf(r.selector)), parseDeclarations(r.declarations));
  };

  const scopeLabel = (o: { kind: string; count: number }) => `${t(lang, `ins.sel.${o.kind}`)} · ${o.count}×`;

  return (
    <div className="ins-styles">
      <div className="ins-field">
        <label className="ins-label">{t(lang, "ins.selector")}</label>
        {options.length ? (
          <select className="ins-select" value={options.some((o) => o.selector === p.sel) ? p.sel : ""} onChange={(e) => e.target.value && p.setSel(e.target.value)} data-testid="ins-scope-select">
            {!options.some((o) => o.selector === p.sel) ? <option value="">{t(lang, "ins.sel.custom")}</option> : null}
            {options.map((o) => (
              <option key={o.selector} value={o.selector}>{scopeLabel(o)} — {o.selector.length > 60 ? `…${o.selector.slice(-58)}` : o.selector}</option>
            ))}
          </select>
        ) : null}
        <div className="ins-selector">
          <input
            className="ins-input ins-mono"
            value={selDraft}
            spellCheck={false}
            onChange={(e) => setSelDraft(e.target.value)}
            onBlur={commitSelector}
            onKeyDown={(e) => { if (e.key === "Enter") commitSelector(); }}
            aria-label={t(lang, "ins.selector")}
            data-testid="ins-selector"
          />
          <span className={`ins-count ${matchCount === 1 ? "is-one" : matchCount <= 0 ? "is-zero" : ""}`} title={t(lang, "ins.matches")}>
            {matchCount < 0 ? "✕" : `${matchCount}×`}
          </span>
        </div>
      </div>

      <div className="ins-field">
        <label className="ins-label">{t(lang, "ins.state")}</label>
        <div className="ins-states" role="radiogroup" aria-label={t(lang, "ins.state")}>
          {STYLE_STATES.map((s) => {
            const has = Boolean(findRule(p.working, p.sel, s.id, p.scope));
            return (
              <button key={s.id || "normal"} type="button" role="radio" aria-checked={p.pseudo === s.id} className={`ins-state is-${s.kind} ${has ? "has-rule" : ""}`} onClick={() => p.setPseudo(s.id)} data-testid={`ins-state-${s.id || "normal"}`}>
                {s.label}
              </button>
            );
          })}
          <input
            className="ins-input ins-mono ins-state-custom"
            placeholder=":nth-child(2)"
            value={customState}
            onChange={(e) => setCustomState(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { const s = sanitizeState(customState); if (s) p.setPseudo(s); } }}
            aria-label={t(lang, "ins.customState")}
          />
        </div>
      </div>

      <div className="ins-row ins-row--wrap">
        <label className="ins-label ins-inline">
          {t(lang, "ins.scope")}
          <select className="ins-select ins-select--sm" value={p.scope} onChange={(e) => p.setScope(e.target.value as StyleScope)} data-testid="ins-device-scope">
            {SCOPES.map((s) => <option key={s} value={s}>{t(lang, `ins.scope.${s}`)}</option>)}
          </select>
        </label>
        <label className="ins-check" title={t(lang, "ins.importantHint")}>
          <input type="checkbox" checked={p.important} onChange={(e) => p.setImportant(e.target.checked)} data-testid="ins-important" />
          !important
        </label>
        <button type="button" className={`ins-btn ins-btn--sm ${raw ? "is-active" : ""}`} onClick={() => setRaw((r) => !r)} data-testid="ins-raw-toggle">
          <Code2 size={13} /> {raw ? t(lang, "ins.rows") : t(lang, "ins.source")}
        </button>
      </div>

      <div className="ins-rule">
        <div className="ins-rule__head ins-mono">
          <span className="tok-sel">{p.sel || "…"}</span><span className="tok-pseudo">{p.pseudo}</span> <span className="tok-brace">{"{"}</span>
        </div>
        {raw ? (
          <RawEditor key={p.ruleKey} rows={p.rows} onChange={p.setRows} lang={lang} />
        ) : (
          <DeclRows key={p.ruleKey} rows={p.rows} onChange={p.setRows} lang={lang} target={target} />
        )}
        <div className="ins-rule__foot ins-mono tok-brace">{"}"}</div>
      </div>

      <div className="ins-group">
        <button type="button" className="ins-group__head" onClick={() => setShowQuick((s) => !s)} aria-expanded={showQuick}>
          <SlidersHorizontal size={13} /> {t(lang, "ins.quick")} {showQuick ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
        {showQuick ? <QuickControls rows={p.rows} onChange={p.setRows} target={target} lang={lang} allowGoogleFonts={p.allowGoogleFonts} /> : null}
      </div>

      {target ? (
        <div className="ins-group">
          <div className="ins-group__head is-static">
            <Layers size={13} /> {t(lang, "ins.matched")} <span className="ins-muted">({rules.length})</span>
          </div>
          <label className="ins-search">
            <Search size={13} />
            <input value={ruleFilter} onChange={(e) => setRuleFilter(e.target.value)} placeholder={t(lang, "ins.filterRules")} aria-label={t(lang, "ins.filterRules")} />
          </label>
          <div className="ins-matched" data-testid="ins-matched">
            {filteredRules.map((r, i) => (
              <article key={`${r.selector}-${r.order}-${i}`} className={`ins-src ${r.user ? "is-user" : ""}`}>
                <header className="ins-src__head">
                  <code className="ins-mono"><SelectorTokens selector={r.selector} /></code>
                  <span className="ins-src__meta">{r.media ? <span className="ins-media">{r.media}</span> : null}<span>{r.source}</span></span>
                </header>
                <pre className="ins-src__code ins-mono">{prettyDeclarations(r.declarations)}</pre>
                <div className="ins-src__actions">
                  <button type="button" className="ins-btn ins-btn--sm" onClick={() => editRule(r)} data-testid="ins-edit-source">
                    <Code2 size={13} /> {t(lang, "ins.editSource")}
                  </button>
                  <button type="button" className="ins-btn ins-btn--sm" onClick={() => void navigator.clipboard?.writeText(`${r.selector} {\n${prettyDeclarations(r.declarations).replace(/^/gm, "  ")}\n}`)}>
                    <Copy size={13} /> {t(lang, "ins.copy")}
                  </button>
                </div>
              </article>
            ))}
            {filteredRules.length === 0 ? <p className="ins-muted">{t(lang, "ins.noRules")}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SelectorTokens({ selector }: { selector: string }) {
  const parts = selector.split(/(::?[\w-]+(?:\([^)]*\))?|\.[\w\\:/[\]-]+|#[\w-]+|\[[^\]]+\])/g).filter(Boolean);
  return (
    <>
      {parts.map((part, i) => {
        const cls = part.startsWith("::") || part.startsWith(":") ? "tok-pseudo" : part.startsWith(".") ? "tok-class" : part.startsWith("#") ? "tok-id" : part.startsWith("[") ? "tok-attr" : "tok-sel";
        return <span key={i} className={cls}>{part}</span>;
      })}
    </>
  );
}

/* ------------------------------------------------------ declaration rows */

const LIST_ID = "ins-css-props";

function isColorProp(prop: string) {
  return /color|background$|^fill$|^stroke$|border(-\w+)?$|outline$|shadow/.test(prop);
}

function nudge(value: string, delta: number): string {
  const m = /(-?\d*\.?\d+)([a-z%]*)/i.exec(value);
  if (!m) return value;
  const n = parseFloat(m[1]) + delta;
  const rounded = Math.round(n * 1000) / 1000;
  return value.slice(0, m.index) + String(rounded) + m[2] + value.slice(m.index + m[0].length);
}

function valid(prop: string, value: string): boolean {
  if (!prop || !value) return true;
  if (prop.startsWith("--")) return true;
  try { return typeof CSS === "undefined" || !CSS.supports ? true : CSS.supports(prop, value); } catch { return true; }
}

function DeclRows({ rows, onChange, lang, target }: { rows: Declaration[]; onChange: (r: Declaration[]) => void; lang: Lang; target: Element | null }) {
  // Local rows keep half-typed entries (a property without a value yet).
  const [local, setLocal] = useState<Declaration[]>(rows);
  const lastPushed = useRef(serializeDeclarations(rows));
  useEffect(() => {
    const incoming = serializeDeclarations(rows);
    if (incoming !== lastPushed.current) { setLocal(rows); lastPushed.current = incoming; }
  }, [rows]);
  const focusLast = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusLast.current) {
      focusLast.current = false;
      const inputs = listRef.current?.querySelectorAll<HTMLInputElement>(".ins-decl__prop");
      inputs?.[inputs.length - 1]?.focus();
    }
  });

  const update = (next: Declaration[]) => {
    setLocal(next);
    const complete = next.filter((d) => d.prop.trim() && d.value.trim());
    lastPushed.current = serializeDeclarations(complete);
    onChange(complete);
  };
  const patch = (i: number, p: Partial<Declaration>) => update(local.map((d, j) => (j === i ? { ...d, ...p } : d)));
  const add = () => { focusLast.current = true; setLocal([...local, { prop: "", value: "", important: false, enabled: true }]); };
  const pasteInto = (i: number, text: string) => {
    const parsed = parseDeclarations(text);
    if (!parsed.length) return false;
    update([...local.slice(0, i), ...parsed, ...local.slice(i + 1)]);
    return true;
  };

  return (
    <div className="ins-decls" ref={listRef}>
      <datalist id={LIST_ID}>{CSS_PROPERTIES.map((p) => <option key={p} value={p} />)}</datalist>
      {local.map((d, i) => {
        const ok = valid(d.prop, d.value);
        const colorToken = isColorProp(d.prop) ? d.value.split(/\s(?![^(]*\))/).find((part) => cssColorToHex(part)) : undefined;
        const colorish = colorToken ? cssColorToHex(colorToken) : null;
        return (
          <div key={i} className={`ins-decl ${d.enabled ? "" : "is-off"} ${ok ? "" : "is-invalid"}`} data-testid="ins-decl">
            <input type="checkbox" className="ins-decl__on" checked={d.enabled} onChange={(e) => patch(i, { enabled: e.target.checked })} aria-label={t(lang, "ins.enable")} />
            <input
              className="ins-decl__prop ins-mono"
              list={LIST_ID}
              value={d.prop}
              placeholder={t(lang, "ins.property")}
              spellCheck={false}
              onChange={(e) => patch(i, { prop: e.target.value.trim() })}
              onPaste={(e) => { const text = e.clipboardData.getData("text"); if (text.includes(":") && pasteInto(i, text)) e.preventDefault(); }}
              aria-label={t(lang, "ins.property")}
            />
            <span className="ins-decl__colon">:</span>
            <span className="ins-decl__valwrap">
              {colorish ? (
                <label className="ins-decl__swatch" style={{ background: colorish }} title={colorish}>
                  <input type="color" value={colorish} onChange={(e) => patch(i, { value: colorToken ? d.value.replace(colorToken, e.target.value) : e.target.value })} aria-label="color" />
                </label>
              ) : null}
              <input
                className="ins-decl__value ins-mono"
                value={d.value}
                placeholder={target && d.prop ? getComputedStyle(target).getPropertyValue(d.prop) : t(lang, "ins.value")}
                spellCheck={false}
                onChange={(e) => patch(i, { value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                    const step = (e.shiftKey ? 10 : e.altKey ? 0.1 : 1) * (e.key === "ArrowUp" ? 1 : -1);
                    const next = nudge(d.value, step);
                    if (next !== d.value) { e.preventDefault(); patch(i, { value: next }); }
                  }
                  if (e.key === "Enter") add();
                }}
                aria-label={t(lang, "ins.value")}
                aria-invalid={!ok}
                title={ok ? undefined : t(lang, "ins.invalid")}
              />
            </span>
            <button type="button" className={`ins-decl__imp ${d.important ? "is-on" : ""}`} onClick={() => patch(i, { important: !d.important })} title="!important" aria-pressed={d.important}>!</button>
            <button type="button" className="ins-decl__del" onClick={() => update(local.filter((_, j) => j !== i))} aria-label={t(lang, "ins.delete")} title={t(lang, "ins.delete")}><X size={13} /></button>
          </div>
        );
      })}
      <button type="button" className="ins-add" onClick={add} data-testid="ins-add-prop">
        <Plus size={13} /> {t(lang, "ins.addProp")}
      </button>
    </div>
  );
}

function RawEditor({ rows, onChange, lang }: { rows: Declaration[]; onChange: (r: Declaration[]) => void; lang: Lang }) {
  const [text, setText] = useState(() => serializeDeclarations(rows));
  const gutter = useRef<HTMLDivElement>(null);
  const lastPushed = useRef(text);
  useEffect(() => {
    const incoming = serializeDeclarations(rows);
    if (incoming !== serializeDeclarations(parseDeclarations(lastPushed.current))) { setText(incoming); lastPushed.current = incoming; }
  }, [rows]);
  const lines = Math.max(3, text.split("\n").length);
  return (
    <div className="ins-raw">
      <div className="ins-raw__gutter ins-mono" ref={gutter} aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => <div key={i}>{i + 1}</div>)}
      </div>
      <textarea
        className="ins-raw__text ins-mono"
        value={text}
        spellCheck={false}
        rows={Math.min(18, lines + 1)}
        onScroll={(e) => { if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop; }}
        onChange={(e) => { setText(e.target.value); lastPushed.current = e.target.value; onChange(parseDeclarations(e.target.value)); }}
        onKeyDown={(e) => {
          if (e.key === "Tab") {
            e.preventDefault();
            const el = e.currentTarget;
            const { selectionStart: s, selectionEnd: en } = el;
            const next = `${text.slice(0, s)}  ${text.slice(en)}`;
            setText(next);
            requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = s + 2; });
          }
        }}
        aria-label={t(lang, "ins.source")}
        placeholder={"color: #fff;\nbackground: linear-gradient(90deg, #06f, #90f);\n/* padding: 4px; */"}
        data-testid="ins-raw"
      />
    </div>
  );
}

/* ------------------------------------------------------ quick controls */

function QuickControls({ rows, onChange, target, lang, allowGoogleFonts }: { rows: Declaration[]; onChange: (r: Declaration[]) => void; target: Element | null; lang: Lang; allowGoogleFonts: boolean }) {
  const get = (prop: string) => rows.find((r) => r.prop === prop && r.enabled)?.value ?? "";
  const computed = (prop: string) => (target ? getComputedStyle(target).getPropertyValue(prop) : "");
  const set = (prop: string, value: string) => {
    const others = rows.filter((r) => r.prop !== prop);
    onChange(value ? [...others, { prop, value, important: false, enabled: true }] : others);
  };
  const colorOf = (prop: string) => cssColorToHex(get(prop)) ?? cssColorToHex(computed(prop)) ?? "#000000";
  const px = (prop: string) => {
    const v = get(prop) || computed(prop);
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  };
  // Google families only with consent (App loads the ones rules use).
  const sans = FONTS.filter((f) => f.category !== "theme" && (!f.google || allowGoogleFonts));
  return (
    <div className="ins-quick">
      <label className="ins-q">
        <span>{t(lang, "ins.q.color")}</span>
        <input type="color" value={colorOf("color")} onChange={(e) => set("color", e.target.value)} />
        {get("color") ? <button type="button" className="ins-x" onClick={() => set("color", "")} aria-label="reset"><X size={11} /></button> : null}
      </label>
      <label className="ins-q">
        <span>{t(lang, "ins.q.background")}</span>
        <input type="color" value={colorOf("background-color")} onChange={(e) => set("background-color", e.target.value)} />
        {get("background-color") ? <button type="button" className="ins-x" onClick={() => set("background-color", "")} aria-label="reset"><X size={11} /></button> : null}
      </label>
      <label className="ins-q ins-q--wide">
        <span>{t(lang, "ins.q.fontSize")} <em>{px("font-size").toFixed(0)}px</em></span>
        <input type="range" min={8} max={48} step={1} value={px("font-size")} onChange={(e) => set("font-size", `${e.target.value}px`)} />
      </label>
      <label className="ins-q ins-q--wide">
        <span>{t(lang, "ins.q.weight")}</span>
        <select value={get("font-weight")} onChange={(e) => set("font-weight", e.target.value)}>
          <option value="">—</option>
          {[300, 400, 500, 600, 700, 800].map((w) => <option key={w} value={String(w)}>{w}</option>)}
        </select>
      </label>
      <label className="ins-q ins-q--wide">
        <span>{t(lang, "ins.q.font")}</span>
        <select value={sans.find((f) => f.stack === get("font-family"))?.id ?? ""} onChange={(e) => { const f = sans.find((x) => x.id === e.target.value); if (f?.google) ensureFonts([f.id], allowGoogleFonts); set("font-family", f?.stack ?? ""); }}>
          <option value="">—</option>
          {sans.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
      </label>
      <label className="ins-q ins-q--wide">
        <span>{t(lang, "ins.q.radius")} <em>{px("border-radius").toFixed(0)}px</em></span>
        <input type="range" min={0} max={40} step={1} value={px("border-radius")} onChange={(e) => set("border-radius", `${e.target.value}px`)} />
      </label>
      <label className="ins-q ins-q--wide">
        <span>{t(lang, "ins.q.padding")} <em>{px("padding-top").toFixed(0)}px</em></span>
        <input type="range" min={0} max={48} step={1} value={px("padding-top")} onChange={(e) => set("padding", `${e.target.value}px`)} />
      </label>
      <label className="ins-q ins-q--wide">
        <span>{t(lang, "ins.q.opacity")} <em>{Math.round((parseFloat(get("opacity") || computed("opacity") || "1") || 0) * 100)}%</em></span>
        <input type="range" min={0} max={1} step={0.05} value={parseFloat(get("opacity") || computed("opacity") || "1")} onChange={(e) => set("opacity", e.target.value)} />
      </label>
      <label className="ins-q ins-q--toggle">
        <input type="checkbox" checked={get("display") === "none"} onChange={(e) => set("display", e.target.checked ? "none" : "")} />
        <span>{t(lang, "ins.q.hide")}</span>
      </label>
    </div>
  );
}

/* ================================================================ classes */

function ClassesTab({ lang, target, sel, working, setWorking, onEditClass, tick }: {
  lang: Lang; target: Element; sel: string; working: StyleOverrides;
  setWorking: (f: (w: StyleOverrides) => StyleOverrides) => void; onEditClass: (c: string) => void; tick: number;
}) {
  const [query, setQuery] = useState("");
  const [peek, setPeek] = useState<string | null>(null);
  const [, force] = useState(0);
  useEffect(() => {
    // The element's class list changes as patches preview; re-render on it.
    const mo = new MutationObserver(() => force((x) => x + 1));
    mo.observe(target, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, [target]);
  const patch = working.classes.find((c) => c.selector === sel);
  const present = Array.from(target.classList);
  const removed = patch?.remove ?? [];
  const added = new Set(patch?.add ?? []);
  const all = useMemo(() => stylesheetClasses(), [tick]);
  const q = query.trim().replace(/^\./, "").toLowerCase();
  const suggestions = q ? all.filter((c) => c.toLowerCase().includes(q)).slice(0, 60) : all.slice(0, 40);
  const exists = all.includes(q);
  const count = countMatches(sel);
  const apply = (cls: string, op: "add" | "remove" | "reset") => setWorking((w) => patchClass(w, sel, cls, op));

  return (
    <div className="ins-classes">
      <p className="ins-muted">{t(lang, "ins.classes.appliesTo")} <code className="ins-mono">{sel}</code> ({count}×)</p>
      <div className="ins-chips" data-testid="ins-class-chips">
        {present.map((c) => (
          <span key={c} className={`ins-cls ${added.has(c) ? "is-added" : ""}`}>
            <button type="button" className="ins-cls__name ins-mono" onClick={() => onEditClass(c)} title={t(lang, "ins.classes.edit")}>.{c}</button>
            <button type="button" className="ins-cls__x" onClick={() => apply(c, added.has(c) ? "reset" : "remove")} aria-label={t(lang, "ins.classes.remove")} title={t(lang, "ins.classes.remove")}><X size={11} /></button>
          </span>
        ))}
        {removed.map((c) => (
          <span key={`r-${c}`} className="ins-cls is-removed">
            <span className="ins-cls__name ins-mono">.{c}</span>
            <button type="button" className="ins-cls__x" onClick={() => apply(c, "reset")} aria-label={t(lang, "ins.classes.restore")} title={t(lang, "ins.classes.restore")}><Undo2 size={11} /></button>
          </span>
        ))}
        {present.length === 0 && removed.length === 0 ? <span className="ins-muted">{t(lang, "ins.classes.none")}</span> : null}
      </div>

      <div className="ins-field">
        <label className="ins-label">{t(lang, "ins.classes.add")}</label>
        <label className="ins-search">
          <Search size={13} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t(lang, "ins.classes.search").replace("{n}", String(all.length))}
            onKeyDown={(e) => { if (e.key === "Enter" && q) { apply(sanitizeClassName(q), "add"); setQuery(""); } }}
            aria-label={t(lang, "ins.classes.add")}
            data-testid="ins-class-search"
          />
        </label>
        {q && !exists ? (
          <button type="button" className="ins-btn ins-btn--sm" onClick={() => { const c = sanitizeClassName(q); apply(c, "add"); onEditClass(c); setQuery(""); }} data-testid="ins-class-create">
            <Plus size={13} /> {t(lang, "ins.classes.create").replace("{c}", sanitizeClassName(q))}
          </button>
        ) : null}
        <div className="ins-suggest">
          {suggestions.map((c) => (
            <div key={c} className="ins-suggest__row">
              <button type="button" className="ins-suggest__name ins-mono" onClick={() => setPeek(peek === c ? null : c)} aria-expanded={peek === c}>.{c}</button>
              <button type="button" className="ins-btn ins-btn--sm" disabled={present.includes(c)} onClick={() => apply(c, "add")} data-testid={`ins-class-add-${c}`}>
                <Plus size={12} /> {t(lang, "ins.classes.addShort")}
              </button>
              {peek === c ? (
                <pre className="ins-src__code ins-mono">{classRules(c).map((r) => `${r.media ? `${r.media} ` : ""}${r.selector} {\n${prettyDeclarations(r.declarations).replace(/^/gm, "  ")}\n}`).join("\n\n") || "—"}</pre>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ==================================================================== box */

function BoxTab({ lang, target, onCopy }: { lang: Lang; target: Element; onCopy: (prop: string, value: string) => void }) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => force((x) => x + 1), 800);
    return () => window.clearInterval(id);
  }, []);
  const b = boxModel(target);
  const f = (n: number) => (Math.round(n * 10) / 10).toString();
  const snap = computedSnapshot(target);
  return (
    <div className="ins-boxtab">
      <div className="ins-box" aria-label="box model">
        <div className="ins-box__m"><span className="ins-box__tag">margin</span>
          <span className="ins-box__t">{f(b.margin[0])}</span><span className="ins-box__r">{f(b.margin[1])}</span><span className="ins-box__b">{f(b.margin[2])}</span><span className="ins-box__l">{f(b.margin[3])}</span>
          <div className="ins-box__bd"><span className="ins-box__tag">border</span>
            <span className="ins-box__t">{f(b.border[0])}</span><span className="ins-box__r">{f(b.border[1])}</span><span className="ins-box__b">{f(b.border[2])}</span><span className="ins-box__l">{f(b.border[3])}</span>
            <div className="ins-box__p"><span className="ins-box__tag">padding</span>
              <span className="ins-box__t">{f(b.padding[0])}</span><span className="ins-box__r">{f(b.padding[1])}</span><span className="ins-box__b">{f(b.padding[2])}</span><span className="ins-box__l">{f(b.padding[3])}</span>
              <div className="ins-box__c">{f(b.width - b.border[1] - b.border[3] - b.padding[1] - b.padding[3])} × {f(b.height - b.border[0] - b.border[2] - b.padding[0] - b.padding[2])}</div>
            </div>
          </div>
        </div>
      </div>
      <table className="ins-computed">
        <tbody>
          {snap.map(({ prop, value }) => {
            const hex = /color/.test(prop) ? cssColorToHex(value) : null;
            return (
              <tr key={prop}>
                <th className="ins-mono">{prop}</th>
                <td className="ins-mono">{hex ? <span className="ins-mini-swatch" style={{ background: hex }} /> : null}{value || "—"}</td>
                <td><button type="button" className="ins-btn ins-btn--icon ins-btn--xs" onClick={() => onCopy(prop, value)} title={t(lang, "ins.copyToRule")} aria-label={t(lang, "ins.copyToRule")}><Plus size={12} /></button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ================================================================ changes */

function ChangesTab({ lang, working, store, onOpen, setWorking }: {
  lang: Lang; working: StyleOverrides; store: StyleOverrides;
  onOpen: (r: StyleOverrides["rules"][number]) => void; setWorking: (f: (w: StyleOverrides) => StyleOverrides) => void;
}) {
  const savedIds = new Set(store.rules.map((r) => `${r.id}:${r.declarations}:${r.enabled}:${r.important}`));
  const rules = [...working.rules].sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <div className="ins-changes">
      {rules.length === 0 && working.classes.length === 0 ? <p className="ins-muted">{t(lang, "ap.edit.none")}</p> : null}
      <ul className="ins-list">
        {rules.map((r) => {
          const unsaved = !savedIds.has(`${r.id}:${r.declarations}:${r.enabled}:${r.important}`);
          return (
            <li key={r.id} className={`ins-list__row ${r.enabled ? "" : "is-off"}`}>
              <button type="button" className="ins-list__main" onClick={() => onOpen(r)}>
                <code className="ins-mono"><SelectorTokens selector={`${r.selector}${r.state}`} /></code>
                <span className="ins-muted">{r.scope !== "all" ? `${t(lang, `ins.scope.${r.scope}`)} · ` : ""}{parseDeclarations(r.declarations).length} {t(lang, "ins.props")}{unsaved ? ` · ${t(lang, "ins.unsavedShort")}` : ""}</span>
              </button>
              <button type="button" className="ins-btn ins-btn--icon ins-btn--xs" onClick={() => setWorking((w) => ({ ...w, rules: w.rules.map((x) => (x.id === r.id ? { ...x, enabled: !x.enabled } : x)) }))} aria-label={r.enabled ? t(lang, "ins.disable") : t(lang, "ins.enable")}>
                {r.enabled ? <Eye size={13} /> : <EyeOff size={13} />}
              </button>
              <button type="button" className="ins-btn ins-btn--icon ins-btn--xs is-danger" onClick={() => setWorking((w) => ({ ...w, rules: w.rules.filter((x) => x.id !== r.id) }))} aria-label={t(lang, "ins.delete")}>
                <Trash2 size={13} />
              </button>
            </li>
          );
        })}
        {working.classes.map((p) => (
          <li key={p.id} className="ins-list__row">
            <div className="ins-list__main">
              <code className="ins-mono">{p.selector}</code>
              <span className="ins-muted">{[...p.add.map((c) => `+.${c}`), ...p.remove.map((c) => `−.${c}`)].join(" ")}</span>
            </div>
            <button type="button" className="ins-btn ins-btn--icon ins-btn--xs is-danger" onClick={() => setWorking((w) => ({ ...w, classes: w.classes.filter((x) => x.id !== p.id) }))} aria-label={t(lang, "ins.delete")}>
              <Trash2 size={13} />
            </button>
          </li>
        ))}
      </ul>
      <div className="ins-row">
        <button type="button" className="ins-btn" disabled={!styleStore.canUndo()} onClick={() => styleStore.undo()}>
          <Undo2 size={14} /> {t(lang, "ins.undo")}
        </button>
      </div>
      <p className="ins-muted ins-small">{t(lang, "ins.changesHint")}</p>
    </div>
  );
}
