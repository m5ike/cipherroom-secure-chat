// The lockPad slot (android ui/parts/LockPad): the dots and the keypad inside
// the design's "lock" screen — the design draws the rest (title, step, error,
// wait, attempts left) from $lock, which AppScreenState builds from the same
// pad model. The model is Platform/Security's LockPadModel over AppLock: PIN
// setup (choose, confirm), unlock, the duress PIN, biometrics, the wait —
// nothing of the PIN reaches the screen state. Shuffled keys (security.shufflePin)
// as on Android. When the lock opens (or the PIN is set) every window routes on.

import M5Design
import SwiftUI

struct LockPadPart: View {
    let ctx: SlotContext
    let state: AppScreenState
    let core: AppCore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if let model = state.lockPadModel() {
            Pad(ctx: ctx, model: model, core: core, reduceMotion: reduceMotion)
        } else {
            Color.clear.frame(idealHeight: 0)
        }
    }

    private struct Pad: View {
        let ctx: SlotContext
        @Bindable var model: LockPadModel
        let core: AppCore
        let reduceMotion: Bool

        var body: some View {
            let bio = model.mode == .unlock && model.lock.biometricAvailable
            GeometryReader { geo in
                let s = LockScreenView.keySizes(width: geo.size.width, height: geo.size.height - 44 - (bio ? 50 : 0))
                VStack(spacing: 0) {
                    dots
                        .frame(height: 24)
                        .animation(reduceMotion ? nil : .linear(duration: 0.38), value: model.shakes)
                        .padding(.top, 6).padding(.bottom, 14)
                    Grid(horizontalSpacing: s.gapH, verticalSpacing: s.gapV) {
                        ForEach(0..<4, id: \.self) { row in
                            GridRow { ForEach(0..<3, id: \.self) { col in cell(row * 3 + col, size: s.key) } }
                        }
                    }
                    if bio {
                        Button {
                            Task { await model.biometrics(texts: texts) }
                        } label: {
                            Label(ctx.t("lock.useBiometric"), systemImage: LockScreenView.bioSymbol(model.lock.biometrics.kind))
                                .font(.callout.weight(.medium))
                        }
                        .tint(ctx.color("@primary"))
                        .padding(.top, 18)
                        .accessibilityIdentifier("lock.biometric")
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .frame(idealWidth: 320, idealHeight: 440)
            .sensoryFeedback(.impact(weight: .light), trigger: model.taps)
            .sensoryFeedback(.error, trigger: model.shakes)
            .onChange(of: model.lock.revision) { routeIfOpen() }
            .onChange(of: model.step) { ctx.host.refresh() }
            .onChange(of: model.shakes) { ctx.host.refresh() }
            .task {
                // The biometric prompt by itself, once per showing (Android: with the lock screen).
                if model.mode == .unlock, !model.promptedBiometrics, model.lock.biometricAvailable, model.lock.waitSeconds == 0 {
                    await model.biometrics(texts: texts)
                }
            }
            .accessibilityIdentifier("lock.pad")
        }

        private var texts: LockTexts {
            LockTexts(strings: [core.services.lang: ["lock.bioPrompt": ctx.t("lock.bioPrompt"), "lock.bioCancel": ctx.t("lock.bioCancel")]],
                      languages: [core.services.lang])
        }

        /// Unlocked, or the PIN set up: every window goes on (route → the rooms).
        private func routeIfOpen() {
            ctx.host.refresh()
            if model.lock.isSetUp && !model.lock.isLocked { core.routeChanged() }
        }


        private var dots: some View {
            let n = max(1, model.length)
            return HStack(spacing: 14) {
                ForEach(0..<n, id: \.self) { i in
                    if i < model.count {
                        Circle().fill(ctx.color("@primary")).frame(width: 14, height: 14)
                    } else {
                        Circle().strokeBorder(ctx.color("@border"), lineWidth: 1.5).frame(width: 14, height: 14)
                    }
                }
            }
            .accessibilityElement()
            .accessibilityLabel("\(model.count) / \(model.length)")
            .accessibilityIdentifier("lock.dots")
            .modifier(ShakeEffect(shakes: CGFloat(model.shakes), amount: reduceMotion ? 0 : 10))
        }

        /// Nine digits, then a blank, a digit and delete (shuffled: ten digits, a blank, delete — LockPad.cells).
        @ViewBuilder
        private func cell(_ index: Int, size: CGFloat) -> some View {
            let order = model.order
            let digit: Int? = model.shuffle ? (index < 10 ? order[index] : nil) : (index < 9 ? order[index] : index == 10 ? 0 : nil)
            if index == 11 {
                Button { model.delete() } label: {
                    Image(systemName: "delete.left").font(.system(size: size * 0.32)).foregroundStyle(ctx.color("@onSurface"))
                        .frame(width: size, height: size).contentShape(Circle())
                }
                .buttonStyle(.plain)
                .simultaneousGesture(LongPressGesture(minimumDuration: 0.5).onEnded { _ in model.clear() })
                .accessibilityLabel(ctx.t("lock.delete"))
                .accessibilityIdentifier("lock.delete")
            } else if let digit {
                Button { model.press(digit) } label: {
                    ZStack {
                        Circle().fill(ctx.color("@surfaceVariant"))
                        Text(String(digit)).font(.system(size: size * 0.38, design: .rounded)).foregroundStyle(ctx.color("@onSurface"))
                    }
                    .frame(width: size, height: size)
                    .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(String(digit))
                .accessibilityIdentifier("lock.key.\(digit)")
            } else {
                Color.clear.frame(width: size, height: size).accessibilityHidden(true)
            }
        }
    }
}

/// A wrong PIN: a short shake of the dots.
private struct ShakeEffect: GeometryEffect {
    var shakes: CGFloat
    var amount: CGFloat
    var animatableData: CGFloat {
        get { shakes }
        set { shakes = newValue }
    }
    func effectValue(size: CGSize) -> ProjectionTransform {
        ProjectionTransform(CGAffineTransform(translationX: amount * sin(shakes * .pi * 6), y: 0))
    }
}
