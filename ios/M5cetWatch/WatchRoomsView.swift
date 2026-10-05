// The rooms as the iPhone lists them (latest activity first): name, unread badge, a preview line and the
// connection's state. A banner when the iPhone is out of reach (replies wait in the queue).

import SwiftUI

struct WatchRoomsView: View {
    @Environment(WatchStore.self) private var store

    var body: some View {
        List {
            if !store.reachable {
                Label(store.t("watch.unreachable"), systemImage: "iphone.slash")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if store.rooms.isEmpty {
                Text(store.t("watch.noRooms"))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            ForEach(store.rooms) { room in
                NavigationLink(value: room.id) {
                    WatchRoomRow(room: room)
                }
            }
        }
        .navigationTitle(Text(verbatim: store.t("rooms.title")))
        .navigationDestination(for: String.self) { id in
            WatchRoomView(roomId: id)
        }
    }
}

struct WatchRoomRow: View {
    @Environment(WatchStore.self) private var store
    let room: WatchRoom

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(verbatim: room.name)
                    .font(.headline)
                    .lineLimit(1)
                    .privacySensitive()
                Spacer(minLength: 2)
                if room.unread > 0 {
                    WatchBadge(count: room.unread)
                }
            }
            if !room.preview.isEmpty {
                Text(verbatim: room.preview)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .privacySensitive()
            }
            if let state = statusText {
                Text(verbatim: state)
                    .font(.caption2)
                    .foregroundStyle(.orange)
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// The connection's state when it is not simply joined.
    private var statusText: String? {
        switch room.status {
        case "connecting": store.t("room.connecting")
        case "offline": store.t("room.offline")
        case "saved": store.t("rooms.saved")
        default: nil
        }
    }
}

/// The unread count (99+ above 99).
struct WatchBadge: View {
    let count: Int

    var body: some View {
        Text(verbatim: count > 99 ? "99+" : String(count))
            .font(.caption2.weight(.bold).monospacedDigit())
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(Capsule().fill(Color.accentColor))
            .foregroundStyle(.white)
    }
}
