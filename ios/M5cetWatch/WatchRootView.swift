// The watch's placeholder screen: a list where the rooms will be (wave 2: rooms,
// unread counts, quick replies and call answering relayed from the iPhone).
// Texts are verbatim until the watch gets the design's strings.

import M5Core
import M5Crypto
import M5Proto
import SwiftUI

struct WatchRootView: View {
    private let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
    private let modules = [M5CoreModule.name, M5CryptoModule.name, M5ProtoModule.name]

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(0..<3, id: \.self) { _ in
                        HStack(spacing: 10) {
                            Circle().fill(Color.accentColor.opacity(0.35)).frame(width: 24, height: 24)
                            RoundedRectangle(cornerRadius: 4).fill(.secondary.opacity(0.3)).frame(height: 10)
                        }
                        .accessibilityHidden(true)
                    }
                } footer: {
                    Text(verbatim: "M5cet \(version)")
                }
                Section {
                    ForEach(modules, id: \.self) { Text(verbatim: $0).font(.footnote.monospaced()) }
                }
            }
            .navigationTitle(Text(verbatim: "M5cet"))
        }
    }
}

#Preview {
    WatchRootView()
}
