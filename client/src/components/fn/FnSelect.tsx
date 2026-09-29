// A select with icons (5.3), for a function's form: one value (select) or
// several (multiselect). A native <select> cannot show an icon beside each
// option, so this is a button with a list box — keyboard included (↑ ↓ Home
// End to move, Enter / Space to pick, Esc to close).

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { FormOption } from "../../lib/fn-outputs";

type Props = {
  options: FormOption[];
  value: string | string[];
  multiple?: boolean;
  placeholder: string;
  chosenLabel: (n: number) => string;
  disabled?: boolean;
  invalid?: boolean;
  labelledBy?: string;
  onChange: (value: string | string[]) => void;
};

export function FnSelect({ options, value, multiple, placeholder, chosenLabel, disabled, invalid, labelledBy, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selected = new Set(Array.isArray(value) ? value : value ? [value] : []);
  const current = options.filter((o) => selected.has(o.value));

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const pick = (o: FormOption) => {
    if (multiple) {
      const next = new Set(selected);
      if (next.has(o.value)) next.delete(o.value); else next.add(o.value);
      onChange(options.filter((x) => next.has(x.value)).map((x) => x.value));
    } else {
      onChange(o.value);
      setOpen(false);
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (disabled) return;
    if (!open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) { e.preventDefault(); setOpen(true); setActive(Math.max(0, options.findIndex((o) => selected.has(o.value)))); return; }
    if (!open) return;
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(options.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Home") { e.preventDefault(); setActive(0); }
    else if (e.key === "End") { e.preventDefault(); setActive(options.length - 1); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); const o = options[active]; if (o) pick(o); }
  };

  return (
    <div className={`fn-select${open ? " fn-select--open" : ""}${invalid ? " fn-select--invalid" : ""}`} ref={root}>
      <button
        type="button"
        className="fn-select__button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-labelledby={labelledBy}
        aria-invalid={invalid || undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKey}
      >
        {multiple ? (
          current.length ? (
            <span className="fn-select__chips">
              {current.slice(0, 4).map((o) => <span key={o.value} className="fn-select__chip">{o.icon ? <span className="fn-select__icon" aria-hidden>{o.icon}</span> : null}{o.label}</span>)}
              {current.length > 4 ? <span className="fn-select__more">{chosenLabel(current.length)}</span> : null}
            </span>
          ) : <span className="fn-select__placeholder">{placeholder}</span>
        ) : current[0] ? (
          <span className="fn-select__value">{current[0].icon ? <span className="fn-select__icon" aria-hidden>{current[0].icon}</span> : null}{current[0].label}</span>
        ) : <span className="fn-select__placeholder">{placeholder}</span>}
        <span className="fn-select__caret" aria-hidden>▾</span>
      </button>
      {open ? (
        <ul className="fn-select__list" role="listbox" id={listId} aria-multiselectable={multiple || undefined} aria-labelledby={labelledBy}>
          {options.map((o, i) => (
            <li
              key={o.value}
              role="option"
              aria-selected={selected.has(o.value)}
              className={`fn-select__option${i === active ? " fn-select__option--active" : ""}${selected.has(o.value) ? " fn-select__option--on" : ""}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => { e.preventDefault(); pick(o); }}
            >
              {multiple ? <span className="fn-select__check" aria-hidden>{selected.has(o.value) ? "☑" : "☐"}</span> : null}
              {o.icon ? <span className="fn-select__icon" aria-hidden>{o.icon}</span> : null}
              <span>{o.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
