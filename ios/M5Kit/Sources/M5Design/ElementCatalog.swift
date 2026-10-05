// The elements a screen tree may use (server/android/design.ts ELEMENTS and
// the 6.x additions) with their props, the style props, colour tokens, events,
// animations and the server's LIMITS — and for each element how the SwiftUI
// renderer draws it. ELEMENTS.md is generated from this file
// (`ElementCatalog.markdown()`; CatalogTests keeps the two in step).

import Foundation

/// An element of a screen tree. Unknown names are kept (`.unknown`) and draw as nothing.
public enum ElementKind: Hashable, Sendable {
    case column, row, stack, scroll, card, sheet, swipe
    case text, icon, image, avatar, badge, chip, divider, spacer, progress
    case button, iconButton, input, toggleSwitch, checkbox, select, slider, segmented
    case slot
    case unknown(String)

    public init(name: String) {
        switch name {
        case "column": self = .column
        case "row": self = .row
        case "stack": self = .stack
        case "scroll": self = .scroll
        case "card": self = .card
        case "sheet": self = .sheet
        case "swipe": self = .swipe
        case "text": self = .text
        case "icon": self = .icon
        case "image": self = .image
        case "avatar": self = .avatar
        case "badge": self = .badge
        case "chip": self = .chip
        case "divider": self = .divider
        case "spacer": self = .spacer
        case "progress": self = .progress
        case "button": self = .button
        case "iconButton": self = .iconButton
        case "input": self = .input
        case "switch": self = .toggleSwitch
        case "checkbox": self = .checkbox
        case "select": self = .select
        case "slider": self = .slider
        case "segmented": self = .segmented
        case "slot": self = .slot
        default: self = .unknown(name)
        }
    }

    /// The design's name of the element.
    public var name: String {
        switch self {
        case .column: return "column"
        case .row: return "row"
        case .stack: return "stack"
        case .scroll: return "scroll"
        case .card: return "card"
        case .sheet: return "sheet"
        case .swipe: return "swipe"
        case .text: return "text"
        case .icon: return "icon"
        case .image: return "image"
        case .avatar: return "avatar"
        case .badge: return "badge"
        case .chip: return "chip"
        case .divider: return "divider"
        case .spacer: return "spacer"
        case .progress: return "progress"
        case .button: return "button"
        case .iconButton: return "iconButton"
        case .input: return "input"
        case .toggleSwitch: return "switch"
        case .checkbox: return "checkbox"
        case .select: return "select"
        case .slider: return "slider"
        case .segmented: return "segmented"
        case .slot: return "slot"
        case .unknown(let n): return n
        }
    }

    public var isKnown: Bool { if case .unknown = self { return false } else { return true } }

    /// Holds children (Renderer: a view with a box).
    public var isContainer: Bool { ElementCatalog.entry(name)?.container ?? false }

    /// Draws text with the design's text style (Android: a TextView).
    public var isTextual: Bool {
        switch self {
        case .text, .badge, .chip, .button, .select, .input, .toggleSwitch, .checkbox: return true
        default: return false
        }
    }
}

public enum ElementCatalog {
    public enum PropKind: String, Sendable { case text, expr, number, bool, icon, select, color, slot, image }

    public struct Prop: Sendable, Hashable {
        public let name: String
        public let kind: PropKind
        public let label: String
        public let options: [String]?
        public let help: String?
    }

    public struct Entry: Sendable, Hashable {
        public let el: String
        public let label: String
        public let group: String
        public let container: Bool
        /// Takes a `text` template.
        public let text: Bool
        public let props: [Prop]
        public let help: String
        /// How the SwiftUI renderer draws it (wave 2).
        public let swiftUI: String
        /// The Android app code that first drew it.
        public let since: Int
    }

    private static func p(_ name: String, _ kind: PropKind, _ label: String, options: [String]? = nil, help: String? = nil) -> Prop {
        Prop(name: name, kind: kind, label: label, options: options, help: help)
    }

    static let variants = ["primary", "tonal", "secondary", "text", "danger"]
    static let toggleProps = [p("setting", .text, "Setting", help: "e.g. voice.autoplay — the switch changes it itself"), p("bind", .text, "Or a form value")]

