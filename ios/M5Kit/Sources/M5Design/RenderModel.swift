// The render tree: a screen of the design resolved for one state — every
// expression evaluated, every colour token resolved, every size in points —
// so the SwiftUI layer draws it 1:1 without knowing the design's semantics.
// What Android's Renderer.Bound computes into views (create + bind) is here
// as values. Sizes are dp = points; edges are physical (left / right), as
// Android's setPadding / setMargins are.

import Foundation

public struct DesignInsets: Sendable, Hashable {
    public var top: Double, right: Double, bottom: Double, left: Double
    public init(top: Double = 0, right: Double = 0, bottom: Double = 0, left: Double = 0) {
        self.top = top; self.right = right; self.bottom = bottom; self.left = left
    }
    public init(all v: Double) { self.init(top: v, right: v, bottom: v, left: v) }
    public static let zero = DesignInsets()
}

/// A width or a height in the parent.
public enum Dimension: Sendable, Hashable {
    /// MATCH_PARENT: as large as the parent allows.
    case fill
    /// WRAP_CONTENT: as large as the content.
    case wrap
    case points(Double)
}

/// Alignment across a row's / column's axis (Android child gravity).
public enum CrossAlign: Sendable, Hashable {
    /// No gravity: the start (top in a row, leading in a column).
    case none
    case start, center, end
}

/// Alignment of a child in a stack (FrameLayout gravity).
public enum FrameAlign: Sendable, Hashable {
    /// No gravity: top-left.
    case none
    case topStart, center, bottomEnd
    /// "stretch": fills both ways.
    case fill
}

/// Where a child sits in its parent and how big it is (Renderer.Bound.params).
public struct LayoutParams: Sendable, Hashable {
    public var width: Dimension
    public var height: Dimension
    /// > 0: a share of the free space along the parent's axis (the axis' dimension is then 0).
    public var weight: Double
    /// In a row (vertical) or a column (horizontal).
    public var crossAlign: CrossAlign
    /// In a stack.
    public var frameAlign: FrameAlign
    /// Margins, the parent's gap included (left in a row, top in a column, for every child after the first).
    public var margin: DesignInsets

    public init(width: Dimension = .wrap, height: Dimension = .wrap, weight: Double = 0, crossAlign: CrossAlign = .none, frameAlign: FrameAlign = .none, margin: DesignInsets = .zero) {
        self.width = width; self.height = height; self.weight = weight; self.crossAlign = crossAlign; self.frameAlign = frameAlign; self.margin = margin
    }
}

/// How a container lays out its children.
public struct ContainerSpec: Sendable, Hashable {
    public enum Kind: Sendable, Hashable {
        /// LinearLayout VERTICAL — column, card, sheet, swipe content, a vertical scroll's content.
        case vertical
        /// LinearLayout HORIZONTAL — row, a horizontal scroll's content.
        case horizontal
        /// FrameLayout — stack.
        case overlay
        /// FlowLayout — a row with wrap.
        case flow
    }
    public enum Justify: Sendable, Hashable { case start, center, end }
    public enum ScrollAxis: Sendable, Hashable { case vertical, horizontal }

    public var kind: Kind
    /// The main-axis gravity of a row / column / card / sheet ("between" / "around" come as `.flex` children instead).
    public var justify: Justify
    /// A scroll element: the axis it scrolls (vertical fills the viewport).
    public var scroll: ScrollAxis?
    /// A flow: the gap between items and between lines.
    public var flowGap: Double

    public init(kind: Kind, justify: Justify = .start, scroll: ScrollAxis? = nil, flowGap: Double = 0) {
        self.kind = kind; self.justify = justify; self.scroll = scroll; self.flowGap = flowGap
    }
}

public struct BorderSpec: Sendable, Hashable {
    public var width: Double
    public var color: DesignColor
}

/// What a press shows.
public enum PressFeedback: Sendable, Hashable {
    case none
    /// A ripple of this colour over the content.
    case ripple(DesignColor)
    /// The view shrinks a little while held (Settings › Appearance › press "scale").
    case scale
    /// The platform's standard highlight (a clickable element without a background).
    case system
}

/// The element's own box: padding, background, border, corners, shadow, opacity.
public struct BoxStyle: Sendable, Hashable {
    public var padding: DesignInsets
    /// The painted background (nil: none).
    public var fill: DesignColor?
    /// Corner radius of the background and the clip (999 = a pill / circle).
    public var radius: Double
    public var border: BorderSpec?
    /// 0–1 (nil: opaque).
    public var opacity: Double?
    /// Shadow depth (dp).
    public var elevation: Double?
    public var minHeight: Double?
    public var press: PressFeedback

