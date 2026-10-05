// ui/parts/MessageList (slot "messages"): the messages of the room on screen — the
// design's message.in / message.out / message.sys trees (DesignTemplateView), built
// per row and bound per message; a new message plays its row's enter animation.
//
// 6.1: rows follow their message (delivery state, file progress, receipts); a
// vanishing message counts its time only while it is on screen and open; what was
// shown gets a read receipt; a #tag filters the conversation. A long press offers
// reply, copy, forward, the map and the recording; a horizontal fling off the
// bubbles moves to the previous / next connected room.
// 6.2: hidden messages are left out until their time passes (or the next unlock),
// "Hidden (n)" shows them for a moment; a received message's first time on screen
// is its "displayed" step.
// 6.10: a bubble dragged sideways replies or forwards (BubbleRowView); a quote's tap
// scrolls to the original and flashes it; the list starts over when the history
// comes again (an unlock: RoomModel.restores).
//
// Like Android, there are no date separators, unread marker or "new messages" badge
// in this list (the design has no texts for them); the list follows the newest
// message when it was at its end or the message is mine.

import M5Core
import M5Design
import M5Proto
import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct MessagesPart: View {
    let ctx: SlotContext
    @State private var lastTick: Int64 = Millis.now
    @State private var animateId: String?
    @State private var flashTokens: [String: Int] = [:]
    @State private var restoresSeen = -1
    @State private var roomSeen = ""
    @State private var touchStart = Date.distantPast
    @State private var markTask: Task<Void, Never>?

    var body: some View {
        let host = ctx.host
        let core = CoreModels.shared
        let win = ChatState.shared.window(host)
        let room = core.rooms.active
        let _ = ChatState.shared.hidesGeneration
        let _ = ChatState.shared.mapGeneration
        let now = Millis.now
        let all = room?.messages ?? []
        let list = Self.filter(all, tag: win.tag, peek: win.peek, now: now)
        let byId = Dictionary(all.map { ($0.id, $0) }, uniquingKeysWith: { _, b in b })
        let roster = ChatRoster(room: room, userName: core.userName)
        ZStack {
            ScrollViewReader { proxy in
                ScrollView(.vertical) {
                    LazyVStack(spacing: 0) {
                        ForEach(Array(list.items.enumerated()), id: \.element.id) { i, m in
                            MessageRowContainer(message: m, previous: i > 0 ? list.items[i - 1] : nil, room: room, byId: byId, roster: roster,
                                                ctx: ctx, animate: m.id == animateId, dimmed: list.hidden.contains(m.id), flashToken: flashTokens[m.id] ?? 0,
                                                onBubbleTouch: { win.bubbleTouchAt = Date() })
                                .id(m.id)
                        }
                    }
                    .padding(.vertical, 6)
                    .scrollTargetLayout()
                }
                .defaultScrollAnchor(.bottom)
                .scrollDismissesKeyboard(.interactively)
                .onScrollTargetVisibilityChange(idType: String.self, threshold: 0.2) { ids in
                    win.visible = Set(ids)
                    scheduleMarkShown()
                }
                .onScrollGeometryChange(for: Bool.self) { g in
                    g.contentOffset.y + g.containerSize.height >= g.contentSize.height - 48
                } action: { _, bottom in win.atBottom = bottom }
                .simultaneousGesture(roomFling(win))
                .onChange(of: room?.freshId) { _, fresh in arrived(fresh, room: room, win: win, proxy: proxy) }
                .onChange(of: win.scrollTarget) { _, target in
                    guard let target else { return }
                    win.scrollTarget = nil
                    let still = Look(settings: host.settings, reducedMotion: host.reducedMotion).still
                    if still { proxy.scrollTo(target, anchor: UnitPoint(x: 0.5, y: 0.2)) } else {
                        withAnimation(.easeInOut(duration: 0.3)) { proxy.scrollTo(target, anchor: UnitPoint(x: 0.5, y: 0.2)) }
                    }
                    if let f = win.flashId { win.flashId = nil; flashTokens[f, default: 0] += 1 }
                }
                .onChange(of: room?.revealRequest) { _, id in
                    guard let id else { return }
                    room?.revealRequest = nil
                    ChatActions.reveal(id, host: host)
                }
                .onAppear {
                    #if DEBUG
                    ChatSamples.start(host)
                    #endif
                    load(room, win: win, proxy: proxy)
                }
                .onChange(of: room?.key) { _, _ in load(room, win: win, proxy: proxy) }
                .onChange(of: room?.restores) { _, _ in load(room, win: win, proxy: proxy) }
            }
            .onChange(of: list.hidden) { _, h in
                win.hiddenIds = h
                if h.isEmpty { win.peek = false }
            }
            .onAppear { win.hiddenIds = list.hidden }
            overlays(room: room, empty: list.items.isEmpty, win: win)
        }
        .task(id: room?.key ?? "") { await ticker() }
        .onDrop(of: [.image, .fileURL, .item], isTargeted: nil) { providers in ChatDrop.take(providers, host: host) }
        .accessibilityIdentifier(ctx.id)
    }

    // MARK: MessageList.applyFilter

    /// The rows: not expired, not deleted (one row per id), hidden ones only while "Hidden (n)" peeks, the #tag's only.
    static func filter(_ messages: [ChatMessage], tag: String, peek: Bool, now: Int64) -> (items: [ChatMessage], hidden: Set<String>) {
        var last = [String: Int]()
        for (i, m) in messages.enumerated() { last[m.id] = i }
        var items = [ChatMessage]()
        var hidden = Set<String>()
        for (i, m) in messages.enumerated() where last[m.id] == i && !m.deleted && !m.expired(now) {
            let isHidden = m.hiddenUntil != 0 && BubbleHides.hidden(m, now)
            if isHidden { hidden.insert(m.id) }
            if matches(m, tag) && (!isHidden || peek) { items.append(m) }
        }
        return (items, hidden)
    }

    /// The message has #tag as a whole word.
    static func matches(_ m: ChatMessage, _ tag: String) -> Bool {
        if tag.isEmpty { return true }
        let t = Array(m.visibleText.lowercased().utf16)
        let needle = Array(("#" + tag).utf16)
        guard needle.count <= t.count else { return false }
        var at = 0
        while at + needle.count <= t.count {
            if Array(t[at..<(at + needle.count)]) == needle {
                let end = at + needle.count
                if end >= t.count { return true }
                let next = String(utf16CodeUnits: [t[end]], count: 1)
                if !(next.first.map { $0.isLetter || $0.isNumber } ?? false) && next != "_" { return true }
                at = end
            } else {
                at += 1
            }
        }
        return false
    }

    // MARK: the list moves

    private func load(_ room: (any RoomModel)?, win: ChatWindowState, proxy: ScrollViewProxy) {
        let key = room?.key ?? ""
        if key != roomSeen { win.peek = false; win.tag = ""; roomSeen = key; win.roomKey = key }
        restoresSeen = room?.restores ?? -1
        if let last = room?.messages.last?.id { proxy.scrollTo(last, anchor: .bottom) }
        scheduleMarkShown()
    }

    /// MessageList.add: a new message — its enter animation; the list follows when it was at its end or it is mine.
    private func arrived(_ fresh: String?, room: (any RoomModel)?, win: ChatWindowState, proxy: ScrollViewProxy) {
        guard let fresh, let m = room?.message(fresh) else { return }
        animateId = fresh
        if win.atBottom || m.mine {
            let still = Look(settings: ctx.host.settings, reducedMotion: ctx.host.reducedMotion).still
            if still { proxy.scrollTo(fresh, anchor: .bottom) } else { withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo(fresh, anchor: .bottom) } }
        }
        Task { try? await Task.sleep(for: .milliseconds(800)); if animateId == fresh { animateId = nil } }
        scheduleMarkShown()
    }

    /// A quick fling off the bubbles (beside them, on an avatar, on the background) moves to the previous / next connected room.
    private func roomFling(_ win: ChatWindowState) -> some Gesture {
        DragGesture(minimumDistance: 24)
            .onChanged { _ in if touchStart == .distantPast { touchStart = Date() } }
            .onEnded { v in
                let started = touchStart
                touchStart = .distantPast
                let onBubble = win.bubbleTouchAt >= started.addingTimeInterval(-0.05)
                guard BubbleSwipe.roomFling(startedOnBubble: onBubble, vx: v.velocity.width, vy: v.velocity.height, min: BubbleSwipe.roomFlingDp) else { return }
                let rooms = CoreModels.shared.rooms.open
                guard rooms.count >= 2 else { return }
                let current = CoreModels.shared.rooms.activeKey
                let at = rooms.firstIndex { $0.key == current } ?? 0
                let next = (at + BubbleSwipe.roomStep(v.velocity.width) + rooms.count) % rooms.count
                ctx.run("room.switch", .string(rooms[next].key))
            }
    }

    // MARK: shown / vanishing

    /// The app is in front, unlocked, on the room screen.
    private var watching: Bool {
        UIApplication.shared.applicationState == .active && ctx.host.screen == "room" && !ctx.host.services.state.routeState.locked
    }

    /// Vanishing messages on screen and open use up their time; a timed hide that is over brings its message back.
    private func ticker() async {
        lastTick = Millis.now
        while !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(250))
            if Task.isCancelled { return }
            tick()
        }
    }

    private func tick() {
        let now = Millis.now
        let delta = min(1000, now - lastTick)
        lastTick = now
        guard let room = CoreModels.shared.rooms.active else { return }
        let unlock = BubbleHides.unlock
        for m in room.messages where m.hiddenUntil != 0 && !BubbleHides.hidden(m, now) {
            room.touch(m.id) { _ = BubbleHides.endIfOver(&$0, now, unlock) }
        }
        guard watching else { return }
        let win = ChatState.shared.window(ctx.host)
        let state = ChatState.shared
        for id in win.visible {
            guard let m = room.message(id), m.vanishSeconds > 0, !m.vanished else { continue }
            let open = (m.sealed == nil || m.sealPlain != nil) && (!m.tap || state.isHeld(m.id))
            if !open { continue }
            if state.useVanish(m, delta) { room.vanished(m.id) }
        }
    }

    private func scheduleMarkShown() {
        markTask?.cancel()
        markTask = Task {
            try? await Task.sleep(for: .milliseconds(300))
            if !Task.isCancelled { markShown() }
        }
    }

    /// What is on screen now counts as read (receipts: Settings › Messages); a received message's first time on screen is its "displayed" step.
    private func markShown() {
        guard watching, let room = CoreModels.shared.rooms.active else { return }
        let win = ChatState.shared.window(ctx.host)
        let shown = room.messages.filter { win.visible.contains($0.id) }
        if shown.isEmpty { return }
        for m in shown where !m.mine && m.kind != "sys" && m.has("received") && !m.has("displayed") {
            room.touch(m.id) { $0.mark("displayed") }
        }
        room.markRead(shown.map(\.id))
    }

    // MARK: what lies over the list

    @ViewBuilder
    private func overlays(room: (any RoomModel)?, empty: Bool, win: ChatWindowState) -> some View {
        let c = ctx.context
        if empty {
            Text(verbatim: ctx.t("room.empty"))
                .font(.system(size: 14))
                .foregroundStyle(c.swiftColor("@muted", .gray))
                .multilineTextAlignment(.center)
                .padding(.horizontal, 36)
                .allowsHitTesting(false)
        }
        VStack(spacing: 0) {
            ZStack(alignment: .top) {
                if let room, let text = Self.stateText(room, t: ctx.t) {
                    let mismatch = room.status == "mismatch"
                    Text(verbatim: text)
                        .font(.system(size: 12))
                        .foregroundStyle(mismatch ? Color.white : c.swiftColor("@onSurface", .black))
                        .padding(.horizontal, 12).padding(.vertical, 4)
                        .background(RoundedRectangle(cornerRadius: 12).fill(mismatch ? c.swiftColor("@danger", .red) : c.swiftColor("@surfaceVariant", .white)))
                        .accessibilityAddTraits(.updatesFrequently)
                }
                if !win.hiddenIds.isEmpty {
                    Button { ChatActions.toggleHidden(host: ctx.host) } label: {
                        Text(verbatim: (win.peek ? "🙈 " + ctx.t("msg.hideHidden") : "👁 " + ctx.t("msg.showHidden")) + " (\(win.hiddenIds.count))")
                            .font(.system(size: 12))
                            .foregroundStyle(c.swiftColor("@onSurface", .black))
                            .padding(.horizontal, 10).padding(.vertical, 4)
                            .background(Capsule().fill(c.swiftColor("@surfaceVariant", .white)))
                    }
                    .buttonStyle(.plain)
                    .hoverEffect(.highlight)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .padding(.trailing, 10)
                }
            }
            .padding(.top, 6)
            Spacer(minLength: 0)
            if !win.tag.isEmpty {
                Button { ChatActions.filter("", host: ctx.host) } label: {
                    Text(verbatim: "#" + win.tag + "   ✕")
                        .font(.system(size: 13))
                        .foregroundStyle(c.swiftColor("@onPrimary", .white))
                        .padding(.horizontal, 14).padding(.vertical, 6)
                        .background(Capsule().fill(c.swiftColor("@primary", .blue)))
                }
                .buttonStyle(.plain)
                .hoverEffect(.highlight)
                .padding(.bottom, 8)
            }
        }
    }

    /// MessageList.refreshHeaderState: what the connection says ("" when joined).
    static func stateText(_ room: any RoomModel, t: (String) -> String) -> String? {
        switch room.status {
        case "joined": return nil
        case "mismatch": return t("room.keyMismatch")
        case "connecting": return room.notice.isEmpty ? t("room.connecting") : room.notice
        default: return t("room.offline")
        }
    }
}