    public static let entries: [Entry] = [
        Entry(el: "column", label: "Column", group: "layout", container: true, text: false, props: [], help: "Children one under another.",
              swiftUI: "VStack(spacing: 0) — children carry their margins (the gap is in them); justify start/center/end aligns the content; between/around come as `.flex` children.", since: 60000),
        Entry(el: "row", label: "Row", group: "layout", container: true, text: false, props: [p("wrap", .bool, "Wrap to the next line")], help: "Children side by side.",
              swiftUI: "HStack(spacing: 0); with wrap = true a flow Layout (gap between items and lines, justify start/center/end).", since: 60000),
        Entry(el: "stack", label: "Stack", group: "layout", container: true, text: false, props: [], help: "Children on top of each other (the last one on top).",
              swiftUI: "ZStack — children fill it by default; `self` aligns a child (start = top-leading, center, end = bottom-trailing).", since: 60000),
        Entry(el: "scroll", label: "Scroll", group: "layout", container: true, text: false, props: [p("horizontal", .bool, "Horizontal")], help: "Scrolls its one child.",
              swiftUI: "ScrollView(.vertical or .horizontal) around a VStack / HStack(spacing: 0); vertical fills the viewport.", since: 60000),
        Entry(el: "card", label: "Card", group: "layout", container: true, text: false, props: [], help: "A raised surface with rounded corners.",
              swiftUI: "VStack(spacing: 0) on a RoundedRectangle(box.radius) filled with box.fill and a shadow of box.elevation.", since: 60000),
        Entry(el: "text", label: "Text", group: "content", container: false, text: true,
              props: [p("variant", .select, "Style", options: ["body", "title", "headline", "display", "caption", "label", "mono"]),
                      p("align", .select, "Alignment", options: ["start", "center", "end"]), p("links", .bool, "Clickable links")],
              help: "A text template: {$var}, {_'key'}, {=expression}.",
              swiftUI: "Text(content.text) with textStyle (size × fontScale, weight, italic, family, lineLimit, alignment); links = true → AttributedString with detected URLs / e-mails; an icon before it.", since: 60000),
        Entry(el: "icon", label: "Icon", group: "content", container: false, text: false,
              props: [p("icon", .icon, "Icon"), p("size", .number, "Size (dp)"), p("color", .color, "Colour")], help: "A lucide icon, drawn natively.",
              swiftUI: "Image(systemName: Icons.sfSymbol(name)) sized to `size`, or the Lucide geometry (IconSet) stroked 2 pt round in a 24×24 box; tinted with `color`.", since: 60000),
        Entry(el: "image", label: "Image", group: "content", container: false, text: false,
              props: [p("src", .image, "Image", help: "asset:<name> from the design's assets, or a fixed https URL on a host in ANDROID_DESIGN_IMAGE_HOSTS (never computed: 6.7, F-01)"),
                      p("fit", .select, "Fit", options: ["cover", "contain", "center"]), p("ratio", .number, "Width / height")],
              help: "A picture.",
              swiftUI: "Image from content.source (.asset bytes, .data bytes, .remote https URL loaded by the app); cover → scaledToFill + clipped, contain → scaledToFit, center → natural size; ratio > 0 → aspectRatio(ratio).", since: 60000),
        Entry(el: "avatar", label: "Avatar", group: "content", container: false, text: false,
              props: [p("name", .text, "Name (initials, colour)"), p("size", .number, "Size (dp)")], help: "A round badge with initials.",
              swiftUI: "Circle filled with content.color, the initials in white, bold, 40 % of the size.", since: 60000),
        Entry(el: "badge", label: "Badge", group: "content", container: false, text: true,
              props: [p("icon", .icon, "Icon"), p("color", .color, "Colour")], help: "A small pill with a number or a word.",
              swiftUI: "Text in a Capsule filled with box.fill (padding 2 × 7 by default), a 12 pt icon before it.", since: 60000),
        Entry(el: "chip", label: "Chip", group: "content", container: false, text: true,
              props: [p("icon", .icon, "Icon"), p("selected", .expr, "Selected")], help: "A compact choice.",
              swiftUI: "Text in a RoundedRectangle(box.radius) with box.border (primary when selected) and box.fill; tappable when it has a click event.", since: 60000),
        Entry(el: "divider", label: "Divider", group: "content", container: false, text: false, props: [], help: "A thin line.",
              swiftUI: "Rectangle filled with box.fill: 1 pt high in a column, 1 pt wide in a row (layout gives the sizes).", since: 60000),
        Entry(el: "spacer", label: "Spacer", group: "content", container: false, text: false,
              props: [p("size", .number, "Size (dp); empty = fill")], help: "Empty space.",
              swiftUI: "Spacer(minLength: 0) with weight 1 when it has no size; else a clear frame of size × size. A fill shows when box.fill is set.", since: 60000),
        Entry(el: "progress", label: "Progress", group: "content", container: false, text: false,
              props: [p("value", .expr, "Value 0–1 (empty = spinning)")], help: "A progress bar.",
              swiftUI: "ProgressView(value:) linear when content.value is set, else a circular spinner; tint primary.", since: 60000),
        Entry(el: "button", label: "Button", group: "controls", container: false, text: true,
              props: [p("icon", .icon, "Icon"), p("variant", .select, "Variant", options: variants), p("disabled", .expr, "Disabled when")],
              help: "A button; its action is in Events.",
              swiftUI: "Button with label HStack(icon 18 pt + 8 pt + Text), centred together; box.fill / border / radius from the variant and the user's button style; min height 44; disabled → 0.5 opacity, no taps; press style ripple / scale / none.", since: 60000),
        Entry(el: "iconButton", label: "Icon button", group: "controls", container: false, text: false,
              props: [p("icon", .icon, "Icon"), p("label", .text, "Accessible label"), p("variant", .select, "Variant", options: variants), p("badge", .expr, "Badge number")],
              help: "A round button with an icon.",
              swiftUI: "Button 44 × 44 with a 22 pt icon in content.iconColor on content.shape; accessibilityLabel = label (also a help tooltip); a 16 pt badge at the top trailing corner.", since: 60000),
        Entry(el: "input", label: "Input", group: "controls", container: false, text: false,
              props: [p("bind", .text, "Value name", help: "Stored under $form.<name>"), p("hint", .text, "Hint"),
                      p("type", .select, "Type", options: ["text", "password", "number", "email", "phone", "multiline", "url"])],
              help: "A text field; Enter runs its submit action.",
              swiftUI: "TextField / SecureField (password) / TextField(axis: .vertical) (multiline) with the keyboard of the type; its text is $form[bind] (write every change back through the runner's form); submit → the submit event.", since: 60000),
        Entry(el: "switch", label: "Switch", group: "controls", container: false, text: true,
              props: [p("checked", .expr, "On when")] + toggleProps,
              help: "An on/off switch: bound to a setting it changes it itself, else its click action does.",
              swiftUI: "Toggle(text, isOn:) tinted primary; a change → ActionRunner.commit(node, .bool(on)) when it is bound (setting / bind) and has no click event, else the click event.", since: 60000),
        Entry(el: "checkbox", label: "Checkbox", group: "controls", container: false, text: true,
              props: [p("checked", .expr, "Checked when")] + toggleProps,
              help: "A checkbox (e.g. selecting rooms).",
              swiftUI: "Toggle with a checkbox style (square checkmark) — same rules as the switch.", since: 60000),
        Entry(el: "select", label: "Select", group: "controls", container: false, text: false,
              props: [p("setting", .text, "Setting", help: "e.g. voice.lang — read and changed by the element"), p("bind", .text, "Or a form value"),
                      p("options", .text, "Options", help: "value:Label|value2:{_'key'} or =$list (values or {value, label})"), p("hint", .text, "Hint")],
              help: "A drop-down choice; its change event follows the new value ($value).",
              swiftUI: "Menu (or Picker .menu) showing content.label with a chevron-down; the current option checked; a pick → ActionRunner.commit(node, .string(value)).", since: 60100),
        Entry(el: "slider", label: "Slider", group: "controls", container: false, text: false,
              props: [p("setting", .text, "Setting"), p("bind", .text, "Or a form value"), p("min", .number, "Minimum"), p("max", .number, "Maximum"), p("step", .number, "Step")],
              help: "A number on a track (rate, pitch, size…).",
              swiftUI: "Slider(value: fraction 0…1) tinted primary; on release → ActionRunner.commit(node, .number(content.value(atFraction:))).", since: 60100),
        Entry(el: "segmented", label: "Segmented", group: "controls", container: false, text: false,
              props: [p("setting", .text, "Setting"), p("bind", .text, "Or a form value"), p("options", .text, "Options", help: "value:Label|…")],
              help: "A few choices side by side (tone, density…).",
              swiftUI: "HStack of equal-width segments (min height 38) on box.fill (surfaceVariant) with radius content.outerRadius; the chosen one on content.selectedFill (radius content.innerRadius); a tap → commit.", since: 60100),
        Entry(el: "sheet", label: "Sheet / dock", group: "layout", container: true, text: false,
              props: [p("present", .select, "Shown as", options: ["sheet", "dock"]), p("dismissOnAction", .expr, "Close before an action")],
              help: "The root of a sheet or the Tools dock — a column.",
              swiftUI: "The root of .sheet / a dock overlay: a VStack; content.present sheet → presentationDetents from the bottom over a scrim, dock → a floating card above the composer (a tap outside closes it); dismissOnAction → close before running an action.", since: 60200),
        Entry(el: "swipe", label: "Swipe row", group: "layout", container: true, text: false,
              props: [p("right", .text, "Menu revealed by a drag to the right"), p("left", .text, "Menu revealed by a drag to the left"),
                      p("rightColor", .color, "Colour of the right menu's edge action"), p("leftColor", .color, "Colour of the left menu's edge action")],
              help: "A row that slides sideways to its menus' actions.",
              swiftUI: "The children in a VStack on @surface, dragged sideways (SwipeMath: claims / clamp / settle / progress) over the tiles of content.swipe.right (left edge) and .left (right edge); the edge tile filled with the side's colour, the others tonal.", since: 60700),
        Entry(el: "slot", label: "App part", group: "logic", container: false, text: false, props: [p("name", .slot, "Part")],
              help: "A native component of the app (message list, composer…).",
              swiftUI: "The app's native part for content.slot (messages, composer, roomList, lockPad…) with the node's scope.", since: 60000),
    ]

