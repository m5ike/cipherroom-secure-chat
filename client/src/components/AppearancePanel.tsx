// The one screen for everything visual: template, typography (71 Google
// Fonts + system stacks, size / weight / line height / letter spacing),
// colours (extended palette + custom), display & device (detected phone /
// browser, layout override, fullscreen, install), and the Edit Mode editor
// (saved element styles, custom CSS, export / import / undo).
//
// Replaces the appearance parts that used to be split between Settings and
// Templates. Every change applies instantly and is stored in Preferences
// (localStorage); element styles live in the style-overrides store.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bell, Check, Download, Eye, EyeOff, LayoutTemplate, Maximize2, Minimize2, MonitorSmartphone, Palette, PencilRuler,
  RotateCcw, Smartphone, Trash2, Type, Undo2, Upload, X,
} from "lucide-react";
import { Modal } from "./Modal";
import { ColorField } from "./ColorField";
import { FontPicker } from "./FontPicker";
import { ACCENTS, LAYOUTS, THEMES, type ThemeId } from "@/lib/themes";
import { hslToHex } from "@/lib/color";
import { t, type Lang } from "@/lib/i18n";
import { APPEARANCE_DEFAULTS, type Preferences } from "@/lib/preferences";
import {
  canPromptInstall, describeDevice, deviceInfo, fullscreenSupported, isFullscreen, onInstallAvailability,
  promptInstall, toggleFullscreen, watchFullscreen, type DeviceLayoutPref,
} from "@/lib/device";
import { requestInspect, styleStore, stylesSuspended, useStyleOverrides } from "@/lib/style-editor";
import { exportOverrides, importOverrides, sanitizeCssText, EMPTY_OVERRIDES, type StyleOverrides } from "@/lib/style-overrides";
import { removeGoogleFonts } from "@/lib/fonts";
import { APP_BUILT_AT, buildLabel } from "@/lib/build-info";
import "../appearance.css";

type Props = {
  open: boolean;
  onClose: () => void;
  prefs: Preferences;
  setPrefs: (next: Partial<Preferences>) => void;
  lang: Lang;
};

type TabId = "theme" | "type" | "color" | "display" | "editor";
const TAB_KEY = "m5cet:appearance:tab";
const TABS: Array<{ id: TabId; icon: typeof Palette }> = [
  { id: "theme", icon: LayoutTemplate },
  { id: "type", icon: Type },
  { id: "color", icon: Palette },
  { id: "display", icon: MonitorSmartphone },
  { id: "editor", icon: PencilRuler },
];

const hex = (c: [number, number, number]) => hslToHex(c[0], c[1], c[2]);

/* ------------------------------------------------------------ Edit Mode */

export function EditModeToggle({ on, onChange, lang, compact }: { on: boolean; onChange: (on: boolean) => void; lang: Lang; compact?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`edit-toggle ${on ? "is-on" : "is-off"} ${compact ? "is-compact" : ""}`}
      onClick={() => onChange(!on)}
      data-testid="edit-mode-toggle"
      title={t(lang, "ap.edit.toggleHint")}
    >
      <span className="edit-toggle__icon" aria-hidden="true">
        {on ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : <X className="h-3.5 w-3.5" strokeWidth={3} />}
      </span>
      <span className="edit-toggle__label">Edit Mode</span>
      <span className="edit-toggle__state">{on ? "ON" : "OFF"}</span>
    </button>
  );
}

/* ------------------------------------------------------------- helpers */

function Section({ title, hint, children, icon }: { title: string; hint?: string; children: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <section className="ap-section">
      <header className="ap-section__head">
        {icon ? <span className="ap-section__icon">{icon}</span> : null}
        <div>
          <h3 className="ap-section__title">{title}</h3>
          {hint ? <p className="ap-hint">{hint}</p> : null}
        </div>
      </header>
      <div className="ap-section__body">{children}</div>
    </section>
  );
}

function Slider({ label, value, min, max, step, onChange, format, testId, onReset, isDefault }: {
  label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void;
  format: (v: number) => string; testId?: string; onReset?: () => void; isDefault?: boolean;
}) {
  return (
    <label className="ap-slider">
      <span className="ap-slider__head">
        <span>{label}</span>
        <span className="ap-slider__value">
          {format(value)}
          {onReset && !isDefault ? (
            <button type="button" className="ap-icon-btn" onClick={(e) => { e.preventDefault(); onReset(); }} aria-label="reset">
              <RotateCcw className="h-3 w-3" />
            </button>
          ) : null}
        </span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} data-testid={testId} />
    </label>
  );
}

