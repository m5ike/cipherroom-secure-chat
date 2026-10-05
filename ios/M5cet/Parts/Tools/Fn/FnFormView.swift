// A function's form — a port of android/…/fn/FnForm.java (FnForm.tsx;
// m5.out.form): fields in panels, in rows of columns, labels above or beside;
// text, numbers, ranges, dates and times, masked values, selects,
// multi-selects, radios, checkboxes, switches… Submitting checks the values
// like the web (Outputs.checkFormValues) and hands { name: value } to the
// model's form entry point.

import M5Core
import M5Design
import M5Proto
import Observation
import SwiftUI

/// The values of a form and what is wrong with them (pure: the view draws it, the tests drive it).
@MainActor
@Observable
final class FnFormState {
    let spec: JSONObject
    /// Every field that holds a value (hidden ones too), in order.
    let fields: [JSONObject]
    var values: [String: JSON] = [:]
    var problems: [String: String] = [:]
    /// idle, busy, done.
    var state = "idle"

    init(spec: JSONObject, sent: Bool = false) {
        self.spec = spec
        fields = Outputs.formFields(spec).filter { f in
            let t = f.optString("type", "text")
            return t != "separator" && t != "static" && !f.optString("name").isEmpty
        }
        for f in fields { values[f.optString("name")] = Self.initialValue(f) }
        state = sent ? "done" : "idle"
    }

    var once: Bool { spec["once"] == .bool(true) }

    /// The form takes no more input: the model does not answer forms, it is sending, or a once-form went.
    func locked(reachable: Bool) -> Bool { !reachable || state == "busy" || (once && state == "done") }

    /// initialValue() in FnForm.tsx: the default, or the empty value of the type.
    static func initialValue(_ f: JSONObject) -> JSON {
        let d = f["default"]
        let none = d == nil || d == .null
        switch f.optString("type") {
        case "checkbox", "switch":
            if case .bool(true)? = d { return true }
            if case .string("true")? = d { return true }
            if case .number(let n)? = d, n.double == 1 { return true }
            return false
        case "multiselect":
            if case .array(let a)? = d { return .array(a.map { .string(Js.str($0)) }) }
            if !none, d != .string("") { return .array([.string(Js.str(d))]) }
            return .array([])
        case "number", "range":
            if none || d == .string("") {
                if f.optString("type") == "range" { if case .number? = f["min"] { return f["min"]! }; return .int(0) }
                return ""
            }
            return number(Js.toNumber(d))
        default:
            if none { return "" }
            if case .string? = d { return d! }
            return .string(Js.str(d))
        }
    }

    /// A number as JSON keeps it: integral ones as integers.
    static func number(_ d: Double) -> JSON { d.isFinite && d == d.rounded() && abs(d) < 1e15 ? .int(Int64(d)) : .double(d) }

    func text(_ name: String) -> String {
        switch values[name] {
        case .string(let s)?: return s
        case let v?: return Js.str(v)
        default: return ""
        }
    }

    func set(_ name: String, _ v: JSON) {
        values[name] = v
        problems[name] = nil
    }

    /// The values to send: numbers as numbers; an empty number field is left out (FnForm.tsx submit()).
    func collect() -> JSONObject {
        var out = JSONObject()
        for f in fields {
            let name = f.optString("name"), type = f.optString("type", "text")
            let v = values[name] ?? ""
            let isNumber = type == "number" || type == "range"
            if isNumber && v != .string("") {
                let n = Js.toNumber(v)
                out[name] = n.isFinite ? Self.number(n) : v
            } else if !(type == "number" && v == .string("")) {
                out[name] = v
            }
        }
        return out
    }

    /// Checks the values; nil when something is wrong (the problems show), else the values to send.
    func check() -> JSONObject? {
        let out = collect()
        let p = Outputs.checkFormValues(spec, out)
        problems = p.dictionary
        return p.isEmpty ? out : nil
    }

    /// The words of a problem ("min 2" keeps its number).
    static func problemText(_ p: String, _ words: (String) -> String) -> String {
        let key = p == "required" ? "fnui.required" : p == "email" ? "fnui.email" : p == "number" ? "fnui.number" : p == "incomplete" ? "fnui.incomplete" : "fnui.invalid"
        return words(key) + (p.hasPrefix("min ") || p.hasPrefix("max ") ? " (" + p + ")" : "")
    }