    private static let byEl: [String: Entry] = Dictionary(uniqueKeysWithValues: entries.map { ($0.el, $0) })

    public static func entry(_ el: String) -> Entry? { byEl[el] }

    /// The style props every element takes.
    public static let styleProps: [(name: String, label: String, help: String)] = [
        ("padding", "Padding", "dp: 12 or \"8 16\" or \"8 16 8 16\""),
        ("margin", "Margin", "dp, same forms as padding"),
        ("gap", "Gap", "dp between children"),
        ("width", "Width", "match, wrap or dp"),
        ("height", "Height", "match, wrap or dp"),
        ("maxWidth", "Max width", "dp"),
        ("weight", "Weight", "share of the free space in a row/column"),
        ("align", "Align children", "start, center, end, stretch"),
        ("justify", "Justify children", "start, center, end, between, around"),
        ("self", "Align self", "start, center, end, stretch"),
        ("bg", "Background", "@token or #rrggbb (#aarrggbb)"),
        ("fg", "Text colour", "@token or #rrggbb"),
        ("radius", "Corner radius", "dp"),
        ("border", "Border", "\"1 @border\" (width colour)"),
        ("elevation", "Elevation", "dp of shadow"),
        ("size", "Text size", "sp"),
        ("bold", "Bold", "true / false"),
        ("italic", "Italic", "true / false"),
        ("font", "Font", "sans, serif, mono"),
        ("lines", "Max lines", "number"),
        ("opacity", "Opacity", "0–1"),
    ]

