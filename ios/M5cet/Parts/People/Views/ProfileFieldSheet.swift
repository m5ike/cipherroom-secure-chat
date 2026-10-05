// The profile editor's field dialog (ProfileUi.fieldDialog): a field's kind,
// label, value (the keyboard for its kind) and who sees it — the three audiences
// with their hints; Done, Cancel, and Remove for an existing field. Texts from the
// design (pf.field.*, pf.type.*, pf.aud.*).

import M5Core
import M5Design
import M5Proto
import SwiftUI

struct ProfileFieldSheet: View {
    struct Field: Equatable {
        var type: String
        var label: String
        var value: String
        var audience: String
    }

    let isNew: Bool
    let onSave: @MainActor @Sendable (Field) -> Void
    let onRemove: (@MainActor @Sendable () -> Void)?

    @State private var field: Field
    @Environment(DesignHost.self) private var host
    @Environment(\.peopleClose) private var close

    init(field: Field, isNew: Bool, onSave: @escaping @MainActor @Sendable (Field) -> Void, onRemove: (@MainActor @Sendable () -> Void)?) {
        _field = State(initialValue: field)
        self.isNew = isNew
        self.onSave = onSave
        self.onRemove = onRemove
    }

    var body: some View {
        let ctx = host.renderContext()
        let fg = ctx.swiftColor("@onSurface", .black), muted = ctx.swiftColor("@muted", .gray)
        let primary = ctx.swiftColor("@primary", .blue), danger = ctx.swiftColor("@danger", .red)
        let border = ctx.swiftColor("@border", .gray)
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(verbatim: host.peopleText("pf.field.title"))
                    .font(.system(size: 19, weight: .bold))
                    .foregroundStyle(fg)
                    .accessibilityAddTraits(.isHeader)
                Text(verbatim: host.peopleText("pf.field.type")).font(.system(size: 13)).foregroundStyle(muted)
                Picker(selection: $field.type) {
                    ForEach(ProfileCard.fieldTypes, id: \.self) { t in
                        Label { Text(verbatim: host.peopleText("pf.type." + t)) } icon: { Image(systemName: Self.symbol(t)) }.tag(t)
                    }
                } label: {
                    Text(verbatim: host.peopleText("pf.field.type"))
                }
                .pickerStyle(.menu)
                .tint(primary)
                .accessibilityIdentifier("pf.field.type")
                TextField(text: $field.label, prompt: Text(verbatim: host.peopleText("pf.field.label")).foregroundStyle(muted)) {
                    Text(verbatim: host.peopleText("pf.field.label"))
                }
                .textFieldStyle(.plain)
                .padding(10)
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(border))
                .foregroundStyle(fg)
                .accessibilityIdentifier("pf.field.label")
                valueField(fg: fg, muted: muted, border: border)
                if !field.value.javaTrimmed.isEmpty && ProfileCard.cleanValue(field.type, field.value).isEmpty {
                    Text(verbatim: host.peopleText("pf.field.invalid")).font(.system(size: 12.5)).foregroundStyle(danger)
                }
                Text(verbatim: host.peopleText("pf.field.audience")).font(.system(size: 13)).foregroundStyle(muted).padding(.top, 4)
                ForEach(ProfileEditor.audiences, id: \.self) { aud in
                    Button {
                        field.audience = aud
                    } label: {
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: field.audience == aud ? "largecircle.fill.circle" : "circle")
                                .foregroundStyle(field.audience == aud ? primary : muted)
                                .font(.system(size: 20))
                            DesignIcon(name: Profiles.audienceIcon(aud), size: 18, color: fg)
                            Text(verbatim: host.peopleText("pf.aud." + aud) + " — " + host.peopleText("pf.aud." + aud + ".hint"))
                                .font(.system(size: 14))
                                .foregroundStyle(fg)
                                .multilineTextAlignment(.leading)
                                .fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 0)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(field.audience == aud ? .isSelected : [])
                    .accessibilityIdentifier("pf.field.aud." + aud)
                }
                HStack(spacing: 8) {
                    if let onRemove {
                        PeoplePill(icon: "trash", label: host.peopleText("pf.field.remove"), color: danger) { onRemove(); close() }
                            .accessibilityIdentifier("pf.field.remove")
                    }
                    Spacer(minLength: 0)
                    PeoplePill(icon: "x", label: host.peopleText("pf.field.cancel"), color: muted) { close() }
                        .accessibilityIdentifier("pf.field.cancel")
                    PeoplePill(icon: "check", label: host.peopleText("pf.field.save"), color: primary) { onSave(field); close() }
                        .accessibilityIdentifier("pf.field.save")
                }
                .padding(.top, 8)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 20)
            .frame(maxWidth: 560)
            .frame(maxWidth: .infinity)
        }
        .background(ctx.swiftColor("@surface", .white).ignoresSafeArea())
    }

    @ViewBuilder
    private func valueField(fg: Color, muted: Color, border: Color) -> some View {
        let multi = field.type == "address" || field.type == "other"
        let prompt = Text(verbatim: host.peopleText("pf.field.value")).foregroundStyle(muted)
        Group {
            if multi {
                TextField(text: $field.value, prompt: prompt, axis: .vertical) { Text(verbatim: host.peopleText("pf.field.value")) }
                    .lineLimit(1...6)
            } else {
                TextField(text: $field.value, prompt: prompt) { Text(verbatim: host.peopleText("pf.field.value")) }
            }
        }
        .textFieldStyle(.plain)
        .padding(10)
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(border))
        .foregroundStyle(fg)
        .modifier(Keyboard(type: field.type))
        .accessibilityIdentifier("pf.field.value")
    }

    /// ProfileUi.inputType: the keyboard for a kind.
    private struct Keyboard: ViewModifier {
        let type: String
        func body(content: Content) -> some View {
            switch type {
            case "phone": content.keyboardType(.phonePad)
            case "email": content.keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
            case "url", "social": content.keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
            case "name": content.textInputAutocapitalization(.words)
            default: content.textInputAutocapitalization(.sentences)
            }
        }
    }

    /// The picker's symbols for the kinds (the same pictures as Profiles.icon's lucide ones).
    static func symbol(_ type: String) -> String {
        switch type {
        case "name": "person"
        case "phone": "phone"
        case "email": "envelope"
        case "address": "mappin.and.ellipse"
        case "url": "globe"
        case "social": "at"
        case "org": "briefcase"
        case "birthday": "gift"
        default: "doc.text"
        }
    }
}
