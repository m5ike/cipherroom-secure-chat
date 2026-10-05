// The Lucide icons of the design (android/…/ui/Icons.java: assets/m5/icons.json,
// generated from the catalogue the console offers — the app bundles the same
// file at m5/icons.json). Every name has a best-effort SF Symbol; where there is
// none (or the symbol is missing on a platform) the renderer strokes the Lucide
// geometry: 24 × 24 view box, 2 pt round strokes, `fill` shapes filled.

import Foundation

/// One shape of an icon.
public struct IconShape: Sendable, Hashable {
    public var elements: [PathElement]
    /// Filled with the colour ("currentColor") instead of stroked.
    public var fill: Bool
}

/// The icons of icons.json, parsed once.
public struct IconSet: Sendable {
    public let icons: [String: [IconShape]]

    /// Reads icons.json: { name: [[tag, {attributes}], …] }.
    public init(json data: Data) throws {
        guard let all = (try DesignValue.parse(data)).objectValue else { throw DesignLoadError("icons.json is not an object") }
        var icons: [String: [IconShape]] = [:]
        for (name, children) in all {
            icons[name] = (children.arrayValue ?? []).compactMap { child in
                guard let pair = child.arrayValue, pair.count >= 2, let tag = pair[0].stringValue, let attrs = pair[1].objectValue else { return nil }
                return Self.shape(tag, attrs)
            }
        }
        self.icons = icons
    }

    public init(icons: [String: [IconShape]]) { self.icons = icons }

    private static func f(_ a: [String: DesignValue], _ k: String) -> Double { Double(Float(a[k]?.optDouble(0) ?? 0)) }

    static func shape(_ tag: String, _ a: [String: DesignValue]) -> IconShape? {
        let fill = a["fill"]?.optString("") == "currentColor"
        var e: [PathElement] = []
        switch tag {
        case "path": e = SvgPath.parse(a["d"]?.optString("") ?? "")
        case "circle":
            let cx = f(a, "cx"), cy = f(a, "cy"), r = f(a, "r")
            e = [.ellipse(IconRect(x: cx - r, y: cy - r, width: 2 * r, height: 2 * r))]
        case "ellipse":
            let cx = f(a, "cx"), cy = f(a, "cy"), rx = f(a, "rx"), ry = f(a, "ry")
            e = [.ellipse(IconRect(x: cx - rx, y: cy - ry, width: 2 * rx, height: 2 * ry))]
        case "rect":
            let rx = a["rx"] != nil ? f(a, "rx") : f(a, "ry")
            let ry = a["ry"] != nil ? f(a, "ry") : rx
            e = [.roundedRect(IconRect(x: f(a, "x"), y: f(a, "y"), width: f(a, "width"), height: f(a, "height")), rx: rx, ry: ry)]
        case "line":
            e = [.move(IconPoint(f(a, "x1"), f(a, "y1"))), .line(IconPoint(f(a, "x2"), f(a, "y2")))]
        case "polyline", "polygon":
            let pts = JavaSemantics.trim(a["points"]?.optString("") ?? "").split(whereSeparator: { $0 == " " || $0 == "," || $0 == "\t" || $0 == "\n" }).map(String.init)
            var i = 0
            while i + 1 < pts.count {
                let p = IconPoint(Double(Float(JavaSemantics.parseDouble(pts[i]) ?? 0)), Double(Float(JavaSemantics.parseDouble(pts[i + 1]) ?? 0)))
                e.append(i == 0 ? .move(p) : .line(p))
                i += 2
            }
            if tag == "polygon" { e.append(.close) }
        default: return nil
        }
        return IconShape(elements: e, fill: fill)
    }

    public func has(_ name: String) -> Bool { icons[name] != nil }

    /// The shapes of an icon; an unknown name draws a circle (Icons.drawable).
    public func shapes(_ name: String) -> [IconShape] { icons[name] ?? icons["circle"] ?? [] }
}

public enum Icons {
    /// The stroke width of the Lucide geometry in its 24 × 24 view box.
    public static let strokeWidth: Double = 2
    public static let viewBox: Double = 24

    /// The SF Symbol for a Lucide name, or nil (stroke the Lucide geometry instead). The renderer
    /// still falls back to the geometry when a symbol is missing on the running platform.
    public static func sfSymbol(_ name: String) -> String? { symbols[name] ?? nil }