    public static let colorTokens = ["primary", "onPrimary", "background", "surface", "surfaceVariant", "onSurface", "muted", "accent", "border", "danger",
                                     "success", "warning", "bubbleIn", "onBubbleIn", "bubbleOut", "onBubbleOut", "scrim"]
    public static let animTypes = ["none", "fade", "slide-up", "slide-down", "slide-left", "slide-right", "scale", "pop"]
    public static let easings = ["standard", "decelerate", "accelerate", "linear", "overshoot", "bounce"]
    public static let events = ["click", "longClick", "submit", "change"]

    /// The native parts a `slot` names (server SLOTS) and the screens they belong to.
    public static let slots: [(name: String, screens: [String])] = [
        ("splashLogo", ["splash"]), ("logo", ["lock", "enroll", "about", "rooms"]), ("lockPad", ["lock"]), ("enrollForm", ["enroll"]),
        ("roomList", ["rooms"]), ("roomTabs", ["room"]), ("messages", ["room"]), ("composer", ["room"]), ("userPanel", ["room"]),
        ("userList", ["users"]), ("callControls", ["call"]), ("callVideo", ["call"]), ("settingsList", ["settings"]), ("joinForm", ["join"]),
        ("updateProgress", ["update"]), ("msgBody", ["message.in", "message.out"]), ("aiChat", ["ai"]), ("voicePad", ["voice"]),
        ("nfcPanel", ["nfc"]), ("nfcWork", ["nfc"]), ("nfcBuilder", ["nfc.builder"]), ("msgHold", ["message.in", "message.out"]),
    ]

