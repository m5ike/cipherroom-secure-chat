// A running command's live question — a port of android/…/fn/FnAsk.java
// (m5.prompt / m5.form; the fn-ask dialog in App.tsx): choices to tap, a line
// to type, or a small form — the answer (the choice or text, the form's values
// as text, nil for Cancel) goes to the engine, which sends it
// (FnCommandsClient.answer) and starts the run's clock again.
//
// 6.11: a form's fields follow their type — a number's keyboard, an e-mail
// address's, a phone's, a switch for a yes / no, several lines for a text, a
// hidden one for a secret — and a required field must be filled before the
// form goes (the values still go as text, as the web sends them).

import M5Core
import M5Proto
import SwiftUI

struct FnAskView: View {
    let interaction: FnRun.Interaction
    /// The title when the question has none (the model's name).
    let fallbackTitle: String
    let look: ToolsLook
    /// Exactly once: the answer (nil = cancelled).
    let answer: (JSON?) -> Void

    @State private var line = ""
    @State private var texts: [String: String] = [:]
    @State private var switches: [String: Bool] = [:]
    @State private var choices: [String: String] = [:]
    @State private var missing: Set<String> = []
    @State private var answered = false

    var body: some View {
        let i = interaction
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text(verbatim: i.title.isEmpty ? fallbackTitle : i.title).toolsFont(17, weight: .bold).foregroundStyle(look.color("@onSurface"))
                if !i.text.isEmpty { Text(verbatim: i.text).toolsFont(15).foregroundStyle(look.color("@onSurface")).fixedSize(horizontal: false, vertical: true) }
                if i.kind == "prompt" && !i.choices.isEmpty {
                    FnFlowLayout(spacing: 6) {
                        ForEach(i.choices, id: \.self) { c in button(c, primary: true, fill: false) { once(.string(c)) } }
                    }
                } else if i.kind == "prompt" {
                    input(placeholder: i.placeholder, type: "", text: $line)
                        .onSubmit { once(.string(line)) }
                    button(look.words("functions.send"), primary: true) { once(.string(line)) }
                } else {
                    ForEach(i.fields, id: \.name) { f in field(f) }
                    if !missing.isEmpty { Text(verbatim: look.words("fnm.ask.required")).toolsFont(13).foregroundStyle(look.color("@danger")) }
                    button(i.submit.isEmpty ? look.words("functions.send") : i.submit, primary: true) { submitForm() }
                }
                button(look.words("functions.cancel"), primary: false) { once(nil) }
            }
            .padding(12)
        }
        .background(look.color("@surface"))
        .onDisappear { once(nil) }
    }

    private func once(_ v: JSON?) {
        if answered { return }
        answered = true
        answer(v)
    }

    /// The form's values as text (a choice: its first value until another is picked).
    static func values(_ fields: [FnRun.Interaction.Field], texts: [String: String], switches: [String: Bool], choices: [String: String]) -> JSONObject {
        var out = JSONObject()
        for f in fields {
            let type = f.type.lowercased()
            if !f.values.isEmpty { out[f.name] = .string(choices[f.name] ?? f.values[0]) }
            else if ["boolean", "bool", "checkbox", "switch"].contains(type) { out[f.name] = .string(switches[f.name] == true ? "true" : "false") }
            else { out[f.name] = .string(texts[f.name] ?? "") }
        }
        return out
    }

    /// The required text fields left empty.
    static func missing(_ fields: [FnRun.Interaction.Field], texts: [String: String]) -> Set<String> {
        Set(fields.filter { f in
            f.required && f.values.isEmpty && !["boolean", "bool", "checkbox", "switch"].contains(f.type.lowercased())
                && (texts[f.name] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }.map(\.name))
    }

    private func submitForm() {
        let fields = interaction.fields
        missing = Self.missing(fields, texts: texts)
        if !missing.isEmpty { return }
        once(.object(Self.values(fields, texts: texts, switches: switches, choices: choices)))
    }

    @ViewBuilder
    private func field(_ f: FnRun.Interaction.Field) -> some View {
        let type = f.type.lowercased()
        let label = (f.label.isEmpty ? f.name : f.label) + (f.required ? " *" : "")
        if !f.values.isEmpty {
            Text(verbatim: label).toolsFont(15).foregroundStyle(look.color("@onSurface"))
            Picker(selection: Binding(get: { choices[f.name] ?? f.values[0] }, set: { choices[f.name] = $0 })) {
                ForEach(f.values, id: \.self) { Text(verbatim: $0).tag($0) }
            } label: { Text(verbatim: label) }
                .pickerStyle(.menu)
                .tint(look.color("@primary"))
                .frame(minHeight: 44)
        } else if ["boolean", "bool", "checkbox", "switch"].contains(type) {
            Toggle(isOn: Binding(get: { switches[f.name] ?? false }, set: { switches[f.name] = $0 })) {
                Text(verbatim: label).toolsFont(15).foregroundStyle(look.color("@onSurface"))
            }
            .tint(look.color("@primary"))
            .frame(minHeight: 44)
        } else {
            Text(verbatim: label).toolsFont(15).foregroundStyle(look.color("@onSurface"))
            input(placeholder: f.placeholder, type: type, text: Binding(get: { texts[f.name] ?? "" }, set: { texts[f.name] = $0; missing.remove(f.name) }))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(missing.contains(f.name) ? look.color("@danger") : .clear, lineWidth: 1))
                .accessibilityLabel(Text(verbatim: label))
        }
    }

    /// The keyboard and lines a field's type wants (FnAsk.inputType).
    @ViewBuilder
    private func input(placeholder: String, type: String, text: Binding<String>) -> some View {
        let prompt = placeholder.isEmpty ? nil : Text(verbatim: placeholder)
        Group {
            switch type {
            case "password", "secret": SecureField("", text: text, prompt: prompt)
            case "text", "textarea", "multiline": TextField("", text: text, prompt: prompt, axis: .vertical).lineLimit(3...8)
            default: TextField("", text: text, prompt: prompt)
            }
        }
        .keyboardType(Self.keyboard(type))
        .textInputAutocapitalization(Self.capitalize(type) ? .sentences : .never)
        .toolsFont(15)
        .foregroundStyle(look.color("@onSurface"))
        .padding(.horizontal, 10).padding(.vertical, 8)
        .frame(minHeight: 48)
        .background(RoundedRectangle(cornerRadius: 8).fill(look.color("@surfaceVariant")))
    }

    static func keyboard(_ type: String) -> UIKeyboardType {
        switch type {
        case "number": return .decimalPad
        case "integer", "int": return .numberPad
        case "email": return .emailAddress
        case "phone", "tel": return .phonePad
        case "url", "hostname": return .URL
        default: return .default
        }
    }

    static func capitalize(_ type: String) -> Bool { !["email", "url", "hostname", "password", "secret", "number", "integer", "int", "phone", "tel"].contains(type) }

    private func button(_ s: String, primary: Bool, fill: Bool = true, _ tap: @escaping () -> Void) -> some View {
        Button(action: tap) {
            Text(verbatim: s).toolsFont(15, weight: .bold)
                .foregroundStyle(look.color(primary ? "@onPrimary" : "@onSurface"))
                .frame(maxWidth: fill ? .infinity : nil, minHeight: 44)
                .padding(.horizontal, 14)
                .background(RoundedRectangle(cornerRadius: 10).fill(primary ? look.color("@primary") : .clear))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(look.color(primary ? "@primary" : "@border"), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}