    public init(padding: DesignInsets = .zero, fill: DesignColor? = nil, radius: Double = 0, border: BorderSpec? = nil, opacity: Double? = nil,
                elevation: Double? = nil, minHeight: Double? = nil, press: PressFeedback = .none) {
        self.padding = padding; self.fill = fill; self.radius = radius; self.border = border; self.opacity = opacity
        self.elevation = elevation; self.minHeight = minHeight; self.press = press
    }
}

public enum FontWeightKind: Sendable, Hashable { case regular, medium, bold }
public enum TextAlign: Sendable, Hashable { case start, center, end }

/// The text of a textual element as Renderer.textAppearance sets it.
public struct TextStyle: Sendable, Hashable {
    /// Points, the user's text size already applied.
    public var size: Double
    public var weight: FontWeightKind
    public var italic: Bool
    public var family: FontFamily
    /// Max lines, ellipsised at the end (nil: no limit).
    public var lines: Int?
    public var align: TextAlign
    /// Line height multiplier.
    public var lineSpacing: Double
    public var maxWidth: Double?
    /// The text colour.
    public var color: DesignColor
    /// An input's hint colour.
    public var hintColor: DesignColor?
}

/// An icon to draw (a Lucide name; Icons.sfSymbol maps it).
public struct IconRef: Sendable, Hashable {
    public var name: String
    public var size: Double
    public var color: DesignColor
    /// Space between the icon and the text.
    public var gap: Double
}

public struct DesignOption: Sendable, Hashable {
    public var value: String
    public var label: String
    public init(value: String, label: String) { self.value = value; self.label = label }
}

public enum ImageSource: Sendable, Hashable {
    case none
    /// "asset:<name>" — the design's asset (nil data: the design has no such asset).
    case asset(name: String, data: Data?)
    /// "data:image/…;base64,…" decoded.
    case data(mime: String, data: Data)
    /// A fixed https image of the design (the app loads it; DesignUrls already allowed it).
    case remote(URL)
}

public enum ImageFit: String, Sendable, Hashable { case cover, contain, center }

public enum InputKind: String, Sendable, Hashable { case text, password, number, email, phone, url, multiline }

/// A design action ready to run: the action, its argument as written, and the scope it is evaluated in.
public struct RenderEvent: Sendable, Hashable {
    public enum Haptic: Sendable, Hashable { case none, tick, long }
    public var action: String
    public var raw: String?
    public var scope: Scope
    /// A short tick under the finger (buttons, icon buttons, chips) or the long-press one.
    public var haptic: Haptic
}

/// An element bound to a setting or a form value; ActionRunner.commit writes a new value and runs `change`.
public struct ValueBinding: Sendable, Hashable {
    public var setting: String?
    public var bind: String?
    public var change: EventHandler?
    public var scope: Scope
}

/// A side action of a swipe row (a menu item resolved in the row's scope).
public struct SwipeAction: Sendable, Hashable {
    public var icon: String
    public var label: String
    public var action: String
    public var raw: String?
    public var value: DesignValue?
    public var scope: Scope
}

/// A menu item resolved for showing (MainActivity.showMenu).
public struct ResolvedMenuItem: Sendable, Hashable {
    public var id: String
    public var icon: String
    public var label: String
    public var action: String
    public var raw: String?
    public var scope: Scope
    public var dangerous: Bool
}

public struct EnterAnimation: Sendable, Hashable {
    /// fade, slide-up, slide-down, slide-left, slide-right, scale, pop
    public var type: String
    /// Milliseconds (the user's motion and speed applied).
    public var duration: Double
    public var delay: Double
    /// How far a slide starts (points).
    public var distance: Double
    /// The scale a "scale" / "pop" starts at.
    public var fromScale: Double
    public var easing: Easing
}

// MARK: - contents

public struct TextContent: Sendable, Hashable {
    public var text: String
    /// Web addresses and e-mails are links.
    public var links: Bool
    public var icon: IconRef?
}

public struct ButtonContent: Sendable, Hashable {
    public var text: String
    public var icon: IconRef?
    public var disabled: Bool
}

public struct IconButtonContent: Sendable, Hashable {
    public var icon: String
    public var iconSize: Double
    public var iconColor: DesignColor
    /// The button's shape (nil fill and border: none — only the press shows).
    public var fill: DesignColor?
    public var border: BorderSpec?
    public var radius: Double
    public var press: PressFeedback
    /// The accessible label (and a tooltip).
    public var label: String
    /// "1"…"99", "99+" (nil: no badge).
    public var badge: String?
    public var badgeFill: DesignColor
    public var badgeText: DesignColor
}

public struct IconContent: Sendable, Hashable {
    public var name: String
    public var size: Double
    public var color: DesignColor
}

public struct ImageContent: Sendable, Hashable {
    public var source: ImageSource
    public var fit: ImageFit
    /// Width / height (0: the image's own).
    public var ratio: Double
}

public struct AvatarContent: Sendable, Hashable {
    public var name: String
    public var initials: String
    public var color: DesignColor
    public var size: Double
}