    /// server/android/design.ts LIMITS — what the server's sanitizer allows (DesignReport checks them).
    public enum Limits {
        public static let nodes = 1500, depth = 30, text = 4000, assets = 2 * 1024 * 1024, asset = 512 * 1024
        public static let strings = 3000, libraries = 60, steps = 60, menuItems = 40
    }

    /// ELEMENTS.md: element → props → SwiftUI mapping, then the style props, tokens and events.
    public static func markdown() -> String {
        var out = """
        # M5Design elements

        Generated from `Sources/M5Design/ElementCatalog.swift` (`ElementCatalog.markdown()`; `CatalogTests` fails when this file
        is out of step — run the tests with `M5_WRITE_ELEMENTS_MD=1` to write it again). The format is the Android design's
        (`server/android/design.ts` ELEMENTS); `ScreenResolver` turns a tree into `RenderNode`s whose `content`, `box`,
        `layout`, `container` and `textStyle` carry everything below already resolved.

        | Element | Group | Children | Text | Since |
        |---|---|---|---|---|

        """
        for e in entries {
            out += "| `\(e.el)` | \(e.group) | \(e.container ? "yes" : "—") | \(e.text ? "template" : "—") | \(e.since) |\n"
        }
        for e in entries {
            out += "\n## `\(e.el)` — \(e.label)\n\n\(e.help)\n\n"
            if e.props.isEmpty {
                out += "Props: none.\n"
            } else {
                out += "| Prop | Kind | Meaning |\n|---|---|---|\n"
                for p in e.props {
                    var meaning = p.label
                    if let o = p.options { meaning += " (" + o.joined(separator: ", ") + ")" }
                    if let h = p.help { meaning += " — " + h.replacingOccurrences(of: "|", with: "\\|") }
                    out += "| `\(p.name)` | \(p.kind.rawValue) | \(meaning) |\n"
                }
            }
            out += "\nSwiftUI: \(e.swiftUI)\n"
        }
        out += "\n## Style props (every element)\n\n| Prop | Meaning | Values |\n|---|---|---|\n"
        for s in styleProps { out += "| `\(s.name)` | \(s.label) | \(s.help.replacingOccurrences(of: "|", with: "\\|")) |\n" }
        out += "\nA string starting with `=` is an expression (bg, fg, border, opacity…). Padding, margin and gap are multiplied by the density (compact 0.8, comfortable 1.2); text sizes by the font scale.\n"
        out += "\n## Colour tokens\n\n" + colorTokens.map { "`@\($0)`" }.joined(separator: " · ") + "\n"
        out += "\n## Events\n\n" + events.map { "`\($0)`" }.joined(separator: " · ") + " — each `{ action, arg? }`; `change` sees the new value as `$value`.\n"
        out += "\n## Enter animations\n\n" + animTypes.map { "`\($0)`" }.joined(separator: " · ") + "; easings " + easings.map { "`\($0)`" }.joined(separator: " · ") + ".\n"
        out += "\n## App parts (`slot`)\n\n| Name | Screens |\n|---|---|\n"
        for s in slots { out += "| `\(s.name)` | \(s.screens.joined(separator: ", ")) |\n" }
        out += "\n## Limits (server sanitizer)\n\nnodes \(Limits.nodes) · depth \(Limits.depth) · text \(Limits.text) · strings \(Limits.strings) per language · libraries \(Limits.libraries) · steps \(Limits.steps) · menu items \(Limits.menuItems) · asset \(Limits.asset / 1024) kB · assets \(Limits.assets / 1024 / 1024) MB. The app: expressions ≤ \(Expr.max) characters nested ≤ \(Expr.maxDepth), `each` ≤ 200 items, options ≤ 100, library steps ≤ 60 and no nested `lib.run`, swipe ≤ \(SwipeMath.maxPerSide) actions a side.\n"
        return out
    }
}
