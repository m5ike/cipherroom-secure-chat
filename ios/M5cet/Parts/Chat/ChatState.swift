// What the chat parts share across their views — Android's Parts fields for the
// messages (imageCache, holding) and MessageList's own state, per window:
//   app-wide   decoded pictures (memory only), held ("tap") messages, the time
//              vanishing messages used up while shown, previews' metadata;
//   a window   "Hidden (n)" peek, the #tag filter, the quote's jump and flash.
// Everything here leaves the memory when the app locks (forgetAll, 6.12 F-16).

import Foundation
import M5Core
import M5Proto
import Observation
import UIKit

@MainActor
@Observable
final class ChatState {
    static let shared = ChatState()

    /// Bumped when a hide began or ended, or the app was unlocked (hides "until the next sign-in" end).
    private(set) var hidesGeneration = 0
    /// Bumped when the operator's map policy came or changed, or the server stopped answering.
    private(set) var mapGeneration = 0
    /// "tap" messages being held now (revealed while the finger is down).
    private(set) var holding: Set<String> = []
    /// Vanishing messages: how much of their time was used up on screen (ms), by message id.
    private(set) var vanishUsed: [String: Int64] = [:]

    /// Decoded pictures (by message id, "#poster", "#pdf"): memory only, ≤ 24 MB.
    @ObservationIgnored let images: NSCache<NSString, UIImage> = {
        let c = NSCache<NSString, UIImage>()
        c.totalCostLimit = 24 * 1024 * 1024
        return c
    }()
    /// Text previews, a PDF's page count, a video's size and length (by message id + "#text" / "#pdf" / "#video").
    @ObservationIgnored private(set) var meta: [String: Any] = [:]

    /// When a control that drags sideways itself (a seek bar) took a touch: the bubble's swipe leaves it alone.
    @ObservationIgnored var controlTouchAt = Date.distantPast

    @ObservationIgnored private var windows: [ObjectIdentifier: (host: WeakHost, state: ChatWindowState)] = [:]

    func hidesChanged() { hidesGeneration &+= 1 }
    func mapPolicyChanged() { mapGeneration &+= 1 }

    // MARK: held messages

    func hold(_ id: String, _ on: Bool) {
        if on { holding.insert(id) } else { holding.remove(id) }
    }

    func isHeld(_ id: String) -> Bool { holding.contains(id) }

    // MARK: vanishing

    /// The time a vanishing message used up (ms): this device's count while shown, at least what the message says.
    func vanishedMs(_ m: ChatMessage) -> Int64 { max(m.vanishedMs, vanishUsed[m.id] ?? 0) }

    /// Seconds left of a vanishing message.
    func vanishLeft(_ m: ChatMessage) -> Int64 { max(0, Int64(m.vanishSeconds) - vanishedMs(m) / 1000) }

    /// `delta` ms more on screen; true when its time ran out now.
    func useVanish(_ m: ChatMessage, _ delta: Int64) -> Bool {
        let before = vanishedMs(m)
        let now = before + delta
        vanishUsed[m.id] = now
        return now >= Int64(m.vanishSeconds) * 1000
    }

    // MARK: pictures and previews

    func image(_ key: String) -> UIImage? { images.object(forKey: key as NSString) }

    func putImage(_ image: UIImage, _ key: String) {
        let cost = Int(image.size.width * image.scale * image.size.height * image.scale * 4)
        images.setObject(image, forKey: key as NSString, cost: cost)
    }

    func meta(_ key: String) -> Any? { meta[key] }

    func putMeta(_ value: Any, _ key: String) {
        if meta.count > 300 { meta.removeAll() }
        meta[key] = value
    }

    /// A deleted message's pictures and previews go from memory too.
    func forget(_ id: String) {
        for k in [id, id + "#poster", id + "#pdf"] { images.removeObject(forKey: k as NSString) }
        for k in [id + "#text", id + "#pdf", id + "#video"] { meta[k] = nil }
        holding.remove(id)
        vanishUsed[id] = nil
    }

    /// 6.12 (F-16): the app locked — the decoded pictures, held messages and the lists' state go.
    func forgetAll() {
        images.removeAllObjects()
        meta.removeAll()
        holding.removeAll()
        vanishUsed.removeAll()
        for w in windows.values { w.state.reset() }
        ChatMedia.stopAll()
    }

    // MARK: windows

    /// The message list's state of a window (one per DesignHost).
    func window(_ host: DesignHost) -> ChatWindowState {
        let id = ObjectIdentifier(host)
        if let w = windows[id], w.host.value != nil { return w.state }
        windows = windows.filter { $0.value.host.value != nil }
        let s = ChatWindowState()
        windows[id] = (WeakHost(host), s)
        return s
    }
}

final class WeakHost {
    weak var value: DesignHost?
    init(_ v: DesignHost) { value = v }
}

/// One window's message list (MessageList's fields): the hidden messages shown for now, the #tag filter, the
/// message a quote's tap scrolls to and flashes, the list's position.
@MainActor
@Observable
final class ChatWindowState {
    /// "Hidden (n)": the hidden messages in their places for now (dimmed).
    var peek = false
    /// Only the messages with #tag ("" = all).
    var tag = ""
    /// The message the list should scroll to now (a quote's tap, History) — the list clears it.
    var scrollTarget: String?
    /// The row that flashes once it is on screen.
    var flashId: String?
    /// The room the list shows (peek ends with a new room).
    var roomKey = ""
    /// What is on screen now (ids), the list at its end.
    var visible: Set<String> = []
    var atBottom = true
    /// How many hidden messages the room has now (the "Hidden (n)" chip).
    var hiddenIds: Set<String> = []
    /// The ids the list shows now (in order) — what a jump can reach.
    @ObservationIgnored var shownIds: [String] = []
    /// When a touch last went down on a bubble (the room fling is not for it).
    @ObservationIgnored var bubbleTouchAt = Date.distantPast

    func reset() {
        peek = false
        tag = ""
        scrollTarget = nil
        flashId = nil
        visible = []
        hiddenIds = []
        shownIds = []
    }
}
