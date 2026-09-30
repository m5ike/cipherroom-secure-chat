// M5cet operator console — page layouts you arrange yourself (6.1).
//
// A page hands its panels (cards) to M5Layout.mount(); they sit side by side
// in rows. Locked (the default) the page looks as arranged; after the lock
// icon is pressed (unlocked) every panel shows a title bar to drag it by, and
// edges to pull:
//
//   move       drag the title bar onto another panel (before / after it),
//              or ← → on the focused bar
//   resize     the right edge sets the width, the bottom edge the height
//              (double-click: back to "fill" / auto); Shift+← → and
//              Alt+↑ ↓ on the bar do it from the keyboard
//   new row    a panel can start a row of its own
//   fill       a panel takes what its row has left
//   hide       out of the page; the bar above lists it to bring it back
//   align      top · centre · bottom · stretch; spacing compact · normal · roomy
//
// Locking saves the arrangement to the administrator's console settings
// (M5Console.setPref("layouts") → /api/admin/me/prefs); "Reset" goes back to
// the page's defaults. Narrow screens stack the panels whatever is saved.
//
// Same rules as console.js: DOM nodes and textContent, never innerHTML.

(() => {
  "use strict";
  const C = window.M5Console;
  if (!C) return;
  const { h, clear, toast } = C;
  const I = (name, cls) => (window.M5Icons ? window.M5Icons.svg(name, cls || "ico") : h("span", {}, "·"));

  const ALIGNS = [["start", "align-start-vertical", "Top"], ["center", "align-center-vertical", "Centre"], ["end", "align-end-vertical", "Bottom"], ["stretch", "stretch-vertical", "Stretch (same height)"]];
  const GAPS = [[8, "Compact"], [14, "Normal"], [22, "Roomy"]];
  const MIN_W = 160, MIN_H = 120;

  /** While a page is unlocked, its draft survives the page drawing itself again. */
  const drafts = new Map();
  const listeners = new Set();

  const saved = (page) => ((C.pref && C.pref("layouts", {})) || {})[page] || null;
  const clone = (v) => JSON.parse(JSON.stringify(v));

  /** The page's state: its defaults, what was saved over them, the panels there are now. */
  function stateFor(page, panels, defaults) {
    const base = {
      order: panels.map((p) => p.id),
      w: Object.fromEntries(panels.map((p) => [p.id, p.basis ?? "fill"])),
      h: Object.fromEntries(panels.filter((p) => p.height).map((p) => [p.id, p.height])),
      breaks: panels.filter((p) => p.breakBefore).map((p) => p.id),
      hidden: [],
      align: defaults.align || "start",
      gap: defaults.gap || 14,
    };
    const s = drafts.get(page) || saved(page);
    if (!s) return base;
    const ids = new Set(panels.map((p) => p.id));
    const order = (s.order || []).filter((id) => ids.has(id));
    for (const id of base.order) if (!order.includes(id)) order.splice(Math.min(base.order.indexOf(id), order.length), 0, id);
    return {
      order,
      w: { ...base.w, ...Object.fromEntries(Object.entries(s.w || {}).filter(([id]) => ids.has(id))) },
      h: { ...base.h, ...Object.fromEntries(Object.entries(s.h || {}).filter(([id]) => ids.has(id))) },
      breaks: (s.breaks || base.breaks).filter((id) => ids.has(id)),
      hidden: (s.hidden || []).filter((id) => ids.has(id)),
      align: ["start", "center", "end", "stretch"].includes(s.align) ? s.align : base.align,
      gap: Number(s.gap) > 0 ? Number(s.gap) : base.gap,
    };
  }

  /**
   * Lays `panels` out in `root` and returns a handle: lockButton() for the
   * page's toolbar, editing, relayout(), destroy().
   *   panels: [{ id, title, el, basis: "fill" | px, min?: px, height?: px, breakBefore?, fixed? }]
   *   opts:   { page, title, align?, gap?, height? (the rows' height: "calc(100vh - 290px)"), onChange? }
   */
  function mount(root, panels, opts) {
    const page = opts.page;
    const defaults = { align: opts.align || "start", gap: opts.gap || 14 };
    let state = stateFor(page, panels, defaults);
    const byId = new Map(panels.map((p) => [p.id, p]));
    const wraps = new Map();
    const bar = h("div", { class: "pl-bar", role: "toolbar", "aria-label": `Layout of ${opts.title}` });
    let lockBtn = null;

    clear(root);
    root.classList.add("pl");
    if (opts.height) root.style.setProperty("--pl-height", opts.height);
    root.classList.toggle("pl--fixed-h", Boolean(opts.height));
    for (const p of panels) {
      const wrap = h("div", { class: "pl-panel", "data-pl": p.id });
      wrap.append(p.el);
      wraps.set(p.id, wrap);
      root.append(wrap);
    }
    root.before(bar);

    const editing = () => drafts.has(page);

    function apply() {
      root.style.setProperty("--pl-gap", `${state.gap}px`);
      root.dataset.align = state.align;
      for (const old of root.querySelectorAll(":scope > .pl-break")) old.remove();
      state.order.forEach((id, i) => {
        const wrap = wraps.get(id);
        if (!wrap) return;
        const p = byId.get(id);
        const w = state.w[id];
        const hgt = state.h[id];
        wrap.style.order = String(i * 2 + 1);
        wrap.style.flex = w === "fill" || w === undefined ? "1 1 0" : `0 0 ${Math.max(p.min || MIN_W, Number(w))}px`;
        wrap.style.minWidth = `${Math.min(p.min || MIN_W, 100000)}px`;
        wrap.style.height = hgt ? `${Math.max(MIN_H, Number(hgt))}px` : "";
        wrap.classList.toggle("pl-panel--h", Boolean(hgt));
        wrap.classList.toggle("pl-panel--hidden", state.hidden.includes(id));
        wrap.classList.toggle("pl-panel--fill", w === "fill" || w === undefined);
        if (state.breaks.includes(id) && i > 0) {
          const br = h("div", { class: "pl-break", "aria-hidden": "true" });
          br.style.order = String(i * 2);
          root.append(br);
        }
      });
      root.classList.toggle("pl--edit", editing());
      drawBar();
      for (const [id, wrap] of wraps) drawChrome(id, wrap);
      if (opts.onChange) opts.onChange(state);
    }

    /* ------------------------------------------------------ the bar */

    function drawBar() {
      clear(bar);
      bar.hidden = !editing();
      if (!editing()) return;
      const seg = (items, current, pick) => h("div", { class: "seg pl-seg" }, ...items.map(([v, icon, label]) => {
        const b = h("button", { type: "button", class: `pl-segbtn${String(current) === String(v) ? " is-on" : ""}`, "data-tip": label, "aria-label": label, "aria-pressed": String(current) === String(v) ? "true" : "false", onclick: () => pick(v) });
        if (icon) b.append(I(icon)); else b.append(label);
        return b;
      }));
      const hidden = state.hidden.map((id) => h("button", { type: "button", class: "pl-chip", "data-tip": "Show it again", onclick: () => { state.hidden = state.hidden.filter((x) => x !== id); keep(); } }, I("eye"), byId.get(id)?.title || id));
      bar.append(...[
        h("span", { class: "pl-bar__title" }, I("lock-open"), `Arranging ${opts.title}`),
        h("span", { class: "pl-bar__hint muted small" }, "Drag a panel by its title bar · pull its right or bottom edge · double-click an edge to reset it"),
        h("span", { class: "pl-bar__sep" }),
        h("span", { class: "muted small" }, "Align"), seg(ALIGNS, state.align, (v) => { state.align = v; keep(); }),
        h("span", { class: "muted small" }, "Spacing"), seg(GAPS.map(([v, l]) => [v, null, l]), state.gap, (v) => { state.gap = Number(v); keep(); }),
        hidden.length ? h("span", { class: "pl-bar__hidden" }, h("span", { class: "muted small" }, "Hidden:"), ...hidden) : null,
        h("span", { class: "pl-bar__grow" }),
        h("button", { type: "button", class: "btn btn--sm", "data-tip": "Back to how this page comes", onclick: reset }, I("rotate-ccw"), "Reset"),
        h("button", { type: "button", class: "btn btn--sm", "data-tip": "Leave without saving (Esc)", onclick: cancel }, "Cancel"),
        h("button", { type: "button", class: "btn btn--sm btn--primary", "data-tip": "Lock the layout and save it", onclick: lock }, I("lock"), "Lock & save"),
      ].filter(Boolean));
    }

    /* ------------------------------------------------- panel chrome */

    function drawChrome(id, wrap) {
      for (const old of wrap.querySelectorAll(":scope > .pl-head, :scope > .pl-rx, :scope > .pl-ry, :scope > .pl-rxy")) old.remove();
      if (!editing()) return;
      const p = byId.get(id);
      const i = state.order.indexOf(id);
      const fill = state.w[id] === "fill";
      const grip = h("button", { type: "button", class: "pl-grip", "aria-label": `${p.title}: drag to move; arrows move, Shift+arrows resize` }, I("grip-vertical"), h("span", { class: "pl-head__title" }, p.title),
        h("span", { class: "pl-head__size muted" }, fill ? "fill" : `${Math.round(Number(state.w[id]))} px`, state.h[id] ? ` × ${Math.round(Number(state.h[id]))}` : ""));
      grip.addEventListener("pointerdown", (e) => startMove(e, id));
      grip.addEventListener("keydown", (e) => keyOn(e, id));
      const tool = (icon, label, fn, on) => h("button", { type: "button", class: `pl-tool${on ? " is-on" : ""}`, "data-tip": label, "aria-label": label, "aria-pressed": on ? "true" : "false", onclick: fn }, I(icon));
      wrap.prepend(h("div", { class: "pl-head" }, grip,
        tool("arrow-left", "Move left", () => moveBy(id, -1), false),
        tool("arrow-right", "Move right", () => moveBy(id, 1), false),
        tool("wrap-text", "Start a new row", () => { state.breaks = state.breaks.includes(id) ? state.breaks.filter((x) => x !== id) : [...state.breaks, id]; keep(); }, state.breaks.includes(id) && i > 0),
        tool(fill ? "shrink" : "expand", fill ? "Fixed width" : "Fill the row", () => { state.w[id] = fill ? Math.round(wrap.getBoundingClientRect().width) : "fill"; keep(); }, fill),
        p.fixed ? null : tool("eye-off", "Hide this panel", () => { state.hidden = [...state.hidden, id]; keep(); }, false)));
      const rx = h("div", { class: "pl-rx", title: "Width — double-click: fill the row" });
      const ry = h("div", { class: "pl-ry", title: "Height — double-click: as tall as it needs" });
      const rxy = h("div", { class: "pl-rxy", title: "Width and height" });
      rx.addEventListener("pointerdown", (e) => startResize(e, id, true, false));
      ry.addEventListener("pointerdown", (e) => startResize(e, id, false, true));
      rxy.addEventListener("pointerdown", (e) => startResize(e, id, true, true));
      rx.addEventListener("dblclick", () => { state.w[id] = "fill"; keep(); });
      ry.addEventListener("dblclick", () => { delete state.h[id]; keep(); });
      wrap.append(rx, ry, rxy);
    }

    function moveBy(id, d) {
      const i = state.order.indexOf(id), j = i + d;
      if (i < 0 || j < 0 || j >= state.order.length) return;
      const next = [...state.order];
      [next[i], next[j]] = [next[j], next[i]];
      state.order = next;
      keep();
      wraps.get(id)?.querySelector(".pl-grip")?.focus();
    }

    function keyOn(e, id) {
      const wrap = wraps.get(id);
      if (!wrap) return;
      const step = e.ctrlKey || e.metaKey ? 80 : 20;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        if (e.shiftKey) {
          // Never wider than the row (as with the mouse).
          const w = wrap.getBoundingClientRect().width, max = root.getBoundingClientRect().width;
          state.w[id] = Math.round(Math.min(max, Math.max(byId.get(id).min || MIN_W, w + (e.key === "ArrowRight" ? step : -step))));
          keep(); wraps.get(id)?.querySelector(".pl-grip")?.focus();
        }
        else moveBy(id, e.key === "ArrowRight" ? 1 : -1);
      } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && e.altKey) {
        e.preventDefault();
        const hh = wrap.getBoundingClientRect().height;
        state.h[id] = Math.round(Math.max(MIN_H, hh + (e.key === "ArrowDown" ? step : -step)));
        keep(); wraps.get(id)?.querySelector(".pl-grip")?.focus();
      }
    }

    /* ------------------------------------------------ pointer work */

    function startResize(e, id, horiz, vert) {
      e.preventDefault();
      const wrap = wraps.get(id);
      const r = wrap.getBoundingClientRect();
      const max = root.getBoundingClientRect().width;
      const x0 = e.clientX, y0 = e.clientY;
      wrap.classList.add("is-resizing");
      const onMove = (ev) => {
        if (horiz) { state.w[id] = Math.round(Math.min(max, Math.max(byId.get(id).min || MIN_W, r.width + ev.clientX - x0))); wrap.style.flex = `0 0 ${state.w[id]}px`; }
        if (vert) { state.h[id] = Math.round(Math.max(MIN_H, r.height + ev.clientY - y0)); wrap.style.height = `${state.h[id]}px`; wrap.classList.add("pl-panel--h"); }
        const size = wrap.querySelector(".pl-head__size");
        if (size) size.textContent = `${state.w[id] === "fill" ? "fill" : `${state.w[id]} px`}${state.h[id] ? ` × ${state.h[id]}` : ""}`;
      };
      const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); wrap.classList.remove("is-resizing"); keep(); };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    }

    function startMove(e, id) {
      if (e.button !== 0) return;
      const wrap = wraps.get(id);
      const x0 = e.clientX, y0 = e.clientY;
      let moving = false, target = null, after = false;
      const ghost = h("div", { class: "pl-ghost" }, I("move"), byId.get(id).title);
      const mark = (t, a) => { for (const w of wraps.values()) w.classList.remove("pl-drop--before", "pl-drop--after"); if (t) t.classList.add(a ? "pl-drop--after" : "pl-drop--before"); };
      const onMove = (ev) => {
        if (!moving && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
        if (!moving) { moving = true; wrap.classList.add("is-moving"); document.body.append(ghost); }
        ghost.style.left = `${ev.clientX + 12}px`; ghost.style.top = `${ev.clientY + 12}px`;
        const hit = document.elementFromPoint(ev.clientX, ev.clientY);
        const t = hit && hit.closest ? hit.closest(".pl-panel") : null;
        if (!t || t === wrap || t.parentElement !== root) { target = null; mark(null); return; }
        const r = t.getBoundingClientRect();
        target = t; after = ev.clientX > r.left + r.width / 2;
        mark(t, after);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp);
        ghost.remove(); wrap.classList.remove("is-moving"); mark(null);
        if (!moving || !target) return;
        const to = target.dataset.pl;
        const next = state.order.filter((x) => x !== id);
        next.splice(next.indexOf(to) + (after ? 1 : 0), 0, id);
        state.order = next;
        keep();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    }

    /* ------------------------------------------------ lock & unlock */

    /** A change while unlocked: kept in the draft (not saved until locked). */
    function keep() { drafts.set(page, clone(state)); apply(); }

    function unlock() { drafts.set(page, clone(state)); apply(); syncLock(); for (const l of listeners) l(page, true); }
    function lock() {
      const all = { ...((C.pref && C.pref("layouts", {})) || {}) };
      all[page] = clone(state);
      drafts.delete(page);
      if (C.setPref) C.setPref("layouts", all);
      apply(); syncLock();
      toast(`Layout of ${opts.title} saved.`, "ok");
      for (const l of listeners) l(page, false);
    }
    function cancel() { drafts.delete(page); state = stateFor(page, panels, defaults); apply(); syncLock(); for (const l of listeners) l(page, false); }
    function reset() {
      const all = { ...((C.pref && C.pref("layouts", {})) || {}) };
      delete all[page];
      if (C.setPref) C.setPref("layouts", all);
      drafts.delete(page);
      state = stateFor(page, panels, defaults);
      drafts.set(page, clone(state));
      apply();
      toast(`${opts.title}: back to the default layout (lock to keep it).`, "ok");
    }

    function syncLock() {
      if (!lockBtn) return;
      clear(lockBtn);
      const on = editing();
      lockBtn.append(I(on ? "lock-open" : "lock"));
      lockBtn.classList.toggle("is-on", on);
      lockBtn.setAttribute("aria-pressed", on ? "true" : "false");
      lockBtn.dataset.tip = on ? "Lock the layout (saves it)" : "Unlock the layout: move, resize, align the panels";
      lockBtn.setAttribute("aria-label", lockBtn.dataset.tip);
    }

    /** The lock icon for the page's toolbar. */
    function lockButton() {
      lockBtn = h("button", { type: "button", class: "btn btn--sm btn--icon pl-lock", onclick: () => (editing() ? lock() : unlock()) });
      syncLock();
      return lockBtn;
    }

    const onKey = (e) => { if (e.key === "Escape" && editing() && root.isConnected && !document.querySelector(".mb-overlay")) cancel(); };
    document.addEventListener("keydown", onKey);

    apply();
    return {
      lockButton,
      get editing() { return editing(); },
      state: () => clone(state),
      relayout: apply,
      /** Reads the saved layout again (after "Reset all page layouts"). */
      reload() { if (!editing()) state = stateFor(page, panels, defaults); apply(); syncLock(); },
      destroy() { document.removeEventListener("keydown", onKey); bar.remove(); },
    };
  }

  window.M5Layout = {
    mount,
    /** Is any page being arranged right now (the console shows a hint)? */
    editing: (page) => (page ? drafts.has(page) : drafts.size > 0),
    onEditing: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    /** Forget every saved layout (Console settings › Reset layouts). */
    resetAll() { drafts.clear(); if (C.setPref) C.setPref("layouts", {}); },
  };
})();
