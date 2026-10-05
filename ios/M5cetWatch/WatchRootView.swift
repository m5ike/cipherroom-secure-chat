// The watch's first screen: the rooms while the iPhone shares them, otherwise why not ("Locked on iPhone",
// "Off on iPhone", "iPhone not connected", "Open M5cet on your iPhone"). The rooms' navigation lives only in the
// `.ok` branch, so a lock tears down an open room at once. In Always On (wrist down) the content is redacted.

import SwiftUI

struct WatchRootView: View {
    @Environment(WatchStore.self) private var store
    @Environment(\.isLuminanceReduced) private var dimmed

    var body: some View {
        Group {
            switch store.phase {
            case .ok:
                NavigationStack {
                    WatchRoomsView()
                }
            case .locked:
                WatchStatusView(symbol: "lock.fill", title: store.t("watch.locked"), hint: store.t("watch.locked.hint"))
            case .off:
                WatchStatusView(symbol: "applewatch.slash", title: store.t("watch.off"), hint: store.t("watch.off.hint"))
            case .away:
                WatchStatusView(symbol: "iphone.slash", title: store.t("watch.away"), hint: store.t("watch.away.hint"))
            case .waiting:
                WatchStatusView(symbol: "iphone", title: store.t("watch.waiting"), hint: store.t("watch.waiting.hint"), busy: true)
            }
        }
        .redacted(reason: dimmed ? .privacy : [])
    }
}

/// A state without content: a symbol, a title and what to do.
struct WatchStatusView: View {
    @Environment(WatchStore.self) private var store
    let symbol: String
    let title: String
    let hint: String
    var busy = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 8) {
                    Image(systemName: symbol)
                        .font(.title2)
                        .foregroundStyle(.tint)
                        .accessibilityHidden(true)
                    Text(title)
                        .font(.headline)
                        .multilineTextAlignment(.center)
                    Text(hint)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    if busy { ProgressView().padding(.top, 4) }
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 4)
            }
            .navigationTitle(Text(verbatim: store.t("app")))
        }
    }
}

#if DEBUG
#Preview("Rooms") {
    let store = WatchStore(defaults: UserDefaults(suiteName: "m5w.preview") ?? .standard)
    store.apply(WatchSample.snapshot(now: store.clock()))
    return WatchRootView().environment(store)
}

#Preview("Locked") {
    let store = WatchStore(defaults: UserDefaults(suiteName: "m5w.preview") ?? .standard)
    store.apply(WatchSample.snapshot(now: store.clock(), state: .locked))
    return WatchRootView().environment(store)
}
#endif
