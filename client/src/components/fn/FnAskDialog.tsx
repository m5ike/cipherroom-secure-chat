// A running command's live question (m5.prompt / m5.form) above the composer
// (4.15). 6.11: a form's fields keep their types — a number, an e-mail, a
// phone number, a web address, a date or time, a password, a choice from its
// values (a select), yes / no (a checkbox), a longer text (a textarea) — and
// a required one must be filled before the form goes (the browser says which).
// A number goes back as a number and a checkbox as true / false, as the
// message forms do (FnForm.tsx).

import type { FormEvent } from "react";
import type { FormField, Interaction } from "../../lib/functions";
import { t, type Lang } from "../../lib/i18n";

/** A form field as a model may describe it (more than FormField names). */
type AskField = FormField & { help?: string; default?: unknown; min?: number; max?: number; step?: number; rows?: number; options?: Array<{ value: string; label?: string } | string> };

export type AskKind = "select" | "checkbox" | "textarea" | "number" | "email" | "tel" | "url" | "date" | "time" | "datetime-local" | "password" | "text";

/** The control a field is asked with. */
export function askFieldKind(f: AskField): AskKind {
  const type = (f.type || "text").toLowerCase();
  if (type === "boolean" || type === "bool" || type === "checkbox" || type === "switch") return "checkbox";
  if (askOptions(f).length) return "select";
  if (type === "textarea" || type === "longtext" || type === "multiline" || type === "markdown") return "textarea";
  if (type === "number" || type === "integer" || type === "int" || type === "float" || type === "range") return "number";
  if (type === "email") return "email";
  if (type === "tel" || type === "phone") return "tel";
  if (type === "url") return "url";
  if (type === "date") return "date";
  if (type === "time") return "time";
  if (type === "datetime") return "datetime-local";
  if (type === "password" || type === "secret") return "password";
  return "text";
}

/** A field's choices: its values (or options), as value + label. */
export function askOptions(f: AskField): Array<{ value: string; label: string }> {
  if (Array.isArray(f.values) && f.values.length) return f.values.map((v) => ({ value: String(v), label: String(v) }));
  if (Array.isArray(f.options) && f.options.length) {
    return f.options.map((o) => (typeof o === "string" ? { value: o, label: o } : { value: String(o.value), label: String(o.label ?? o.value) }));
  }
  return [];
}

const fieldId = (name: string) => `fnfield_${name}`;

/** The values a submitted form gives back, typed by its fields. */
export function askValues(form: HTMLFormElement, fields: AskField[]): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  for (const f of fields) {
    const el = form.elements.namedItem(fieldId(f.name)) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
    if (!el) continue;
    const kind = askFieldKind(f);
    if (kind === "checkbox") v[f.name] = (el as HTMLInputElement).checked;
    else if (kind === "number") v[f.name] = el.value.trim() === "" ? "" : Number(el.value);
    else v[f.name] = el.value;
  }
  return v;
}

function AskControl({ f }: { f: AskField }) {
  const kind = askFieldKind(f);
  const id = fieldId(f.name);
  const required = Boolean(f.required);
  const def = f.default === undefined || f.default === null || typeof f.default === "object" ? undefined : String(f.default);
  if (kind === "checkbox") return <input id={id} name={id} type="checkbox" className="fn-ask__check" defaultChecked={f.default === true || def === "true"} data-kind={kind} />;
  if (kind === "select") {
    const opts = askOptions(f);
    return (
      <select id={id} name={id} className="fn-ask__input" required={required} defaultValue={def ?? ""} data-kind={kind}>
        <option value="" disabled={required}>{f.placeholder || "—"}</option>
        {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  }
  if (kind === "textarea") return <textarea id={id} name={id} className="fn-ask__input" rows={f.rows ?? 3} required={required} placeholder={f.placeholder || ""} defaultValue={def} data-kind={kind} />;
  return (
    <input
      id={id} name={id} className="fn-ask__input" type={kind} required={required} placeholder={f.placeholder || ""} defaultValue={def} data-kind={kind}
      {...(kind === "number" ? { min: f.min, max: f.max, step: f.step ?? "any", inputMode: "decimal" as const } : {})}
      {...(kind === "tel" ? { inputMode: "tel" as const, autoComplete: "tel" } : kind === "email" ? { autoComplete: "email" } : {})}
    />
  );
}

export function FnAskDialog({ interaction, lang, onAnswer }: { interaction: Interaction; lang: Lang; onAnswer: (value: unknown) => void }) {
  const spec = interaction.spec;
  const fields = (spec.fields || []) as AskField[];
  const submitForm = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); onAnswer(askValues(e.currentTarget, fields)); };
  return (
    <div className="cmd-menu fn-ask" role="dialog" aria-label={spec.text || spec.title || interaction.kind} data-testid="fn-interaction">
      {spec.title ? <div className="fn-ask__title">{spec.title}</div> : null}
      {spec.text ? <div className="fn-ask__text">{spec.text}</div> : null}
      {interaction.kind === "prompt" && spec.choices?.length ? (
        <div className="fn-ask__choices">
          {spec.choices.map((c) => (
            <button key={c} type="button" className="fn-ask__choice" onClick={() => onAnswer(c)}>{c}</button>
          ))}
        </div>
      ) : interaction.kind === "prompt" ? (
        <form className="fn-ask__row" onSubmit={(e) => { e.preventDefault(); const el = e.currentTarget.elements.namedItem("fnprompt") as HTMLInputElement | null; onAnswer(el?.value ?? ""); }}>
          <input id="fnprompt" name="fnprompt" className="fn-ask__input" autoFocus placeholder={spec.placeholder || ""} />
          <button type="submit" className="fn-ask__choice">{t(lang, "functions.send")}</button>
        </form>
      ) : (
        <form className="fn-ask__form" onSubmit={submitForm}>
          {fields.map((f) => (
            askFieldKind(f) === "checkbox" ? (
              <label key={f.name} className="fn-ask__field fn-ask__field--check">
                <AskControl f={f} />
                <span>{f.label || f.name}{f.required ? " *" : ""}</span>
              </label>
            ) : (
              <label key={f.name} className="fn-ask__field">
                <span>{f.label || f.name}{f.required ? " *" : ""}</span>
                <AskControl f={f} />
                {f.help ? <small className="fn-ask__help">{f.help}</small> : null}
              </label>
            )
          ))}
          <button type="submit" className="fn-ask__choice">{spec.submit || t(lang, "functions.send")}</button>
        </form>
      )}
      <button type="button" className="fn-ask__cancel" onClick={() => onAnswer(null)}>{t(lang, "functions.cancel")}</button>
    </div>
  );
}