    /// Every icon name of the catalogue (icons.json, the console's MENU_ICONS), each with its SF Symbol or nil.
    public static let symbols: [String: String?] = [
        "menu": "line.3.horizontal", "x": "xmark", "check": "checkmark", "shield-check": "checkmark.shield", "key-round": "key",
        "shield": "shield", "users": "person.2", "radio": "dot.radiowaves.left.and.right", "plug": "powerplug", "mic": "mic",
        "video": "video", "file-text": "doc.text", "map-pin": "mappin", "volume-2": "speaker.wave.2", "sparkles": "sparkles",
        "phone": "phone", "nfc": "wave.3.right", "palette": "paintpalette", "settings": "gearshape", "bell": "bell",
        "eye": "eye", "activity": "waveform.path.ecg", "user": "person", "log-out": "rectangle.portrait.and.arrow.right",
        "pencil-ruler": "pencil.and.ruler", "lock": "lock", "lock-open": "lock.open", "globe": "globe",
        "message-circle": "bubble.left", "message-square": "text.bubble", "messages-square": "bubble.left.and.bubble.right",
        "heart": "heart", "star": "star", "house": "house", "info": "info.circle", "circle-question-mark": "questionmark.circle",
        "book-open": "book", "calendar": "calendar", "clock": "clock", "wifi": "wifi", "server": "server.rack", "cloud": "cloud",
        "database": "cylinder", "zap": "bolt", "sun": "sun.max", "moon": "moon", "languages": "character.bubble",
        "share-2": "square.and.arrow.up", "link": "link", "external-link": "arrow.up.right.square", "download": "arrow.down.to.line",
        "upload": "arrow.up.to.line", "trash": "trash", "refresh-cw": "arrow.clockwise", "search": "magnifyingglass",
        "sliders-horizontal": "slider.horizontal.3", "layout-grid": "square.grid.2x2", "list": "list.bullet", "camera": "camera",
        "image": "photo", "headphones": "headphones", "music": "music.note", "gift": "gift", "rocket": nil, "flag": "flag",
        "bookmark": "bookmark", "tag": "tag", "mail": "envelope", "send": "paperplane", "hash": "number", "at-sign": "at",
        "terminal": "terminal", "code": "chevron.left.forwardslash.chevron.right", "cpu": "cpu", "gauge": "gauge.medium",
        "wrench": "wrench.adjustable", "briefcase": "briefcase", "life-buoy": "lifepreserver", "circle-user-round": "person.crop.circle",
        "fingerprint-pattern": "touchid", "qr-code": "qrcode", "smartphone": "iphone", "monitor": "display", "laptop": "laptopcomputer",
        "power": "power", "plus": "plus", "minus": "minus", "chevron-right": "chevron.right", "arrow-right": "arrow.right",
        "badge-check": "checkmark.seal", "bot": nil, "brush": "paintbrush", "compass": "safari", "crown": "crown", "eye-off": "eye.slash",
        "flame": "flame", "folder": "folder", "keyboard": "keyboard", "landmark": "building.columns", "layers": "square.3.layers.3d",
        "lightbulb": "lightbulb", "map": "map", "megaphone": "megaphone", "newspaper": "newspaper", "package": "shippingbox",
        "paperclip": "paperclip", "pen-line": "pencil.line", "printer": "printer", "puzzle": "puzzlepiece", "scale": "scalemass",
        "shopping-cart": "cart", "square-terminal": "apple.terminal", "store": "storefront", "thumbs-up": "hand.thumbsup",
        "ticket": "ticket", "trophy": "trophy", "truck": "truck.box", "umbrella": "umbrella", "wallet": "wallet.pass",
        "webhook": "point.3.connected.trianglepath.dotted", "circle-alert": "exclamationmark.circle", "triangle-alert": "exclamationmark.triangle",
        "circle-check": "checkmark.circle", "circle-x": "xmark.circle", "user-plus": "person.badge.plus", "user-cog": "person.badge.gearshape",
        "users-round": "person.2", "graduation-cap": "graduationcap", "timer": "timer", "scroll-text": "scroll",
        "reply": "arrowshape.turn.up.left", "forward": "arrowshape.turn.up.right", "corner-up-left": "arrow.turn.up.left",
        "check-check": nil, "send-horizontal": "paperplane", "wifi-off": "wifi.slash", "maximize-2": "arrow.up.left.and.arrow.down.right",
        "minimize-2": "arrow.down.right.and.arrow.up.left", "copy": "doc.on.doc", "face-slightly-smiling": "face.smiling",
        "grip-horizontal": nil, "settings-2": "gearshape.2", "arrow-left": "arrow.left", "arrow-up": "arrow.up", "arrow-down": "arrow.down",
        "chevron-left": "chevron.left", "chevron-up": "chevron.up", "chevron-down": "chevron.down", "circle": "circle", "square": "square",
        "circle-dot": "smallcircle.filled.circle", "bell-off": "bell.slash", "calendar-days": "calendar", "file": "doc",
        "file-image": "doc.richtext", "file-headphone": nil, "file-play": "play.rectangle", "folder-open": "folder", "mail-open": "envelope.open",
        "message-circle-more": "ellipsis.bubble", "mic-off": "mic.slash", "video-off": "video.slash", "volume-x": "speaker.slash",
        "phone-off": "phone.down", "share": "square.and.arrow.up", "pencil": "pencil", "save": "square.and.arrow.down",
        "reply-all": "arrowshape.turn.up.left.2", "sparkle": "sparkle", "hand": "hand.raised", "face-slightly-smiling-plus": nil,
        "sticker": nil, "quote": "quote.opening", "pin": "pin", "pin-off": "pin.slash", "map-pinned": "mappin.and.ellipse",
        "timer-reset": "timer", "hourglass": "hourglass", "shield-alert": "exclamationmark.shield", "shield-off": "shield.slash",
        "key": "key", "user-round": "person.crop.circle", "user-check": "person.fill.checkmark", "user-x": "person.fill.xmark",
        "signal": "cellularbars", "signal-high": "cellularbars", "signal-low": "cellularbars", "signal-zero": "cellularbars",
        "battery": "battery.100", "zap-off": "bolt.slash", "loader": "rays", "loader-circle": "progress.indicator", "refresh-ccw": "arrow.counterclockwise",
        "rotate-ccw": "arrow.counterclockwise", "undo-2": "arrow.uturn.backward", "redo-2": "arrow.uturn.forward", "panel-left": "sidebar.left",
        "panel-right": "sidebar.right", "layout-dashboard": "rectangle.3.group", "columns-2": "rectangle.split.2x1", "rows-2": "rectangle.split.1x2",
        "grip-vertical": nil, "move": "arrow.up.and.down.and.arrow.left.and.right", "ellipsis": "ellipsis", "ellipsis-vertical": nil,
        "circle-plus": "plus.circle", "circle-minus": "minus.circle", "vibrate": "iphone.radiowaves.left.and.right", "a-large-small": "textformat.size",
        "mouse-pointer-click": "cursorarrow.click", "square-round-corner": "square", "droplet": "drop", "swatch-book": "swatchpalette",
        "hammer": "hammer", "audio-lines": "waveform", "switch-camera": "arrow.triangle.2.circlepath.camera", "log-in": "arrow.right.to.line",
        "speaker": "hifispeaker", "pause": "pause", "navigation": "location.north", "sun-moon": "circle.lefthalf.filled", "volume-1": "speaker.wave.1",
        "wand-sparkles": "wand.and.stars", "scan-line": "viewfinder", "text-cursor-input": "character.cursor.ibeam",
        "route": "point.topleft.down.to.point.bottomright.curvepath", "locate-fixed": "scope", "file-up": "doc.badge.arrow.up",
        "camera-off": nil, "ear": "ear", "speech": nil, "type": "textformat", "contrast": "circle.lefthalf.filled",
        "shield-user": "person.badge.shield.checkmark", "shuffle": "shuffle", "square-arrow-down": "arrow.down.square",
        "signal-medium": "cellularbars", "circle-off": "circle.slash", "contact-round": "person.crop.circle", "unlink": nil,
        "message-square-lock": nil, "shield-question-mark": nil, "list-checks": "checklist", "list-x": nil,
        "layout-template": "rectangle.3.group", "monitor-smartphone": "laptopcomputer.and.iphone", "pipette": "eyedropper",
        "octagon-alert": "exclamationmark.octagon", "file-plus-corner": "doc.badge.plus", "usb": "cable.connector", "bluetooth": nil,
        "plug-zap": nil, "credit-card": "creditcard", "play": "play", "dice-5": "die.face.5", "box": "shippingbox",
        "code-xml": "chevron.left.forwardslash.chevron.right", "crosshair": "scope", "rotate-ccw-clock": "clock.arrow.circlepath",
        "list-tree": "list.bullet.indent", "thermometer": "thermometer.medium", "paint-bucket": nil, "square-dashed": "square.dashed",
        "pencil-line": "pencil.line", "lock-keyhole-open": "lock.open", "eraser": "eraser", "bell-ring": "bell.and.waves.left.and.right",
        "link-2": "link", "clock-3": "clock", "delete": "delete.left", "phone-outgoing": "phone.arrow.up.right", "chart-column": "chart.bar",
        "square-pen": "square.and.pencil", "corner-down-left": "arrow.turn.down.left", "clipboard-copy": "doc.on.clipboard",
        "circle-dashed": "circle.dashed", "panel-bottom": "dock.rectangle",
    ]

    /// The catalogue's names, sorted.
    public static var names: [String] { symbols.keys.sorted() }
}