    /// A field's options: (value, label with its icon).
    static func options(_ f: JSONObject) -> [(String, String)] {
        (f.array("options") ?? []).compactMap(\.objectValue).map { o in
            let icon = o.string("icon") ?? ""
            return (o.optString("value"), (icon.isEmpty ? "" : icon + " ") + o.optString("label"))
        }
    }
}

struct FnFormView: View {
    let spec: JSONObject
    let reachable: Bool
    let sent: Bool
    let look: ToolsLook
    let openLink: (String) -> Void
    /// The values go to the model; done(true) when it answered.
    let submit: (JSONObject, @escaping (Bool) -> Void) -> Void

    @State private var model: FnFormState

    init(spec: JSONObject, reachable: Bool, sent: Bool, look: ToolsLook, openLink: @escaping (String) -> Void,
         submit: @escaping (JSONObject, @escaping (Bool) -> Void) -> Void) {
        self.spec = spec
        self.reachable = reachable
        self.sent = sent
        self.look = look
        self.openLink = openLink
        self.submit = submit
        _model = State(initialValue: FnFormState(spec: spec, sent: sent))
    }

    var body: some View {
        let m = model
        VStack(alignment: .leading, spacing: 0) {
            if let title = spec.string("title"), !title.isEmpty {
                Text(verbatim: title).toolsFont(16, weight: .bold).foregroundStyle(look.color("@onSurface"))
            }
            if let text = spec.string("text"), !text.isEmpty {
                FnMarkdownView(text: text, look: look, size: 14, onLink: openLink).padding(.top, 4)
            }
            if let top = spec.array("fields"), !top.isEmpty {
                FnFormGrid(fields: top.compactMap(\.objectValue), panel: nil, cols: Self.clamp(spec["columns"]), form: m, reachable: reachable, look: look, openLink: openLink)
                    .padding(.top, 6)
            }
            ForEach(Array((spec.array("panels") ?? []).compactMap(\.objectValue).enumerated()), id: \.offset) { _, p in
                FnFormPanel(panel: p, form: m, reachable: reachable, look: look, openLink: openLink).padding(.top, 10)
            }
            Button { send(m) } label: {
                Text(verbatim: m.state == "busy" ? look.words("fnui.sending")
                     : m.state == "done" && m.once ? look.words("fnui.sent")
                     : (spec.string("submit").flatMap { $0.isEmpty ? nil : $0 } ?? look.words("fnui.submit")))
                    .toolsFont(15, weight: .bold)
                    .foregroundStyle(look.color("@onPrimary"))
                    .padding(.horizontal, 16).padding(.vertical, 9)
                    .background(RoundedRectangle(cornerRadius: 10).fill(look.color("@primary")))
            }
            .buttonStyle(.plain)
            .disabled(m.locked(reachable: reachable))
            .opacity(m.locked(reachable: reachable) ? 0.55 : 1)
            .padding(.top, 12)
        }
        .padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(look.color("@border"), lineWidth: 1))
    }

    static func clamp(_ v: JSON?) -> Int {
        guard case .number(let n)? = v else { return 1 }
        return max(1, min(4, Int(n.double)))
    }

    private func send(_ m: FnFormState) {
        guard !m.locked(reachable: reachable), let values = m.check() else { return }
        m.state = "busy"
        submit(values) { ok in m.state = ok ? "done" : "idle" }
    }
}

/// A fieldset: its title (a tap folds a collapsed one), its text, its fields.
private struct FnFormPanel: View {
    let panel: JSONObject
    let form: FnFormState
    let reachable: Bool
    let look: ToolsLook
    let openLink: (String) -> Void
    @State private var open: Bool?

    var body: some View {
        let collapsed = panel["collapsed"] == .bool(true)
        let isOpen = open ?? !collapsed
        let title = panel.string("title") ?? ""
        VStack(alignment: .leading, spacing: 4) {
            if collapsed || !title.isEmpty {
                Text(verbatim: collapsed ? (isOpen ? "▾ " : "▸ ") + (title.isEmpty ? "…" : title) : title)
                    .toolsFont(14, weight: .bold)
                    .foregroundStyle(look.color("@onSurface"))
                    .onTapGesture { if collapsed { open = !isOpen } }
            }
            if isOpen {
                if let text = panel.string("text"), !text.isEmpty { FnMarkdownView(text: text, look: look, size: 14, onLink: openLink) }
                let cols = panel["layout"] == .string("columns") ? FnFormView.clamp(panel["columns"] ?? .int(2)) : FnFormView.clamp(panel["columns"])
                FnFormGrid(fields: (panel.array("fields") ?? []).compactMap(\.objectValue), panel: panel, cols: cols, form: form, reachable: reachable, look: look, openLink: openLink)
            }
        }
    }
}

