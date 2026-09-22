// Colour field for the Appearance screen: a swatch button that unfolds the
// extended palette (18 hues × 6 shades + a neutral ramp), a native colour
// picker and a hex input. Optional presets (e.g. the template accents) and an
// "empty" choice that hands the colour back to the template.

import { useEffect, useId, useState } from "react";
import { Check, ChevronDown, Pipette, RotateCcw } from "lucide-react";
import { PALETTE, PALETTE_HUES, contrastRatio, isHexColor, readableOn } from "@/lib/color";
import { t, type Lang } from "@/lib/i18n";

export type ColorPreset = { id: string; color: string; label: string };

type Props = {
  label: string;
  value: string;
  onChange: (hex: string) => void;
  lang: Lang;
  /** Offer an explicit "template default" choice (value ""). */
  allowEmpty?: boolean;
  presets?: ColorPreset[];
  /** Which preset is active when value is "" (e.g. the chosen accent preset). */
  activePreset?: string;
  onPreset?: (id: string) => void;
  hint?: string;
  testId?: string;
  defaultOpen?: boolean;
};

export function ColorField({ label, value, onChange, lang, allowEmpty, presets, activePreset, onPreset, hint, testId, defaultOpen }: Props) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const [hex, setHex] = useState(value);
  const panelId = useId();
  useEffect(() => setHex(value), [value]);

  const current = isHexColor(value) ? value.toLowerCase() : "";
  const commitHex = (v: string) => {
    const norm = v.startsWith("#") ? v : `#${v}`;
    if (isHexColor(norm)) onChange(norm.toLowerCase());
  };
  const contrast = current ? contrastRatio(current, readableOn(current)) : 0;

  return (
    <div className="ap-color" data-testid={testId}>
      <div className="ap-color__row">
        <span className="ap-color__label">{label}</span>
        <button
          type="button"
          className="ap-color__trigger"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((o) => !o)}
          data-testid={testId ? `${testId}-toggle` : undefined}
        >
          <span className="ap-swatch ap-swatch--lg" style={{ background: current || "transparent" }} data-empty={current ? undefined : "true"} />
          <span className="ap-color__value">{current || t(lang, "ap.color.template")}</span>
          <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
        </button>
      </div>
      {hint ? <p className="ap-hint">{hint}</p> : null}
      {open ? (
        <div id={panelId} className="ap-color__panel">
          {presets?.length ? (
            <div className="ap-color__presets" role="group" aria-label={t(lang, "ap.color.presets")}>
              {presets.map((p) => {
                const on = !current && activePreset === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    className="ap-swatch ap-swatch--preset"
                    style={{ background: p.color }}
                    aria-pressed={on}
                    aria-label={p.label}
                    title={p.label}
                    onClick={() => onPreset?.(p.id)}
                    data-testid={testId ? `${testId}-preset-${p.id}` : undefined}
                  >
                    {on ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : null}
                  </button>
                );
              })}
            </div>
          ) : null}
          <div className="ap-palette" role="group" aria-label={t(lang, "ap.color.palette")}>
            {PALETTE.slice(0, PALETTE_HUES.length).map((row, ri) => (
              <div key={PALETTE_HUES[ri].name} className="ap-palette__col" title={PALETTE_HUES[ri].name}>
                {row.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className="ap-swatch"
                    style={{ background: c, color: readableOn(c) }}
                    aria-label={c}
                    aria-pressed={current === c}
                    onClick={() => onChange(c)}
                  >
                    {current === c ? <Check className="h-3 w-3" aria-hidden="true" /> : null}
                  </button>
                ))}
              </div>
            ))}
          </div>
          <div className="ap-palette__neutral" role="group" aria-label={t(lang, "ap.color.neutral")}>
            {PALETTE[PALETTE.length - 1].map((c) => (
              <button
                key={c}
                type="button"
                className="ap-swatch"
                style={{ background: c, color: readableOn(c) }}
                aria-label={c}
                aria-pressed={current === c}
                onClick={() => onChange(c)}
              >
                {current === c ? <Check className="h-3 w-3" aria-hidden="true" /> : null}
              </button>
            ))}
          </div>
          <div className="ap-color__custom">
            <label className="ap-color__picker" title={t(lang, "ap.color.custom")}>
              <Pipette className="h-4 w-4" aria-hidden="true" />
              <input
                type="color"
                value={current || "#3b82f6"}
                onChange={(e) => onChange(e.target.value)}
                aria-label={t(lang, "ap.color.custom")}
              />
            </label>
            <input
              className="ap-input ap-input--mono"
              value={hex}
              maxLength={7}
              spellCheck={false}
              placeholder="#rrggbb"
              aria-label="hex"
              onChange={(e) => setHex(e.target.value)}
              onBlur={() => commitHex(hex)}
              onKeyDown={(e) => { if (e.key === "Enter") commitHex(hex); }}
              data-testid={testId ? `${testId}-hex` : undefined}
            />
            {current ? (
              <span className={`ap-contrast ${contrast >= 4.5 ? "is-ok" : "is-low"}`} title={t(lang, "ap.color.contrast")}>
                {contrast.toFixed(1)}:1
              </span>
            ) : null}
            {allowEmpty && current ? (
              <button type="button" className="ap-btn ap-btn--ghost" onClick={() => onChange("")}>
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                {t(lang, "ap.color.template")}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
