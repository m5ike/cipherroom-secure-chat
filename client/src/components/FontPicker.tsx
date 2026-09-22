// Font picker: search, category filter, live previews. Google font previews
// load lazily (only rows scrolled into view) and only with consent; without
// it the rows render in the fallback stack and picking a Google font asks for
// consent first (onConsent).

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronDown, Search } from "lucide-react";
import { FONT_CATEGORIES, FONT_SAMPLE, FONTS, ensureFonts, findFont, type FontCategory } from "@/lib/fonts";
import { t, type Lang } from "@/lib/i18n";

type Props = {
  label: string;
  value: string;
  onChange: (id: string) => void;
  lang: Lang;
  allowGoogle: boolean;
  onConsent: () => void;
  /** Categories offered (default: all). */
  categories?: FontCategory[];
  /** Extra first option with value "" (e.g. "same as the UI font"). */
  emptyLabel?: string;
  testId?: string;
};

export function FontPicker({ label, value, onChange, lang, allowGoogle, onConsent, categories, emptyLabel, testId }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const offered = categories ?? FONT_CATEGORIES;
  const [cat, setCat] = useState<FontCategory | "all">("all");
  const listRef = useRef<HTMLDivElement>(null);

  const current = value ? findFont(value) : undefined;
  const fonts = useMemo(() => {
    const q = query.trim().toLowerCase();
    return FONTS.filter((f) => offered.includes(f.category))
      .filter((f) => cat === "all" || f.category === cat)
      .filter((f) => !q || f.label.toLowerCase().includes(q) || f.category.includes(q));
  }, [query, cat, offered]);

  // A new filter starts at the top of the list.
  useEffect(() => { if (listRef.current) listRef.current.scrollTop = 0; }, [query, cat]);

  // Lazy previews: request a Google family only once its row is visible.
  useEffect(() => {
    if (!open || !allowGoogle || !listRef.current || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      const ids = entries.filter((e) => e.isIntersecting).map((e) => (e.target as HTMLElement).dataset.fontId || "");
      if (ids.length) ensureFonts(ids, true);
    }, { root: listRef.current, rootMargin: "120px" });
    listRef.current.querySelectorAll("[data-font-id]").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [open, allowGoogle, fonts]);

  const choose = (id: string) => {
    const def = findFont(id);
    if (def?.google && !allowGoogle) onConsent();
    onChange(id);
    setOpen(false);
  };

  const googleCount = FONTS.filter((f) => f.google && offered.includes(f.category)).length;

  return (
    <div className="ap-font" data-testid={testId}>
      <span className="ap-color__label">{label}</span>
      <button
        type="button"
        className="ap-font__trigger"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-testid={testId ? `${testId}-toggle` : undefined}
      >
        <span className="ap-font__name" style={{ fontFamily: current?.stack || undefined }}>
          {current ? current.label : emptyLabel ?? t(lang, "ap.font.theme")}
        </span>
        {current?.google ? <span className="ap-badge">Google</span> : null}
        <ChevronDown className={`ml-auto h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      {open ? (
        <div className="ap-font__panel">
          <div className="ap-font__tools">
            <label className="ap-search">
              <Search className="h-4 w-4" aria-hidden="true" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t(lang, "ap.font.search").replace("{n}", String(googleCount))}
                aria-label={t(lang, "ap.font.search").replace("{n}", String(googleCount))}
                data-testid={testId ? `${testId}-search` : undefined}
              />
            </label>
            <div className="ap-chips" role="tablist" aria-label={t(lang, "ap.font.category")}>
              {(["all", ...offered] as const).filter((c) => c !== "theme").map((c) => (
                <button key={c} type="button" role="tab" aria-selected={cat === c} className="ap-chip" onClick={() => setCat(c)}>
                  {t(lang, `ap.font.cat.${c}`)}
                </button>
              ))}
            </div>
          </div>
          {!allowGoogle ? (
            <div className="ap-consent">
              <span>{t(lang, "ap.font.consent")}</span>
              <button type="button" className="ap-btn ap-btn--primary" onClick={onConsent} data-testid="fonts-consent">
                {t(lang, "ap.font.allow")}
              </button>
            </div>
          ) : null}
          <div className="ap-font__list" ref={listRef} role="listbox" aria-label={label}>
            {emptyLabel !== undefined ? (
              <button type="button" role="option" aria-selected={value === ""} className="ap-font__item" onClick={() => choose("")}>
                <span className="ap-font__item-name">{emptyLabel}</span>
                {value === "" ? <Check className="h-4 w-4 text-primary" aria-hidden="true" /> : null}
              </button>
            ) : null}
            {fonts.map((f) => {
              const selected = f.id === value;
              return (
                <button
                  key={f.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className="ap-font__item"
                  data-font-id={f.id}
                  onClick={() => choose(f.id)}
                  data-testid={`font-opt-${f.id}`}
                >
                  <span className="ap-font__item-main">
                    <span className="ap-font__item-name" style={{ fontFamily: f.stack || undefined }}>{f.label}</span>
                    <span className="ap-font__item-sample" style={{ fontFamily: f.stack || undefined }}>{FONT_SAMPLE}</span>
                  </span>
                  <span className="ap-font__item-meta">
                    <span className="ap-font__cat">{t(lang, `ap.font.cat.${f.category}`)}</span>
                    {!f.czech ? (
                      <span className="ap-font__warn" title={t(lang, "ap.font.noCzech")}>
                        <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /> CZ
                      </span>
                    ) : null}
                    {selected ? <Check className="h-4 w-4 text-primary" aria-hidden="true" /> : null}
                  </span>
                </button>
              );
            })}
            {fonts.length === 0 ? <p className="ap-empty">{t(lang, "ap.font.none")}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
