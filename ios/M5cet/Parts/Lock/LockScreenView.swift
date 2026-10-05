// The lock screen — Android ui/parts/LockPad adapted to iOS: dots for the typed
// digits and a keypad of all ten digits with the dial-pad letters under each, one
// colour per key. With "Shuffle the PIN keys" (Settings › Security) the digits are
// placed at random and reshuffle after every tap, so positions and smudges give
// nothing away. The digits are never shown; a wrong PIN shakes the dots; a long
// press on delete clears them. The keys are sized to the space they get (three
// across, four down, 40–84 pt), so the pad fits split view, Slide Over and
// landscape; wide spaces put the header beside the pad. Biometrics (Face ID /
// Touch ID / Optic ID) open it when the policy allows — the prompt comes by itself
// once per showing. The wait after repeated failures counts down here; the duress
// PIN is typed like any PIN (AppLock decides).
//
// Texts come from the design (LockTexts), colours from its theme (LockLook).

import SwiftUI
import UIKit

/// The pad's state: the typed digits (bytes, zeroed after use — never in the view), the setup step, the error.
@MainActor
@Observable
final class LockPadModel {
    enum Mode: Equatable { case unlock, setup }
    enum Step: Equatable { case enter, choose, confirm }

    let lock: AppLock
    let mode: Mode
    private(set) var step: Step
    /// How many digits are typed (the dots).
    private(set) var count = 0
    /// A text key of the design ("lock.wrongPin", "lock.pinMismatch") or nil.
    private(set) var error: String?
    /// Bumped at a wrong PIN (the shake and the error haptic).
    private(set) var shakes = 0
    /// Bumped at every tap (the tap haptic).
    private(set) var taps = 0
    /// The digits in the order the keypad shows them.
    private(set) var order: [Int] = Array(1...9) + [0]
    /// The last unlock attempt's result (the attempts-left line).
    private(set) var lastResult: UnlockResult?
    var shuffle: Bool { didSet { reorder() } }

    /// The typed digits and setup's first entry (zeroed after use, and when the pad goes).
    @ObservationIgnored private let typed = PinBuffer()
    @ObservationIgnored private let first = PinBuffer()
    @ObservationIgnored private(set) var promptedBiometrics = false

    init(lock: AppLock, mode: Mode, shuffle: Bool = false) {
        self.lock = lock
        self.mode = mode
        self.step = mode == .setup ? .choose : .enter
        self.shuffle = shuffle
        reorder()
    }

    var length: Int { lock.pinLength }

    private func reorder() {
        var rng = LockPadRandom()
        order = shuffle ? Array(0...9).shuffled(using: &rng) : Array(1...9) + [0]
    }

    func press(_ digit: Int) {
        guard !lock.busy, (0...9).contains(digit), typed.bytes.count < 12 else { return }
        typed.bytes.append(UInt8(48 + digit))
        count = typed.bytes.count
        taps &+= 1
        if shuffle { reorder() }
        if count >= length { Task { await submit() } }
    }

    func delete() {
        guard !typed.bytes.isEmpty else { return }
        typed.bytes[typed.bytes.count - 1] = 0
        typed.bytes.removeLast()
        count = typed.bytes.count
        taps &+= 1
        if shuffle { reorder() }
    }

    func clear() {
        typed.wipe()
        count = 0
        taps &+= 1
    }

    private func take() -> [UInt8] {
        let d = typed.bytes
        typed.wipe()
        count = 0
        return d
    }

    private func submit() async {
        var entered = take()
        defer { Bytes.wipe(&entered) }
        switch step {
        case .enter:
            let pin = String(decoding: entered, as: UTF8.self)
            let r = await lock.unlock(pin: pin)
            lastResult = r
            switch r {
            case .wrong, .lockedOut:
                error = r == .wrong ? "lock.wrongPin" : nil
                shakes &+= 1
            case .wait:
                error = nil
                shakes &+= 1
            default:
                error = nil
            }
        case .choose:
            first.bytes = entered
            error = nil
            step = .confirm
        case .confirm:
            if entered == first.bytes {
                let pin = String(decoding: entered, as: UTF8.self)
                first.wipe()
                do { try await lock.setUp(pin: pin) } catch { self.error = "lock.pinMismatch" }
            } else {
                first.wipe()
                error = "lock.pinMismatch"
                step = .choose
                shakes &+= 1
            }
        }
    }

