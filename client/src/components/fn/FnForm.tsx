// A function's form (5.3: m5.out.form): fields in panels, one under another
// or side by side, labels above or beside, text, numbers, dates, masked
// values, selects and multi-selects with icons, switches… Submitting checks
// the values (required, numbers, e-mail, masks, patterns) and calls the
// model's form entry point with { name, values }.

import { useId, useMemo, useState, type ReactNode } from "react";
import { applyMask, checkFormValues, formFields, maskPlaceholder, maskTokens, type FormField, type FormPanel, type FormSpec } from "../../lib/fn-outputs";
import { t, tf, type Lang } from "../../lib/i18n";
import { Markdown } from "../Markdown";
import { FnSelect } from "./FnSelect";

type Values = Record<string, unknown>;

/** The value a field starts with (its default, or the empty value of its type). */
export function initialValue(f: FormField): unknown {
  const d = f.default;
  switch (f.type) {
    case "checkbox": case "switch": return d === true || d === "true" || d === 1;
    case "multiselect": return Array.isArray(d) ? d.map(String) : d === undefined || d === null || d === "" ? [] : [String(d)];
    case "number": case "range": return d === undefined || d === null || d === "" ? (f.type === "range" ? f.min ?? 0 : "") : Number(d);
    default: return d === undefined || d === null ? "" : typeof d === "string" ? d : String(d);
  }
}

const PROBLEM_KEYS: Record<string, string> = { required: "fnui.required", email: "fnui.email", number: "fnui.number", incomplete: "fnui.incomplete" };

export function FnForm({ spec, lang, disabled, onSubmit }: { spec: FormSpec; lang: Lang; disabled?: boolean; onSubmit: (values: Values) => Promise<boolean> }) {
  const all = useMemo(() => formFields(spec), [spec]);
  const [values, setValues] = useState<Values>(() => Object.fromEntries(all.filter((f) => f.name).map((f) => [f.name, initialValue(f)])));
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const formId = useId();
  const locked = disabled || state === "busy" || (spec.once === true && state === "done");

  const set = (name: string, v: unknown) => { setValues((cur) => ({ ...cur, [name]: v })); if (problems[name]) setProblems((p) => { const n = { ...p }; delete n[name]; return n; }); };

  const submit = async () => {
    // Numbers go as numbers; an empty number field is left out.
    const out: Values = {};
    for (const f of all) {
      if (!f.name || f.type === "static" || f.type === "separator") continue;
      const v = values[f.name];
      if ((f.type === "number" || f.type === "range") && v !== "" && v !== undefined) out[f.name] = Number(v);
      else if (!((f.type === "number") && v === "")) out[f.name] = v;
    }
    const found = checkFormValues(spec, out);
    setProblems(found);
    if (Object.keys(found).length) return;
    setState("busy");
    const ok = await onSubmit(out).catch(() => false);
    setState(ok ? "done" : "idle");
  };

  const labelsOf = (f: FormField, panel?: FormPanel) => f.labels ?? panel?.labels ?? spec.labels ?? "top";
  const field = (f: FormField, panel: FormPanel | undefined, key: string) => {
    if (f.type === "separator") return <hr key={key} className="fn-form__sep" />;
    if (f.type === "static") return <div key={key} className="fn-form__static" style={f.span ? { gridColumn: `span ${f.span}` } : undefined}><Markdown text={f.text || f.label || ""} className="md-fn" /></div>;
    if (f.type === "hidden") return null;
    const id = `${formId}-${f.name}`;
    const labelId = `${id}-label`;
    const problem = problems[f.name];
    const v = values[f.name];
    const control = renderControl(f, v, (x) => set(f.name, x), { id, labelId, invalid: Boolean(problem), disabled: locked || f.readonly, lang });
    const inline = f.type === "checkbox" || f.type === "switch";
    return (
      <div key={key} className={`fn-form__field fn-form__field--${labelsOf(f, panel)}${inline ? " fn-form__field--inline" : ""}${problem ? " fn-form__field--invalid" : ""}`} style={f.span ? { gridColumn: `span ${f.span}` } : undefined}>
        {inline ? null : f.label ? <label className="fn-form__label" id={labelId} htmlFor={id}>{f.label}{f.required ? <span className="fn-form__req" aria-hidden> *</span> : null}</label> : <span id={labelId} hidden>{f.name}</span>}
        <div className="fn-form__control">
          {inline ? <label className="fn-form__check">{control}<span id={labelId}>{f.label || f.name}{f.required ? <span className="fn-form__req" aria-hidden> *</span> : null}</span></label> : control}
          {f.help ? <div className="fn-form__help">{f.help}</div> : null}
          {problem ? <div className="fn-form__problem" role="alert">{t(lang, PROBLEM_KEYS[problem] ?? "fnui.invalid")}{/^(min|max) /.test(problem) ? ` (${problem})` : ""}</div> : null}
        </div>
      </div>
    );
  };
  const grid = (fields: FormField[], panel: FormPanel | undefined, cols: number, key: string): ReactNode => (
    <div key={key} className="fn-form__grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {fields.map((f, i) => field(f, panel, `${key}.${i}`))}
    </div>
  );
  const panelCols = (p: FormPanel) => (p.layout === "columns" ? p.columns ?? 2 : p.columns ?? 1);

  return (
    <form className="fn-form" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate aria-busy={state === "busy" || undefined}>
      {spec.title ? <div className="fn-form__title">{spec.title}</div> : null}
      {spec.text ? <div className="fn-form__text"><Markdown text={spec.text} className="md-fn" /></div> : null}
      {spec.fields?.length ? grid(spec.fields, undefined, spec.columns ?? 1, "f") : null}
      {(spec.panels ?? []).map((p, i) => {
        const body = (<>{p.text ? <div className="fn-form__text"><Markdown text={p.text} className="md-fn" /></div> : null}{grid(p.fields, p, panelCols(p), `p${i}`)}</>);
        return p.collapsed
          ? <details key={i} className="fn-form__panel"><summary className="fn-form__legend">{p.title || "…"}</summary>{body}</details>
          : <fieldset key={i} className="fn-form__panel">{p.title ? <legend className="fn-form__legend">{p.title}</legend> : null}{body}</fieldset>;
      })}
      <div className="fn-form__actions">
        <button type="submit" className="fn-btn fn-btn--primary" disabled={locked}>{state === "busy" ? t(lang, "fnui.sending") : state === "done" && spec.once ? t(lang, "fnui.sent") : spec.submit || t(lang, "fnui.submit")}</button>
      </div>
    </form>
  );
}