/// Fields in rows of cols columns; a field takes span of them.
private struct FnFormGrid: View {
    let fields: [JSONObject]
    let panel: JSONObject?
    let cols: Int
    let form: FnFormState
    let reachable: Bool
    let look: ToolsLook
    let openLink: (String) -> Void

    private var rows: [[(JSONObject, Int)]] {
        var out = [[(JSONObject, Int)]]()
        var used = 0
        for f in fields {
            let type = f.optString("type")
            if type == "hidden" { continue }
            let span = type == "separator" || (type == "static" && !f.has("span")) ? cols : min(cols, max(1, f.optInt("span", 1)))
            if out.isEmpty || used + span > cols { out.append([]); used = 0 }
            out[out.count - 1].append((f, span))
            used += span
        }
        return out
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(alignment: .top, spacing: 8) {
                    ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                        FnFormField(spec: cell.0, panel: panel, form: form, reachable: reachable, look: look, openLink: openLink)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .layoutPriority(Double(cell.1))
                    }
                    let left = cols - row.reduce(0) { $0 + $1.1 }
                    if left > 0 { ForEach(0..<left, id: \.self) { _ in Color.clear.frame(maxWidth: .infinity, maxHeight: 0) } }
                }
            }
        }
    }
}

/// A field with its label (above or beside), help and problem.
private struct FnFormField: View {
    let spec: JSONObject
    let panel: JSONObject?
    let form: FnFormState
    let reachable: Bool
    let look: ToolsLook
    let openLink: (String) -> Void

    private var name: String { spec.optString("name") }
    private var type: String { spec.optString("type", "text") }
    private var disabled: Bool { form.locked(reachable: reachable) || spec["readonly"] == .bool(true) }

