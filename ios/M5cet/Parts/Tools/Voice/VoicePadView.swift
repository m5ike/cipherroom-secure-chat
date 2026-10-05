// The voice pad (6.1, slot "voicePad") — a port of ToolPanels.VoicePad in
// android/…/ui/parts/ToolPanels.java: dictation into a transcript (a big
// microphone, what it is doing now, the words as they come), read aloud, into
// a message. Leaving the screen stops dictation (the last words still come
// into the transcript); a long press on the microphone opens the dictation
// options.

import M5Design
import Observation
import SwiftUI

/// The pad's transcript and dictation — one per app (voice.dictate reaches the pad on screen).
@MainActor
@Observable
final class VoicePadModel {
    var transcript = ""
    /// What was there before this dictation (its words come after it).
    @ObservationIgnored private var base = ""
    /// The pad is on screen (voice.dictate does nothing without it).
    var shown = false

    func clear() {
        transcript = ""
        base = ""
    }

    /// Dictation on or off (the microphone, voice.dictate).
    func toggle(_ voice: any ToolsVoice) {
        if voice.dictating { voice.stopDictation(); return }
        base = transcript
        if !base.isEmpty && !base.hasSuffix(" ") && !base.hasSuffix("\n") { base += " " }
        Task { @MainActor in
            _ = await voice.dictate { [weak self] text, done in self?.heard(text, done) }
        }
    }

    /// Words of the dictation: shown after what was there; a finished sentence becomes part of it.
    func heard(_ text: String, _ done: Bool) {
        transcript = base + text
        if done { base = transcript + " " }
    }

    /// The state line under the transcript.
    static func stateText(_ voice: any ToolsVoice, _ t: (String) -> String) -> String {
        if voice.speaking { return "🔊 " + t("voice.speak") + "…" }
        if voice.dictating { return voice.listening ? "🎙 " + t("voice.listening") : "…" }
        return t("voice.tapToDictate")
    }

    /// "Into a message": the text into the room's message box, the room on screen (nothing without a room).
    @discardableResult
    func toChat(host: DesignHost, core: CoreModels) -> Bool {
        let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, core.rooms.active != nil else { return false }
        host.form["composer"] = .string(text)
        let composer = core.composer(for: host)
        composer.text = text
        composer.focus()
        host.showScreen("room")
        return true
    }
}

struct VoicePadView: View {
    let host: DesignHost
    let model: VoicePadModel
    let voice: any ToolsVoice

    var body: some View {
        let look = ToolsLook(host: host)
        let on = voice.dictating
        VStack(spacing: 0) {
            TextField("", text: Binding(get: { model.transcript }, set: { model.transcript = $0 }),
                      prompt: Text(verbatim: look.t("voice.tapToDictate")).foregroundStyle(look.color("@muted")), axis: .vertical)
                .textInputAutocapitalization(.sentences)
                .toolsFont(18)
                .foregroundStyle(look.color("@onSurface"))
                .padding(.horizontal, 16).padding(.vertical, 14)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .background(RoundedRectangle(cornerRadius: 16).fill(look.color("@surface")))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(look.color("@border"), lineWidth: 1))
                .accessibilityIdentifier("voicePad.transcript")
            Text(verbatim: VoicePadModel.stateText(voice, look.t))
                .toolsFont(13)
                .foregroundStyle(look.color("@muted"))
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .padding(.top, 10).padding(.bottom, 6)
                .accessibilityAddTraits(.updatesFrequently)
            HStack(spacing: 20) {
                ToolsPillButton(title: look.t("voice.clear"), icon: "trash", primary: false, look: look) { model.clear() }
                Button { model.toggle(voice) } label: {
                    DesignIcon(name: on ? "mic-off" : "mic", size: 34, color: look.color("@onPrimary"))
                        .frame(width: 76, height: 76)
                        .background(Circle().fill(look.color(on ? "@danger" : "@primary")))
                        .shadow(color: .black.opacity(0.25), radius: on ? 10 : 4, y: on ? 4 : 2)
                }
                .buttonStyle(.plain)
                .simultaneousGesture(LongPressGesture(minimumDuration: 0.5).onEnded { _ in host.showSheet("dictate.options") })
                .accessibilityLabel(Text(verbatim: look.t("voice.dictate")))
                .accessibilityIdentifier("voicePad.mic")
                ToolsPillButton(title: look.t("voice.speak"), icon: "volume-2", primary: false, look: look) {
                    if voice.speaking { voice.stopSpeaking() } else { voice.say(model.transcript) }
                }
            }
            ToolsPillButton(title: look.t("voice.toChat"), icon: "send-horizontal", primary: true, look: look, fill: true) {
                model.toChat(host: host, core: CoreModels.shared)
            }
            .padding(.top, 12)
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .onAppear { model.shown = true }
        .onDisappear {
            model.shown = false
            // Leaving the voice screen stops dictation (the last words still come into the transcript).
            if voice.dictating { voice.stopDictation() }
        }
    }
}

/// The tools' pill button (ToolPanels.button): an icon and a label, the primary one filled.
struct ToolsPillButton: View {
    let title: String
    let icon: String
    let primary: Bool
    let look: ToolsLook
    var fill = false
    let action: () -> Void

    var body: some View {
        let fg = look.color(primary ? "@onPrimary" : "@primary")
        Button(action: action) {
            HStack(spacing: 8) {
                DesignIcon(name: icon, size: 18, color: fg)
                Text(verbatim: title).toolsFont(14.5, weight: .bold).foregroundStyle(fg).lineLimit(1)
            }
            .padding(.horizontal, 16).padding(.vertical, 11)
            .frame(maxWidth: fill ? .infinity : nil)
            .background(Capsule().fill(primary ? look.color("@primary") : look.color("@primary").opacity(0.12)))
        }
        .buttonStyle(.plain)
    }
}