/// One row: its $msg built when it is drawn (LazyVStack draws only what is near the screen).
private struct MessageRowContainer: View {
    let message: ChatMessage
    let previous: ChatMessage?
    let room: (any RoomModel)?
    let byId: [String: ChatMessage]
    let roster: ChatRoster
    let ctx: SlotContext
    let animate: Bool
    let dimmed: Bool
    let flashToken: Int
    let onBubbleTouch: @MainActor () -> Void

    var body: some View {
        let host = ctx.host
        let m = message
        let scope = ChatMessageScope.scope(m, previous: previous, room: room, byId: byId, roster: roster, tr: ctx.t,
                                           has: { ChatIcons.has($0) }, settings: host.settings, now: Millis.now)
        BubbleRowView(message: m, screen: ChatMessageScope.screen(m), scope: scope, animate: animate, dimmed: dimmed, flashToken: flashToken,
                      canReply: ChatActions.canReply(m), canForward: ChatActions.canForward(m), actions: ChatActions.a11y(m, host: host),
                      onReply: { ChatActions.reply(m, host: host) }, onForward: { ChatActions.forward(m, host: host) },
                      onMenu: { anchor in ChatActions.menu(m, host: host, anchor: anchor) },
                      onBubbleDrag: { on in if on { onBubbleTouch() } })
    }
}