    var body: some View {
        if type == "separator" {
            Rectangle().fill(look.color("@border")).frame(height: 1)
        } else if type == "static" {
            FnMarkdownView(text: (spec.string("text").flatMap { $0.isEmpty ? nil : $0 }) ?? spec.optString("label"), look: look, size: 14, onLink: openLink)
        } else {
            let required = spec["required"] == .bool(true)
            let text = (spec.string("label").flatMap { $0.isEmpty ? nil : $0 } ?? name) + (required ? " *" : "")
            let column = VStack(alignment: .leading, spacing: 2) {
                control(text)
                if let help = spec.string("help"), !help.isEmpty { Text(verbatim: help).toolsFont(12).foregroundStyle(look.color("@muted")) }
                if let p = form.problems[name] { Text(verbatim: FnFormState.problemText(p) { look.words($0) }).toolsFont(12).foregroundStyle(look.color("@danger")) }
            }
            if type == "checkbox" || type == "switch" {
                column
            } else if labels == "left" {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    label(text).frame(maxWidth: .infinity, alignment: .leading)
                    column.frame(maxWidth: .infinity, alignment: .leading).layoutPriority(1)
                }
            } else {
                VStack(alignment: .leading, spacing: 4) { label(text); column }
            }
        }
    }

    private var labels: String {
        spec.string("labels") ?? panel?.string("labels") ?? "top"
    }

    private func label(_ s: String) -> some View { Text(verbatim: s).toolsFont(14).foregroundStyle(look.color("@onSurface")) }

    private var bindingText: Binding<String> {
        Binding(get: { form.text(name) }, set: { form.set(name, .string($0)) })
    }

    @ViewBuilder
    private func control(_ labelText: String) -> some View {
        switch type {
        case "textarea":
            field(TextField("", text: bindingText, prompt: prompt, axis: .vertical).lineLimit(max(1, spec.optInt("rows", 3))...12), .default)
        case "number": field(TextField("", text: bindingText, prompt: prompt), .numbersAndPunctuation)
        case "tel": field(TextField("", text: bindingText, prompt: prompt), .phonePad)
        case "email": field(TextField("", text: bindingText, prompt: prompt).textInputAutocapitalization(.never), .emailAddress)
        case "url": field(TextField("", text: bindingText, prompt: prompt).textInputAutocapitalization(.never), .URL)
        case "password": field(SecureField("", text: bindingText, prompt: prompt), .default)
        case "color": field(TextField("", text: bindingText, prompt: Text(verbatim: spec.string("placeholder").flatMap { $0.isEmpty ? nil : $0 } ?? "#000000"))
            .textInputAutocapitalization(.never).autocorrectionDisabled(), .asciiCapable)
        case "date", "time", "datetime", "month": FnDateField(type: type, text: bindingText, placeholder: spec.optString("placeholder"), look: look).disabled(disabled)
        case "masked": masked
        case "range": range
        case "select": select
        case "multiselect": multiselect
        case "radio": radio
        case "checkbox", "switch":
            Toggle(isOn: Binding(get: { form.values[name] == .bool(true) }, set: { form.set(name, .bool($0)) })) {
                Text(verbatim: labelText).toolsFont(15).foregroundStyle(look.color("@onSurface"))
            }
            .tint(look.color("@primary"))
            .disabled(disabled)
        default: field(TextField("", text: bindingText, prompt: prompt), .default)
        }
    }

    private var prompt: Text? { spec.string("placeholder").flatMap { $0.isEmpty ? nil : Text(verbatim: $0) } }

    private func field<F: View>(_ f: F, _ keyboard: UIKeyboardType) -> some View {
        f.keyboardType(keyboard)
            .toolsFont(15)
            .foregroundStyle(look.color("@onSurface"))
            .padding(.horizontal, 10).padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 8).fill(look.color("@surfaceVariant")))
            .disabled(disabled)
    }

    /// 0 a digit, a a letter, * either; the rest is typed for you ("+420 000 000 000").
    private var masked: some View {
        let mask = spec.optString("mask")
        let tokens = Outputs.maskTokens(mask)
        let numeric = !tokens.isEmpty && tokens.allSatisfy { !$0.slot || $0.c == "0" }
        let hint = spec.string("placeholder").flatMap { $0.isEmpty ? nil : $0 } ?? Outputs.maskPlaceholder(mask)
        return field(TextField("", text: Binding(get: { form.text(name) }, set: { v in
            var t = mask.isEmpty ? v : Outputs.applyMask(mask, v)
            if !tokens.isEmpty && t.unicodeScalars.count > tokens.count { t = String(String.UnicodeScalarView(t.unicodeScalars.prefix(tokens.count))) }
            form.set(name, .string(t))
        }), prompt: Text(verbatim: hint)).autocorrectionDisabled(), numeric ? .phonePad : .asciiCapable)
    }

    private var range: some View {
        let min = spec.double("min") ?? 0, max = spec.double("max") ?? 100
        let step = spec.double("step").flatMap { $0 > 0 ? $0 : nil } ?? 1
        return HStack(spacing: 8) {
            Slider(value: Binding(get: {
                let v = Js.toNumber(form.values[name])
                return v.isFinite ? Swift.min(max, Swift.max(min, v)) : min
            }, set: { v in
                let snapped = Swift.min(max, min + ((v - min) / step).rounded() * step)
                form.set(name, FnFormState.number(snapped))
            }), in: min...Swift.max(max, min + step), step: step)
                .tint(look.color("@primary"))
            Text(verbatim: Js.str(form.values[name])).toolsFont(12).foregroundStyle(look.color("@onSurface"))
        }
        .disabled(disabled)
    }

    private var select: some View {
        let opts = FnFormState.options(spec)
        let none = spec.string("placeholder").flatMap { $0.isEmpty ? nil : $0 } ?? look.words("fnui.choose")
        let current = form.text(name)
        return Menu {
            Button { form.set(name, "") } label: { Text(verbatim: none) }
            ForEach(Array(opts.enumerated()), id: \.offset) { _, o in
                Button { form.set(name, .string(o.0)) } label: { Text(verbatim: o.1) }
            }
        } label: {
            HStack {
                Text(verbatim: opts.first { $0.0 == current }?.1 ?? none).toolsFont(15).foregroundStyle(look.color("@onSurface"))
                Spacer(minLength: 4)
                Image(systemName: "chevron.up.chevron.down").font(.caption).foregroundStyle(look.color("@muted"))
            }
            .padding(.horizontal, 10).padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 8).fill(look.color("@surfaceVariant")))
        }
        .disabled(disabled)
    }

    private var multiselect: some View {
        let opts = FnFormState.options(spec)
        return VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(opts.enumerated()), id: \.offset) { _, o in
                Toggle(isOn: Binding(get: { Command.strings(form.values[name]?.arrayValue).contains(o.0) }, set: { on in
                    var chosen = Command.strings(form.values[name]?.arrayValue)
                    if on { if !chosen.contains(o.0) { chosen.append(o.0) } } else { chosen.removeAll { $0 == o.0 } }
                    // In the options' order (Android collects them in that order).
                    form.set(name, .array(opts.map(\.0).filter(chosen.contains).map { .string($0) }))
                })) { Text(verbatim: o.1).toolsFont(15).foregroundStyle(look.color("@onSurface")) }
                    .toggleStyle(FnCheckboxStyle(look: look))
            }
        }
        .disabled(disabled)
    }

    private var radio: some View {
        let opts = FnFormState.options(spec)
        return VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(opts.enumerated()), id: \.offset) { _, o in
                Button { form.set(name, .string(o.0)) } label: {
                    HStack(spacing: 8) {
                        Image(systemName: form.text(name) == o.0 ? "largecircle.fill.circle" : "circle").foregroundStyle(look.color("@primary"))
                        Text(verbatim: o.1).toolsFont(15).foregroundStyle(look.color("@onSurface"))
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .disabled(disabled)
    }
}

/// A checkbox (Android's CheckBox) for the multi-select.
private struct FnCheckboxStyle: ToggleStyle {
    let look: ToolsLook

    func makeBody(configuration: Configuration) -> some View {
        Button { configuration.isOn.toggle() } label: {
            HStack(spacing: 8) {
                Image(systemName: configuration.isOn ? "checkmark.square.fill" : "square").foregroundStyle(look.color("@primary"))
                configuration.label
            }
        }
        .buttonStyle(.plain)
    }
}

/// A date, time, date and time, or month from the system's pickers ("2026-09-30", "14:05", "2026-09-30T14:05", "2026-09").
private struct FnDateField: View {
    let type: String
    @Binding var text: String
    let placeholder: String
    let look: ToolsLook
    @State private var picking = false
    @State private var date = Date()

    var body: some View {
        Button { picking = true } label: {
            Text(verbatim: text.isEmpty ? (placeholder.isEmpty ? (type == "time" ? "--:--" : type == "month" ? "----/--" : "----/--/--") : placeholder) : text)
                .toolsFont(15)
                .foregroundStyle(look.color(text.isEmpty ? "@muted" : "@onSurface"))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 10).padding(.vertical, 8)
                .background(RoundedRectangle(cornerRadius: 8).fill(look.color("@surfaceVariant")))
        }
        .buttonStyle(.plain)
        // A long press empties it (a date is not always wanted).
        .simultaneousGesture(LongPressGesture().onEnded { _ in text = "" })
        .popover(isPresented: $picking) {
            // Each choice writes the value at once; a tap outside closes the picker.
            DatePicker("", selection: $date, displayedComponents: type == "time" ? [.hourAndMinute] : type == "datetime" ? [.date, .hourAndMinute] : [.date])
                .datePickerStyle(.graphical)
                .labelsHidden()
                .padding()
                .presentationCompactAdaptation(.popover)
                .onChange(of: date) { _, d in text = Self.format(d, type) }
        }
    }

    static func format(_ d: Date, _ type: String) -> String {
        let c = Calendar(identifier: .gregorian).dateComponents(in: .current, from: d)
        let y = c.year ?? 0, mo = c.month ?? 0, day = c.day ?? 0, h = c.hour ?? 0, mi = c.minute ?? 0
        switch type {
        case "time": return String(format: "%02d:%02d", h, mi)
        case "month": return String(format: "%04d-%02d", y, mo)
        case "datetime": return String(format: "%04d-%02d-%02dT%02d:%02d", y, mo, day, h, mi)
        default: return String(format: "%04d-%02d-%02d", y, mo, day)
        }
    }
}