    func biometrics(texts: LockTexts) async {
        promptedBiometrics = true
        let r = await lock.unlockWithBiometrics(reason: texts("lock.bioPrompt"), fallbackTitle: texts("lock.bioCancel"))
        if r != .cancelled { lastResult = r }
        if r == .wrong { shakes &+= 1 }
    }
}

/// Digits being typed: zeroed when taken and when the pad goes away.
final class PinBuffer: @unchecked Sendable {
    var bytes: [UInt8] = []
    func wipe() { Bytes.wipe(&bytes) }
    deinit { Bytes.wipe(&bytes) }
}

/// The system's CSPRNG for the shuffle.
struct LockPadRandom: RandomNumberGenerator {
    mutating func next() -> UInt64 {
        Bytes.random(8).withUnsafeBytes { $0.loadUnaligned(as: UInt64.self) }
    }
}

struct LockScreenView: View {
    @State var model: LockPadModel
    var texts: LockTexts = .builtIn
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let look = LockLook.builtIn(dark: scheme == .dark)
        GeometryReader { geo in
            let wide = geo.size.width > geo.size.height * 1.25 && geo.size.width > 560
            ZStack {
                look.background.ignoresSafeArea()
                // The pad gets the room the header leaves (Android LockPad.onMeasure).
                if wide {
                    HStack(spacing: 48) {
                        header(look).frame(maxWidth: 320)
                        GeometryReader { inner in
                            pad(look, room: inner.size).frame(maxWidth: .infinity, maxHeight: .infinity)
                        }
                        .frame(maxWidth: geo.size.width * 0.5)
                    }
                    .padding(24)
                } else {
                    VStack(spacing: 12) {
                        header(look).padding(.top, min(72, geo.size.height * 0.06))
                        GeometryReader { inner in
                            pad(look, room: inner.size).frame(maxWidth: .infinity, maxHeight: .infinity)
                        }
                    }
                    .padding(.horizontal, 24)
                    .padding(.bottom, 12)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .sensoryFeedback(.impact(weight: .light), trigger: model.taps)
        .sensoryFeedback(.error, trigger: model.shakes)
        .task {
            // The biometric prompt by itself, once per showing (Android: the prompt with the lock).
            if model.mode == .unlock, !model.promptedBiometrics, model.lock.biometricAvailable, model.lock.waitSeconds == 0 {
                await model.biometrics(texts: texts)
            }
        }
        .accessibilityIdentifier("lock.screen")
    }

    // MARK: header

    private func header(_ look: LockLook) -> some View {
        VStack(spacing: 10) {
            Image("Mark").resizable().scaledToFit().frame(width: 56, height: 56).accessibilityHidden(true)
            Text(texts(model.mode == .setup ? "lock.setupTitle" : "lock.title"))
                .font(.title2.weight(.semibold)).foregroundStyle(look.onSurface).multilineTextAlignment(.center)
            Text(texts(stepKey)).font(.subheadline).foregroundStyle(look.muted).multilineTextAlignment(.center)
            if model.mode == .setup {
                Text(texts("lock.setupHint")).font(.footnote).foregroundStyle(look.muted).multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            status(look).frame(minHeight: 40)
        }
    }

    private var stepKey: String {
        switch model.step {
        case .enter: "lock.enterPin"
        case .choose: "lock.setPin"
        case .confirm: "lock.confirmPin"
        }
    }

    @ViewBuilder
    private func status(_ look: LockLook) -> some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            let _ = model.lock.revision
            let wait = model.mode == .unlock ? model.lock.waitSeconds : 0
            VStack(spacing: 4) {
                if wait > 0 {
                    Text("\(texts("lock.waitFor")) \(Self.clock(wait))")
                        .font(.callout.monospacedDigit()).foregroundStyle(look.danger)
                        .accessibilityIdentifier("lock.wait")
                } else if let e = model.error {
                    Text(texts(e)).font(.callout).foregroundStyle(look.danger).accessibilityIdentifier("lock.error")
                }
                if model.mode == .unlock, model.lock.attempts > 0, model.lastResult == .wrong || wait > 0 {
                    Text("\(texts("lock.attemptsLeft")): \(model.lock.left)")
                        .font(.footnote).foregroundStyle(look.muted)
                }
            }
        }
    }

    static func clock(_ seconds: Int64) -> String {
        seconds >= 3600 ? String(format: "%d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60)
            : String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    // MARK: the pad

    private func pad(_ look: LockLook, room: CGSize) -> some View {
        // The dots (44 pt) and, when shown, the biometric button (50 pt) take their part first.
        let bio = model.mode == .unlock && model.lock.biometricAvailable
        let s = Self.keySizes(width: room.width, height: room.height - 44 - (bio ? 50 : 0))
        return VStack(spacing: 0) {
            Dots(length: model.length, filled: model.count, on: look.primary, off: look.border)
                .frame(height: 24)
                .modifier(Shake(amount: reduceMotion ? 0 : 10, shakes: CGFloat(model.shakes)))
                .animation(reduceMotion ? nil : .linear(duration: 0.38), value: model.shakes)
                .padding(.top, 6).padding(.bottom, 14)
            Grid(horizontalSpacing: s.gapH, verticalSpacing: s.gapV) {
                ForEach(0..<4, id: \.self) { row in
                    GridRow {
                        ForEach(0..<3, id: \.self) { col in cell(row * 3 + col, look: look, size: s.key) }
                    }
                }
            }
            if model.mode == .unlock && model.lock.biometricAvailable {
                Button {
                    Task { await model.biometrics(texts: texts) }
                } label: {
                    Label(texts("lock.useBiometric"), systemImage: Self.bioSymbol(model.lock.biometrics.kind))
                        .font(.callout.weight(.medium))
                }
                .tint(look.primary)
                .padding(.top, 18)
                .accessibilityIdentifier("lock.biometric")
            }
        }
    }

    static func bioSymbol(_ kind: String) -> String {
        switch kind {
        case "faceID": "faceid"
        case "opticID": "opticid"
        default: "touchid"
        }
    }

    /// The twelve cells, row by row: nine digits, then a blank, a digit and delete
    /// (shuffled: ten digits, a blank, delete — Android LockPad.cells).
    @ViewBuilder
    private func cell(_ index: Int, look: LockLook, size: CGFloat) -> some View {
        let order = model.order
        let digit: Int? = model.shuffle
            ? (index < 10 ? order[index] : nil)
            : (index < 9 ? order[index] : index == 10 ? 0 : nil)
        if index == 11 {
            Button { model.delete() } label: {
                Image(systemName: "delete.left").font(.system(size: size * 0.32)).foregroundStyle(look.onSurface)
                    .frame(width: size, height: size).contentShape(Circle())
            }
            .buttonStyle(KeyPress())
            .simultaneousGesture(LongPressGesture(minimumDuration: 0.5).onEnded { _ in model.clear() })
            .accessibilityLabel(texts("lock.delete"))
            .accessibilityIdentifier("lock.delete")
        } else if let digit {
            Button { model.press(digit) } label: { Key(digit: digit, size: size, dark: look.dark) }
                .buttonStyle(KeyPress())
                .accessibilityLabel(String(digit))
                .accessibilityIdentifier("lock.key.\(digit)")
        } else {
            Color.clear.frame(width: size, height: size).accessibilityHidden(true)
        }
    }

    /// {key, horizontal gap, vertical gap} for this much room: three keys and two gaps (28 % of a key)
    /// across, four keys and three gaps (14 %) down, keys 40–84 pt; at the smallest keys the gaps give way first.
    static func keySizes(width w: CGFloat, height h: CGFloat) -> (key: CGFloat, gapH: CGFloat, gapV: CGFloat) {
        let k = min(84, max(40, min(w / 3.56, h / 4.42).rounded(.down)))
        var gv = min(16, max(4, (k * 0.14).rounded()))
        var gh = min(28, max(6, (k * 0.28).rounded()))
        if 4 * k + 3 * gv > h { gv = max(0, (h - 4 * k) / 3) }
        if 3 * k + 2 * gh > w { gh = max(0, (w - 3 * k) / 2) }
        return (k, gh, gv)
    }
}

/// One round key: the digit and its dial-pad letters (ITU E.161), drawn to its size.
private struct Key: View {
    let digit: Int
    let size: CGFloat
    let dark: Bool
    private static let letters = ["", "", "ABC", "DEF", "GHI", "JKL", "MNO", "PQRS", "TUV", "WXYZ"]

    var body: some View {
        let (bg, fg) = Self.colors(digit, dark: dark)
        let letters = Self.letters[digit]
        // Below 52 pt the letters would be too small to read: the digit alone.
        let withLetters = !letters.isEmpty && size >= 52
        ZStack {
            Circle().fill(bg)
            VStack(spacing: size * 0.02) {
                Text(String(digit)).font(.system(size: size * 0.38, weight: .regular, design: .rounded)).foregroundStyle(fg)
                if withLetters {
                    Text(letters).font(.system(size: size * 0.13, weight: .semibold)).tracking(size * 0.13 * 0.14)
                        .foregroundStyle(fg.opacity(0.7))
                }
            }
            .offset(y: withLetters ? size * 0.02 : 0)
        }
        .frame(width: size, height: size)
        .contentShape(Circle())
    }

    /// One colour per digit, spread around the hue wheel; soft in light, deep in dark (Android LockPad.keyColor).
    static func colors(_ digit: Int, dark: Bool) -> (Color, Color) {
        let hue = CGFloat((digit * 36) % 360) / 360
        let ui = UIColor(hue: hue, saturation: dark ? 0.52 : 0.42, brightness: dark ? 0.46 : 0.94, alpha: 1)
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        ui.getRed(&r, green: &g, blue: &b, alpha: &a)
        let luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
        let fg = luminance < 0.56 ? Color.white : Color(red: 0x14 / 255, green: 0x18 / 255, blue: 0x1f / 255)
        return (Color(uiColor: ui), fg)
    }
}

private struct KeyPress: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.94 : 1)
            .opacity(configuration.isPressed ? 0.8 : 1)
            .animation(.easeOut(duration: 0.08), value: configuration.isPressed)
    }
}