public struct InputContent: Sendable, Hashable {
    public var bind: String?
    public var hint: String
    public var kind: InputKind
    /// $form[bind] as text.
    public var value: String
    public var background: DesignColor
    public var radius: Double
    /// Has a submit event (Enter runs it).
    public var submits: Bool
}

public struct ToggleContent: Sendable, Hashable {
    public enum Style: Sendable, Hashable { case toggle, checkbox }
    public var style: Style
    public var text: String
    public var checked: Bool
    public var tint: DesignColor
    /// A tap writes the new state (ActionRunner.commit) — bound and without a click event.
    public var commitsOnTap: Bool
}

public struct SelectContent: Sendable, Hashable {
    public var options: [DesignOption]
    public var current: String
    /// What it shows: the current option's label, else the hint.
    public var label: String
    public var chevron: IconRef
    public var radius: Double
}

public struct SliderContent: Sendable, Hashable {
    public var min: Double
    public var max: Double
    public var step: Double
    /// The bound value.
    public var value: Double
    /// Where the thumb is, 0…1 (in thousandths, as Android's SeekBar).
    public var fraction: Double
    public var tint: DesignColor

    /// The value a released thumb commits (Renderer.sliderValue): stepped, rounded to 3 decimals.
    public func value(atFraction f: Double) -> Double {
        let progress = Double(Swift.max(0, Swift.min(1000, JavaSemantics.roundInt(f * 1000))))
        var v = min + (max - min) * progress / 1000
        if step > 0 { v = min + Double(JavaSemantics.round((v - min) / step)) * step }
        return Double(JavaSemantics.round(v * 1000)) / 1000
    }
}

public struct SegmentedContent: Sendable, Hashable {
    public var options: [DesignOption]
    public var selectedIndex: Int?
    public var selectedFill: DesignColor
    public var selectedText: DesignColor
    public var text: DesignColor
    public var selectedWeight: FontWeightKind
    public var selectedElevation: Double
    public var textSize: Double
    public var outerRadius: Double
    public var innerRadius: Double
}

public struct SheetContent: Sendable, Hashable {
    /// "dock": a card floating above the composer; else a sheet from the bottom.
    public var dock: Bool
    /// The sheet closes before any action its elements run.
    public var dismissOnAction: Bool
}

public struct SwipeContent: Sendable, Hashable {
    /// Revealed by a drag to the right (tiles at the left edge).
    public var right: [SwipeAction]
    /// Revealed by a drag to the left (tiles at the right edge).
    public var left: [SwipeAction]
    public var rightColor: DesignColor
    public var leftColor: DesignColor
    public var surface: DesignColor
    public var tonal: DesignColor
    public var onSurface: DesignColor
}

public enum RenderContent: Sendable, Hashable {
    case container
    /// text, badge, chip
    case text(TextContent)
    case button(ButtonContent)
    case iconButton(IconButtonContent)
    case icon(IconContent)
    case image(ImageContent)
    case avatar(AvatarContent)
    case divider
    case spacer
    /// A flexible space a container's justify "between" / "around" puts between children.
    case flex
    /// nil: spinning (no value prop).
    case progress(Double?)
    case input(InputContent)
    case toggle(ToggleContent)
    case select(SelectContent)
    case slider(SliderContent)
    case segmented(SegmentedContent)
    /// A native part of the app.
    case slot(String)
    case sheet(SheetContent)
    case swipe(SwipeContent)
    /// An element this version does not know: nothing is drawn.
    case unknown(String)
}

/// One resolved element.
public struct RenderNode: Sendable, Hashable, Identifiable {
    /// Unique in the tree and stable across states: the design ids on the path, "#i" for a repeated copy.
    public var id: String
    /// The design node's own id.
    public var nodeId: String
    public var element: ElementKind
    /// A group holding the copies of a repeated (`each`) node.
    public var isRepeat: Bool
    public var layout: LayoutParams
    public var container: ContainerSpec?
    public var box: BoxStyle
    public var textStyle: TextStyle?
    /// The foreground colour (texts, icons); children inherit it.
    public var foreground: DesignColor
    public var content: RenderContent
    /// click, longClick, submit.
    public var events: [String: RenderEvent]
    public var binding: ValueBinding?
    public var accessibilityLabel: String?
    public var enter: EnterAnimation?
    public var children: [RenderNode]
    /// The element's scope (for slots and the app's own parts).
    public var scope: Scope

    /// The first node (depth first) with this design id.
    public func find(_ nodeId: String) -> RenderNode? {
        if self.nodeId == nodeId && !isRepeat { return self }
        for c in children { if let f = c.find(nodeId) { return f } }
        return nil
    }

    /// Every node of the tree, depth first.
    public func all() -> [RenderNode] { [self] + children.flatMap { $0.all() } }
}