/// Drag and drop onto the room (iPad, and iPhone between apps): pictures go as pictures, anything else as a file.
@MainActor
enum ChatDrop {
    static func take(_ providers: [NSItemProvider], host: DesignHost) -> Bool {
        guard CoreModels.shared.rooms.active != nil else { return false }
        let composer = CoreModels.shared.composer(for: host)
        var took = false
        for p in providers {
            if p.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                took = true
                _ = p.loadDataRepresentation(for: .image) { data, _ in
                    guard let data else { return }
                    Task { @MainActor in composer.sendImage(data) }
                }
            } else if p.hasItemConformingToTypeIdentifier(UTType.item.identifier) {
                took = true
                _ = p.loadFileRepresentation(for: .item, openInPlace: false) { url, _, _ in
                    guard let url else { return }
                    // The system's copy lives only as long as this callback: ours goes after the send.
                    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("m5-drop-" + UUID().uuidString, isDirectory: true)
                    guard (try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])) != nil else { return }
                    let copy = dir.appendingPathComponent(url.lastPathComponent)
                    guard (try? FileManager.default.copyItem(at: url, to: copy)) != nil else { try? FileManager.default.removeItem(at: dir); return }
                    Task { @MainActor in
                        composer.sendFile(at: copy)
                        try? FileManager.default.removeItem(at: dir)
                    }
                }
            }
        }
        return took
    }
}