function Segmented<T extends string>({ value, options, onChange, label, testIdPrefix }: {
  value: T; options: Array<{ id: T; label: string }>; onChange: (v: T) => void; label: string; testIdPrefix?: string;
}) {
  return (
    <div className="ap-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          className="ap-seg__btn"
          onClick={() => onChange(o.id)}
          data-testid={testIdPrefix ? `${testIdPrefix}-${o.id}` : undefined}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ label, checked, onChange, hint, testId }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string; testId?: string }) {
  return (
    <label className="ap-toggle">
      <span>
        <span className="ap-toggle__label">{label}</span>
        {hint ? <span className="ap-hint">{hint}</span> : null}
      </span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
      <span className="ap-toggle__track" aria-hidden="true"><span className="ap-toggle__thumb" /></span>
    </label>
  );
}

/** A miniature conversation drawn with the real bubble classes, so it
 *  shows exactly what the chat will look like. */
function Preview({ lang }: { lang: Lang }) {
  return (
    <div className="ap-preview chat-surface" aria-label={t(lang, "ap.preview")} data-m5-preview="">
      <div className="ap-preview__inner">
        <div className="flex justify-center">
          <div className="msg-bubble msg-bubble--system"><p className="msg-bubble__text">M5cet · {t(lang, "ap.preview.system")}</p></div>
        </div>
        <div className="flex justify-start">
          <div className="msg-bubble msg-bubble--theirs">
            <div className="msg-bubble__head"><span className="msg-bubble__label">Alice</span><span className="msg-bubble__time">10:24</span></div>
            <p className="msg-bubble__text">{t(lang, "ap.preview.theirs")}</p>
          </div>
        </div>
        <div className="flex justify-end">
          <div className="msg-bubble msg-bubble--mine">
            <div className="msg-bubble__head"><span className="msg-bubble__label">{t(lang, "ap.preview.me")}</span><span className="msg-bubble__time">10:25</span></div>
            <p className="msg-bubble__text">{t(lang, "ap.preview.mine")} <code className="font-mono">AES-GCM</code></p>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- panel */

export function AppearancePanel({ open, onClose, prefs, setPrefs, lang }: Props) {
  const [tab, setTab] = useState<TabId>(() => {
    try { const v = localStorage.getItem(TAB_KEY); return (TABS.some((x) => x.id === v) ? v : "theme") as TabId; } catch { return "theme"; }
  });
  useEffect(() => { try { localStorage.setItem(TAB_KEY, tab); } catch { /* ignore */ } }, [tab]);

  const setEditMode = (on: boolean) => setPrefs({ editMode: on });
  const consent = () => setPrefs({ googleFonts: true });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t(lang, "menu.appearance")}
      size="lg"
      testId="appearance-panel"
      closeLabel={t(lang, "common.close")}
      headerExtra={<EditModeToggle on={prefs.editMode} onChange={setEditMode} lang={lang} compact />}
    >
      <div className="ap">
        <nav className="ap-tabs" role="tablist" aria-label={t(lang, "menu.appearance")}>
          {TABS.map(({ id, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className="ap-tab"
              onClick={() => setTab(id)}
              data-testid={`ap-tab-${id}`}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              <span>{t(lang, `ap.tab.${id}`)}</span>
            </button>
          ))}
        </nav>

        <div className="ap-content" role="tabpanel">
          {tab === "theme" ? <ThemeTab prefs={prefs} setPrefs={setPrefs} lang={lang} /> : null}
          {tab === "type" ? <TypeTab prefs={prefs} setPrefs={setPrefs} lang={lang} onConsent={consent} /> : null}
          {tab === "color" ? <ColorTab prefs={prefs} setPrefs={setPrefs} lang={lang} /> : null}
          {tab === "display" ? <DisplayTab prefs={prefs} setPrefs={setPrefs} lang={lang} onConsent={consent} /> : null}
          {tab === "editor" ? <EditorTab prefs={prefs} setPrefs={setPrefs} lang={lang} onClose={onClose} /> : null}
        </div>

        <footer className="ap-foot">
          <button
            type="button"
            className="ap-btn ap-btn--ghost"
            onClick={() => { if (window.confirm(t(lang, "ap.reset.confirm"))) setPrefs(APPEARANCE_DEFAULTS); }}
            data-testid="ap-reset"
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" /> {t(lang, "ap.reset")}
          </button>
          <span className="ap-foot__note">{t(lang, "ap.savedLocally")}</span>
        </footer>
      </div>
    </Modal>
  );
}

type TabProps = { prefs: Preferences; setPrefs: (next: Partial<Preferences>) => void; lang: Lang };

/* ---------------------------------------------------------------- theme */

function ThemeTab({ prefs, setPrefs, lang }: TabProps) {
  const menuModes: Array<Preferences["menuDisplay"]> = ["speeddial", "icons", "text", "icons-text", "icons-tooltip"];
  const menuKey: Record<Preferences["menuDisplay"], string> = {
    speeddial: "settings.menu.speeddial", icons: "settings.menu.icons", text: "settings.menu.text",
    "icons-text": "settings.menu.iconsText", "icons-tooltip": "settings.menu.iconsTooltip",
  };
  return (
    <>
      <Section title={t(lang, "ap.theme.templates")} icon={<LayoutTemplate className="h-4 w-4" />}>
        <div className="ap-theme-grid" data-testid="theme-grid">
          {THEMES.map((theme) => {
            const p = theme.preview;
            return (
              <button
                key={theme.id}
                type="button"
                className="ap-theme"
                aria-pressed={prefs.theme === theme.id}
                onClick={() => setPrefs({ theme: theme.id as ThemeId })}
                data-testid={`theme-${theme.id}`}
                style={{ background: hex(p.bg), color: hex(p.fg) }}
              >
                <span className="ap-theme__mock" aria-hidden="true">
                  <span className="ap-theme__bar" style={{ background: `hsl(${p.fg[0]} ${p.fg[1]}% ${p.fg[2]}% / 0.12)` }} />
                  <span className="ap-theme__bubble" style={{ background: `hsl(${p.primary[0]} ${p.primary[1]}% ${p.primary[2]}% / 0.18)`, border: `1px solid hsl(${p.primary[0]} ${p.primary[1]}% ${p.primary[2]}% / 0.35)` }} />
                  <span className="ap-theme__bubble is-mine" style={{ background: hex(p.primary) }} />
                </span>
                <span className="ap-theme__name">{t(lang, theme.labelKey)}</span>
                <span className="ap-theme__tone">{theme.tone === "dark" ? t(lang, "ap.theme.dark") : t(lang, "ap.theme.light")}</span>
                {prefs.theme === theme.id ? <span className="ap-theme__check"><Check className="h-3.5 w-3.5" /></span> : null}
              </button>
            );
          })}
        </div>
      </Section>

      <Section title={t(lang, "templates.layout")}>
        <Segmented
          label={t(lang, "templates.layout")}
          value={prefs.layout}
          options={LAYOUTS.map((l) => ({ id: l.id, label: t(lang, l.labelKey) }))}
          onChange={(layout) => setPrefs({ layout })}
          testIdPrefix="layout"
        />
      </Section>

      <Section title={t(lang, "templates.width")}>
        <Segmented
          label={t(lang, "templates.width")}
          value={prefs.chatWidth}
          options={(["sm", "md", "lg", "full"] as const).map((w) => ({ id: w, label: t(lang, `templates.width.${w}`) }))}
          onChange={(chatWidth) => setPrefs({ chatWidth })}
          testIdPrefix="chatwidth"
        />
      </Section>

      <Section title={t(lang, "settings.menu.title")} hint={t(lang, "settings.menu.display.hint")}>
        <div className="ap-list" role="radiogroup" aria-label={t(lang, "settings.menu.title")}>
          {menuModes.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={prefs.menuDisplay === m}
              className="ap-list__item"
              onClick={() => setPrefs({ menuDisplay: m })}
              data-testid={`menu-display-${m}`}
            >
              <span>{t(lang, menuKey[m])}</span>
              {prefs.menuDisplay === m ? <Check className="h-4 w-4 text-primary" aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
      </Section>

      <Section title={t(lang, "ap.theme.motion")}>
        <Toggle label={t(lang, "common.effects")} hint={t(lang, "ap.theme.effectsHint")} checked={prefs.effects} onChange={(effects) => setPrefs({ effects })} testId="toggle-effects" />
      </Section>
    </>
  );
}

/* ----------------------------------------------------------- typography */

function TypeTab({ prefs, setPrefs, lang, onConsent }: TabProps & { onConsent: () => void }) {
  return (
    <>
      <Preview lang={lang} />
      {!prefs.googleFonts ? (
        <div className="ap-consent ap-consent--block">
          <span>{t(lang, "ap.font.consentLong")}</span>
          <button type="button" className="ap-btn ap-btn--primary" onClick={onConsent} data-testid="fonts-consent-main">{t(lang, "ap.font.allow")}</button>
        </div>
      ) : null}
      <Section title={t(lang, "ap.type.fonts")} icon={<Type className="h-4 w-4" />}>
        <FontPicker label={t(lang, "ap.type.uiFont")} value={prefs.font} onChange={(font) => setPrefs({ font })} lang={lang} allowGoogle={prefs.googleFonts} onConsent={onConsent} testId="font-ui" />
        <FontPicker label={t(lang, "ap.type.chatFont")} value={prefs.chatFont} onChange={(chatFont) => setPrefs({ chatFont })} lang={lang} allowGoogle={prefs.googleFonts} onConsent={onConsent} emptyLabel={t(lang, "ap.type.sameAsUi")} categories={["system", "sans", "serif", "display", "hand", "mono"]} testId="font-chat" />
        <FontPicker label={t(lang, "ap.type.monoFont")} value={prefs.monoFont} onChange={(monoFont) => setPrefs({ monoFont })} lang={lang} allowGoogle={prefs.googleFonts} onConsent={onConsent} categories={["mono"]} testId="font-mono" />
        {prefs.googleFonts ? (
          <button type="button" className="ap-link" onClick={() => { removeGoogleFonts(); setPrefs({ googleFonts: false }); }}>
            {t(lang, "ap.font.revoke")}
          </button>
        ) : null}
      </Section>
      <Section title={t(lang, "ap.type.settings")}>
        <Slider label={t(lang, "ap.type.size")} value={prefs.textSize} min={12} max={22} step={0.5} format={(v) => `${v} px`} onChange={(textSize) => setPrefs({ textSize })} testId="slider-text-size" onReset={() => setPrefs({ textSize: 15.5 })} isDefault={prefs.textSize === 15.5} />
        <Slider label={t(lang, "ap.type.chatScale")} value={prefs.chatScale} min={0.8} max={1.5} step={0.05} format={(v) => `${Math.round(v * 100)} %`} onChange={(chatScale) => setPrefs({ chatScale })} testId="slider-chat-scale" onReset={() => setPrefs({ chatScale: 1 })} isDefault={prefs.chatScale === 1} />
        <Slider label={t(lang, "ap.type.weight")} value={prefs.fontWeight} min={300} max={700} step={100} format={(v) => String(v)} onChange={(fontWeight) => setPrefs({ fontWeight })} testId="slider-weight" onReset={() => setPrefs({ fontWeight: 400 })} isDefault={prefs.fontWeight === 400} />
        <Slider label={t(lang, "ap.type.lineHeight")} value={prefs.lineHeight} min={1.1} max={2.2} step={0.05} format={(v) => v.toFixed(2)} onChange={(lineHeight) => setPrefs({ lineHeight })} testId="slider-line-height" onReset={() => setPrefs({ lineHeight: 1.5 })} isDefault={prefs.lineHeight === 1.5} />
        <Slider label={t(lang, "ap.type.letterSpacing")} value={prefs.letterSpacing} min={-0.05} max={0.2} step={0.005} format={(v) => `${v.toFixed(3)} em`} onChange={(letterSpacing) => setPrefs({ letterSpacing })} testId="slider-letter-spacing" onReset={() => setPrefs({ letterSpacing: 0 })} isDefault={prefs.letterSpacing === 0} />
      </Section>
    </>
  );
}

/* --------------------------------------------------------------- colours */

function ColorTab({ prefs, setPrefs, lang }: TabProps) {
  const accentPresets = ACCENTS.map((a) => ({
    id: a.id,
    color: a.id === "default" ? hex(THEMES.find((th) => th.id === prefs.theme)?.preview.primary ?? [220, 90, 56]) : a.swatch,
    label: a.id === "default" ? t(lang, "ap.color.templateAccent") : a.id,
  }));
  return (
    <>
      <Preview lang={lang} />
      <Section title={t(lang, "ap.color.accent")} hint={t(lang, "ap.color.accentHint")} icon={<Palette className="h-4 w-4" />}>
        <ColorField
          label={t(lang, "ap.color.accent")}
          value={prefs.accentColor}
          onChange={(accentColor) => setPrefs({ accentColor })}
          lang={lang}
          allowEmpty
          presets={accentPresets}
          activePreset={prefs.accent}
          onPreset={(id) => setPrefs({ accent: id as Preferences["accent"], accentColor: "" })}
          testId="color-accent"
          defaultOpen
        />
      </Section>
      <Section title={t(lang, "ap.color.bubbles")}>
        <ColorField label={t(lang, "ap.color.mine")} value={prefs.bubbleMine} onChange={(bubbleMine) => setPrefs({ bubbleMine })} lang={lang} allowEmpty testId="color-mine" />
        <ColorField label={t(lang, "ap.color.theirs")} value={prefs.bubbleTheirs} onChange={(bubbleTheirs) => setPrefs({ bubbleTheirs })} lang={lang} allowEmpty testId="color-theirs" />
        <Slider
          label={t(lang, "ap.color.bubbleRadius")}
          value={prefs.bubbleRadius < 0 ? 24 : prefs.bubbleRadius}
          min={0} max={32} step={1}
          format={(v) => (prefs.bubbleRadius < 0 ? t(lang, "ap.color.template") : `${v} px`)}
          onChange={(bubbleRadius) => setPrefs({ bubbleRadius })}
          onReset={() => setPrefs({ bubbleRadius: -1 })}
          isDefault={prefs.bubbleRadius < 0}
          testId="slider-bubble-radius"
        />
        <Slider
          label={t(lang, "ap.color.uiRadius")}
          value={prefs.uiRadius < 0 ? 1 : prefs.uiRadius}
          min={0} max={2} step={0.125}
          format={(v) => (prefs.uiRadius < 0 ? t(lang, "ap.color.template") : `${v} rem`)}
          onChange={(uiRadius) => setPrefs({ uiRadius })}
          onReset={() => setPrefs({ uiRadius: -1 })}
          isDefault={prefs.uiRadius < 0}
          testId="slider-ui-radius"
        />
      </Section>
      <Section title={t(lang, "templates.surface")}>
        <ColorField label={t(lang, "templates.bg.color")} value={prefs.chatBgColor} onChange={(chatBgColor) => setPrefs({ chatBgColor })} lang={lang} allowEmpty testId="color-chatbg" />
        <div className="ap-row">
          <label className="ap-btn ap-btn--ghost">
            <Upload className="h-4 w-4" aria-hidden="true" /> {t(lang, "templates.bg.image")}
            <input
              type="file"
              accept="image/*"
              className="hidden"
              data-testid="chatbg-image"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file || file.size > 3_500_000) return; // keep prefs small
                const reader = new FileReader();
                reader.onload = () => { if (typeof reader.result === "string") setPrefs({ chatBgImage: reader.result }); };
                reader.readAsDataURL(file);
              }}
            />
          </label>
          {prefs.chatBgImage ? (
            <button type="button" className="ap-btn ap-btn--ghost" onClick={() => setPrefs({ chatBgImage: "" })}>
              <Trash2 className="h-4 w-4" aria-hidden="true" /> {t(lang, "templates.bg.image.clear")}
            </button>
          ) : null}
        </div>
        <Slider label={t(lang, "templates.bg.saturation")} value={prefs.chatBgSaturation} min={0.5} max={1.5} step={0.05} format={(v) => `${Math.round(v * 100)} %`} onChange={(chatBgSaturation) => setPrefs({ chatBgSaturation })} />
        <Slider label={t(lang, "templates.bg.opacity")} value={prefs.chatBgOpacity} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)} %`} onChange={(chatBgOpacity) => setPrefs({ chatBgOpacity })} />
        <Segmented
          label={t(lang, "templates.pattern")}
          value={prefs.chatPattern}
          options={(["grid", "dots", "diagonal", "plain"] as const).map((p) => ({ id: p, label: t(lang, `templates.pattern.${p}`) }))}
          onChange={(chatPattern) => setPrefs({ chatPattern })}
          testIdPrefix="pattern"
        />
      </Section>
    </>
  );
}

/* --------------------------------------------------------------- display */

function DisplayTab({ prefs, setPrefs, lang, onConsent }: TabProps & { onConsent: () => void }) {
  const info = deviceInfo();
  const [fs, setFs] = useState(isFullscreen());
  const [installable, setInstallable] = useState(canPromptInstall());
  useEffect(() => watchFullscreen(setFs), []);
  useEffect(() => onInstallAvailability(() => setInstallable(canPromptInstall())), []);
  const apple = info.os === "ios" || info.os === "ipados";
  const rows: Array<[string, string]> = [
    [t(lang, "ap.device.detected"), describeDevice(info)],
    [t(lang, "ap.device.form"), t(lang, `ap.device.form.${info.form}`)],
    [t(lang, "ap.device.input"), info.touch ? t(lang, "ap.device.touch") : t(lang, "ap.device.mouse")],
    [t(lang, "ap.device.standalone"), info.standalone ? t(lang, "common.yes") : t(lang, "common.no")],
    [t(lang, "ap.device.fullscreen"), fullscreenSupported() ? t(lang, "common.yes") : t(lang, "common.no")],
    [t(lang, "ap.device.build"), `${buildLabel()}${APP_BUILT_AT ? ` · ${new Date(APP_BUILT_AT).toLocaleString()}` : ""}`],
  ];
  return (
    <>
      <Section title={t(lang, "ap.device.title")} hint={t(lang, "ap.device.hint")} icon={<Smartphone className="h-4 w-4" />}>
        <dl className="ap-kv" data-testid="device-info">
          {rows.map(([k, v]) => (
            <div key={k} className="ap-kv__row"><dt>{k}</dt><dd>{v}</dd></div>
          ))}
        </dl>
      </Section>
      <Section title={t(lang, "ap.device.layout")} hint={t(lang, "ap.device.layoutHint")}>
        <Segmented<DeviceLayoutPref>
          label={t(lang, "ap.device.layout")}
          value={prefs.deviceLayout}
          options={(["auto", "phone", "tablet", "desktop"] as const).map((f) => ({ id: f, label: f === "auto" ? `${t(lang, "ap.device.auto")} (${t(lang, `ap.device.form.${info.form}`)})` : t(lang, `ap.device.form.${f}`) }))}
          onChange={(deviceLayout) => setPrefs({ deviceLayout })}
          testIdPrefix="device-layout"
        />
      </Section>
      <FlashSection prefs={prefs} setPrefs={setPrefs} lang={lang} onConsent={onConsent} />
      <Section title={t(lang, "ap.device.fullscreenTitle")}>
        {fullscreenSupported() ? (
          <button type="button" className="ap-btn ap-btn--primary" onClick={() => void toggleFullscreen()} data-testid="btn-fullscreen">
            {fs ? <Minimize2 className="h-4 w-4" aria-hidden="true" /> : <Maximize2 className="h-4 w-4" aria-hidden="true" />}
            {fs ? t(lang, "ap.device.exitFullscreen") : t(lang, "ap.device.enterFullscreen")}
          </button>
        ) : null}
        {installable ? (
          <button type="button" className="ap-btn ap-btn--ghost" onClick={() => void promptInstall()} data-testid="btn-install">
            <Download className="h-4 w-4" aria-hidden="true" /> {t(lang, "ap.device.install")}
          </button>
        ) : null}
        {apple && !info.standalone ? <p className="ap-note">{t(lang, "ap.device.iosHint")}</p> : null}
        {info.standalone ? <p className="ap-note">{t(lang, "ap.device.standaloneOn")}</p> : null}
      </Section>
    </>
  );
}

/* ----------------------------------------------------------- notices */

/** System notices: whether they also land in the chat, and how the flash
 *  at the top of the screen looks. */
function FlashSection({ prefs, setPrefs, lang, onConsent }: TabProps & { onConsent: () => void }) {
  const flash = prefs.flash;
  const set = (patch: Partial<Preferences["flash"]>) => setPrefs({ flash: { ...flash, ...patch } });
  return (
    <Section title={t(lang, "flash.settings")} icon={<Bell className="h-4 w-4" />}>
      <Toggle
        label={t(lang, "chat.systemInChat")}
        hint={t(lang, "chat.systemInChat.hint")}
        checked={prefs.showSystemInChat}
        onChange={(showSystemInChat) => setPrefs({ showSystemInChat })}
        testId="toggle-system-in-chat"
      />
      <Toggle
        label={t(lang, "flash.enabled")}
        checked={flash.enabled}
        onChange={(enabled) => set({ enabled })}
        testId="toggle-flash"
      />
      {flash.enabled ? (
        <>
          <Slider
            label={t(lang, "flash.seconds")}
            value={flash.seconds}
            min={3}
            max={60}
            step={1}
            onChange={(seconds) => set({ seconds })}
            format={(v) => `${v} s`}
            testId="flash-seconds"
          />
          <Segmented<Preferences["flash"]["position"]>
            label={t(lang, "flash.position")}
            value={flash.position}
            options={(["top", "top-left", "top-right"] as const).map((id) => ({ id, label: t(lang, `flash.position.${id}`) }))}
            onChange={(position) => set({ position })}
            testIdPrefix="flash-position"
          />
          <Segmented<Preferences["flash"]["animation"]>
            label={t(lang, "flash.animation")}
            value={flash.animation}
            options={(["fade", "slide", "none"] as const).map((id) => ({ id, label: t(lang, `flash.animation.${id}`) }))}
            onChange={(animation) => set({ animation })}
            testIdPrefix="flash-animation"
          />
          <Toggle label={t(lang, "flash.icon")} checked={flash.icon} onChange={(icon) => set({ icon })} testId="toggle-flash-icon" />
          <Slider label={t(lang, "flash.size")} value={flash.size} min={11} max={20} step={0.5} onChange={(size) => set({ size })} format={(v) => `${v} px`} testId="flash-size" />
          <Slider label={t(lang, "flash.radius")} value={flash.radius} min={0} max={28} step={1} onChange={(radius) => set({ radius })} format={(v) => `${v} px`} testId="flash-radius" />
          <ColorField label={t(lang, "flash.background")} value={flash.background} onChange={(background) => set({ background })} lang={lang} allowEmpty testId="flash-background" />
          <ColorField label={t(lang, "flash.color")} value={flash.color} onChange={(color) => set({ color })} lang={lang} allowEmpty testId="flash-color" />
          <FontPicker
            label={t(lang, "flash.font")}
            value={flash.font}
            onChange={(font) => set({ font })}
            lang={lang}
            allowGoogle={prefs.googleFonts}
            onConsent={onConsent}
            testId="flash-font"
          />
        </>
      ) : null}
    </Section>
  );
}

/* ---------------------------------------------------------------- editor */

function EditorTab({ prefs, setPrefs, lang, onClose }: TabProps & { onClose: () => void }) {
  const overrides = useStyleOverrides();
  const [css, setCss] = useState(overrides.globalCss);
  const [msg, setMsg] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => setCss(overrides.globalCss), [overrides.globalCss]);
  const cssDirty = css !== overrides.globalCss;

  const commit = (next: StyleOverrides, note?: string) => {
    const ok = styleStore.commit(next);
    setMsg(ok ? note ?? t(lang, "ins.saved") : t(lang, "ins.saveFailed"));
  };
  const editRule = (selector: string, state: string, scope: StyleOverrides["rules"][number]["scope"]) => {
    setPrefs({ editMode: true });
    requestInspect({ selector, state, scope });
    onClose();
  };
  const download = () => {
    const blob = new Blob([exportOverrides(overrides)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `m5cet-styles-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const upload = (file: File) => {
    file.text().then((text) => {
      try {
        const next = importOverrides(text);
        commit(next, t(lang, "ins.imported").replace("{n}", String(next.rules.length)));
      } catch (e) {
        setMsg((e as Error).message);
      }
    }).catch(() => setMsg(t(lang, "ins.saveFailed")));
  };
  const sorted = useMemo(() => [...overrides.rules].sort((a, b) => b.updatedAt - a.updatedAt), [overrides.rules]);

  return (
    <>
      <Section title="Edit Mode" hint={t(lang, "ap.edit.hint")} icon={<PencilRuler className="h-4 w-4" />}>
        <div className="ap-row">
          <EditModeToggle on={prefs.editMode} onChange={(on) => setPrefs({ editMode: on })} lang={lang} />
          {prefs.editMode ? (
            <button type="button" className="ap-btn ap-btn--primary" onClick={onClose} data-testid="ap-start-picking">
              {t(lang, "ap.edit.startPicking")}
            </button>
          ) : null}
        </div>
        <ul className="ap-gestures">
          <li><kbd>Ctrl</kbd> + <kbd>{t(lang, "ap.edit.rightClick")}</kbd> — {t(lang, "ap.edit.gestureMouse")}</li>
          <li><kbd>{t(lang, "ap.edit.longTap")}</kbd> — {t(lang, "ap.edit.gestureTouch")}</li>
          <li><kbd>⌖</kbd> — {t(lang, "ap.edit.gestureTap")}</li>
        </ul>
        {stylesSuspended() ? <p className="ap-warn">{t(lang, "ap.edit.suspended")}</p> : null}
      </Section>

      <Section title={t(lang, "ap.edit.saved")} hint={t(lang, "ap.edit.savedHint").replace("{r}", String(overrides.rules.length)).replace("{c}", String(overrides.classes.length))}>
        {sorted.length === 0 && overrides.classes.length === 0 ? <p className="ap-empty">{t(lang, "ap.edit.none")}</p> : null}
        <ul className="ap-rules" data-testid="saved-rules">
          {sorted.map((r) => (
            <li key={r.id} className={`ap-rule ${r.enabled ? "" : "is-off"}`}>
              <button type="button" className="ap-rule__main" onClick={() => editRule(r.selector, r.state, r.scope)} title={t(lang, "ins.edit")}>
                <code className="ap-rule__sel">{r.selector}<span className="ap-rule__state">{r.state}</span></code>
                <span className="ap-rule__meta">
                  {r.scope !== "all" ? <span className="ap-badge">{t(lang, `ins.scope.${r.scope}`)}</span> : null}
                  {r.important ? <span className="ap-badge">!important</span> : null}
                  <span>{new Date(r.updatedAt).toLocaleString()}</span>
                </span>
              </button>
              <button type="button" className="ap-icon-btn" aria-label={r.enabled ? t(lang, "ins.disable") : t(lang, "ins.enable")} title={r.enabled ? t(lang, "ins.disable") : t(lang, "ins.enable")}
                onClick={() => commit({ ...overrides, rules: overrides.rules.map((x) => (x.id === r.id ? { ...x, enabled: !x.enabled } : x)) })}>
                {r.enabled ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
              </button>
              <button type="button" className="ap-icon-btn is-danger" aria-label={t(lang, "ins.delete")} title={t(lang, "ins.delete")}
                onClick={() => commit({ ...overrides, rules: overrides.rules.filter((x) => x.id !== r.id) })}>
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
          {overrides.classes.map((p) => (
            <li key={p.id} className={`ap-rule ${p.enabled ? "" : "is-off"}`}>
              <div className="ap-rule__main">
                <code className="ap-rule__sel">{p.selector}</code>
                <span className="ap-rule__meta">
                  {p.add.map((c) => <span key={`a${c}`} className="ap-badge is-add">+.{c}</span>)}
                  {p.remove.map((c) => <span key={`r${c}`} className="ap-badge is-remove">−.{c}</span>)}
                </span>
              </div>
              <button type="button" className="ap-icon-btn" aria-label={p.enabled ? t(lang, "ins.disable") : t(lang, "ins.enable")}
                onClick={() => commit({ ...overrides, classes: overrides.classes.map((x) => (x.id === p.id ? { ...x, enabled: !x.enabled } : x)) })}>
                {p.enabled ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
              </button>
              <button type="button" className="ap-icon-btn is-danger" aria-label={t(lang, "ins.delete")}
                onClick={() => commit({ ...overrides, classes: overrides.classes.filter((x) => x.id !== p.id) })}>
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      </Section>

      <Section title={t(lang, "ap.edit.customCss")} hint={t(lang, "ap.edit.customCssHint")}>
        <textarea
          className="ap-code"
          value={css}
          spellCheck={false}
          rows={8}
          onChange={(e) => setCss(e.target.value)}
          placeholder={".msg-bubble--mine {\n  box-shadow: 0 0 0 2px gold;\n}"}
          data-testid="custom-css"
        />
        <div className="ap-row">
          <button type="button" className="ap-btn ap-btn--primary" disabled={!cssDirty} onClick={() => commit({ ...overrides, globalCss: sanitizeCssText(css) })} data-testid="custom-css-save">
            <Check className="h-4 w-4" aria-hidden="true" /> {t(lang, "ins.save")}
          </button>
          <button type="button" className="ap-btn ap-btn--ghost" disabled={!cssDirty} onClick={() => setCss(overrides.globalCss)}>
            {t(lang, "ins.discard")}
          </button>
        </div>
      </Section>

      <Section title={t(lang, "ap.edit.data")}>
        <div className="ap-row">
          <button type="button" className="ap-btn ap-btn--ghost" onClick={download} data-testid="styles-export"><Download className="h-4 w-4" aria-hidden="true" /> {t(lang, "ins.export")}</button>
          <button type="button" className="ap-btn ap-btn--ghost" onClick={() => fileRef.current?.click()}><Upload className="h-4 w-4" aria-hidden="true" /> {t(lang, "ins.import")}</button>
          <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) upload(f); }} />
          <button type="button" className="ap-btn ap-btn--ghost" disabled={!styleStore.canUndo()} onClick={() => { if (styleStore.undo()) setMsg(t(lang, "ins.undone")); }}>
            <Undo2 className="h-4 w-4" aria-hidden="true" /> {t(lang, "ins.undo")}
          </button>
          <button type="button" className="ap-btn ap-btn--danger" onClick={() => { if (window.confirm(t(lang, "ap.edit.resetConfirm"))) commit({ ...EMPTY_OVERRIDES, rules: [], classes: [] }, t(lang, "ap.edit.resetDone")); }} data-testid="styles-reset">
            <Trash2 className="h-4 w-4" aria-hidden="true" /> {t(lang, "ap.edit.resetAll")}
          </button>
        </div>
        {msg ? <p className="ap-note" role="status">{msg}</p> : null}
      </Section>
    </>
  );
}