function renderControl(f: FormField, v: unknown, set: (v: unknown) => void, o: { id: string; labelId: string; invalid: boolean; disabled?: boolean; lang: Lang }): ReactNode {
  const common = { id: o.id, name: f.name, disabled: o.disabled, "aria-invalid": o.invalid || undefined, "aria-required": f.required || undefined, placeholder: f.placeholder, className: "fn-input" };
  const text = typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
  switch (f.type) {
    case "textarea": return <textarea {...common} rows={f.rows ?? 3} value={text} onChange={(e) => set(e.target.value)} />;
    case "number": return <input {...common} type="number" inputMode="decimal" min={f.min} max={f.max} step={f.step ?? "any"} value={text} onChange={(e) => set(e.target.value)} />;
    case "range": return (
      <span className="fn-range"><input {...common} type="range" min={f.min ?? 0} max={f.max ?? 100} step={f.step ?? 1} value={Number(v) || 0} onChange={(e) => set(Number(e.target.value))} /><output className="fn-range__value">{String(v)}</output></span>
    );
    case "tel": return <input {...common} type="tel" inputMode="tel" autoComplete="tel" value={text} onChange={(e) => set(e.target.value)} />;
    case "email": return <input {...common} type="email" inputMode="email" autoComplete="email" value={text} onChange={(e) => set(e.target.value)} />;
    case "url": return <input {...common} type="url" inputMode="url" value={text} onChange={(e) => set(e.target.value)} />;
    case "password": return <input {...common} type="password" autoComplete="off" value={text} onChange={(e) => set(e.target.value)} />;
    case "date": return <input {...common} type="date" value={text} onChange={(e) => set(e.target.value)} />;
    case "time": return <input {...common} type="time" value={text} onChange={(e) => set(e.target.value)} />;
    case "datetime": return <input {...common} type="datetime-local" value={text} onChange={(e) => set(e.target.value)} />;
    case "month": return <input {...common} type="month" value={text} onChange={(e) => set(e.target.value)} />;
    case "color": return <input {...common} type="color" value={/^#[0-9a-f]{6}$/i.test(text) ? text : "#000000"} onChange={(e) => set(e.target.value)} />;
    case "masked": {
      const mask = f.mask || "";
      const tokens = maskTokens(mask);
      const numeric = tokens.every((tk) => !("slot" in tk) || tk.slot === "0");
      return <input {...common} type="text" inputMode={numeric ? "numeric" : "text"} placeholder={f.placeholder || maskPlaceholder(mask)} value={text} maxLength={tokens.length || undefined} onChange={(e) => set(mask ? applyMask(mask, e.target.value) : e.target.value)} />;
    }
    case "select": case "multiselect":
      return <FnSelect options={f.options ?? []} value={f.type === "multiselect" ? (Array.isArray(v) ? v as string[] : []) : text} multiple={f.type === "multiselect"} placeholder={f.placeholder || t(o.lang, "fnui.choose")} chosenLabel={(n) => tf(o.lang, "fnui.chosen", { n })} disabled={o.disabled} invalid={o.invalid} labelledBy={o.labelId} onChange={set} />;
    case "radio": return (
      <div className="fn-radios" role="radiogroup" aria-labelledby={o.labelId} aria-invalid={o.invalid || undefined}>
        {(f.options ?? []).map((opt) => (
          <label key={opt.value} className={`fn-radio${text === opt.value ? " fn-radio--on" : ""}`}>
            <input type="radio" name={o.id} value={opt.value} checked={text === opt.value} disabled={o.disabled} onChange={() => set(opt.value)} />
            {opt.icon ? <span className="fn-select__icon" aria-hidden>{opt.icon}</span> : null}{opt.label}
          </label>
        ))}
      </div>
    );
    case "checkbox": return <input id={o.id} name={f.name} type="checkbox" checked={v === true} disabled={o.disabled} aria-invalid={o.invalid || undefined} onChange={(e) => set(e.target.checked)} />;
    case "switch": return <input id={o.id} name={f.name} type="checkbox" role="switch" className="fn-switch" checked={v === true} disabled={o.disabled} aria-invalid={o.invalid || undefined} onChange={(e) => set(e.target.checked)} />;
    default: return <input {...common} type="text" pattern={f.pattern} value={text} onChange={(e) => set(e.target.value)} />;
  }
}