/// One dot per digit, filled as they are typed; they shrink to fit a narrow pad.
private struct Dots: View {
    let length: Int
    let filled: Int
    let on: Color
    let off: Color

    var body: some View {
        GeometryReader { geo in
            let n = max(1, length)
            let step = min(28, geo.size.width / CGFloat(n))
            let d = min(14, step * 0.62)
            HStack(spacing: step - d) {
                ForEach(0..<n, id: \.self) { i in
                    if i < filled {
                        Circle().fill(on).frame(width: d, height: d)
                    } else {
                        Circle().strokeBorder(off, lineWidth: 1.5).frame(width: d, height: d)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(width: CGFloat(max(1, length)) * 28)
        .accessibilityElement()
        .accessibilityLabel("\(filled) / \(length)")
        .accessibilityIdentifier("lock.dots")
    }
}

/// A wrong PIN: a short shake.
private struct Shake: GeometryEffect {
    var amount: CGFloat
    var shakes: CGFloat
    var animatableData: CGFloat {
        get { shakes }
        set { shakes = newValue }
    }

    func effectValue(size: CGSize) -> ProjectionTransform {
        ProjectionTransform(CGAffineTransform(translationX: amount * sin(shakes * .pi * 4) * (1 - shakes.truncatingRemainder(dividingBy: 1) * 0.6), y: 0))
    }
}

#Preview("Unlock") {
    LockScreenView(model: LockPadModel(lock: SecurityCenter.preview().lock, mode: .unlock))
}

#Preview("Setup") {
    LockScreenView(model: LockPadModel(lock: SecurityCenter.preview().lock, mode: .setup, shuffle: true))
}
