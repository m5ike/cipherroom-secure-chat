// Every screen of the built-in design draws — light and dark, iPhone and iPad (regular
// width) — hosted in a UIHostingController with the console's sample state; and the
// layouts measure as Android's (LinearLayout, FrameLayout, FlowLayout).

import M5Design
import SwiftUI
import UIKit
import XCTest
@testable import M5cet

@MainActor
final class RendererScreensTests: XCTestCase {
    /// The screens of the design (all 44 the console knows, templates included).
    private var screenIds: [String] { DesignAssets.builtIn.document.screens.keys.sorted() }

    func testTheDesignHasEveryScreenOfTheCatalogue() {
        XCTAssertGreaterThanOrEqual(screenIds.count, 44)
        XCTAssertTrue(Set(SampleScreenData.screens).isSubset(of: Set(screenIds)))
    }

    func testEveryScreenResolvesWithItsSampleInBothTones() {
        for dark in [false, true] {
            let host = RendererTestSupport.host()
            host.toneOverride = dark
            for id in screenIds {
                host.showScreen(id, transition: false)
                let node = host.resolve(id, scope: host.scope(for: id), context: host.renderContext(animateEnter: true))
                XCTAssertNotNil(node, "\(id) (dark: \(dark))")
                let ids = node?.all().map(\.id) ?? []
                XCTAssertEqual(Set(ids).count, ids.count, "\(id): ids repeat")
            }
        }
    }

    func testEveryScreenDrawsOnAPhoneAndAnIPadInBothTones() {
        let state = SampleScreenState()
        for (size, regular) in [(RendererTestSupport.iPhone, false), (RendererTestSupport.iPadLandscape, true)] {
            for dark in [false, true] {
                let host = RendererTestSupport.host(state: state)
                SampleSlots.register(into: host.services.slots, state: state)
                host.toneOverride = dark
                host.showScreen("splash", transition: false)
                let (vc, window) = RendererTestSupport.show(DesignShell(host: host), size: size, regular: regular, dark: dark)
                defer { window.isHidden = true }
                for id in screenIds {
                    host.showScreen(id, transition: false)
                    let image = RendererTestSupport.draw(vc.view)
                    XCTAssertEqual(host.screen, id)
                    XCTAssertEqual(image.size, size)
                }
                // The overlay too: a sheet, the dock, a flash.
                host.showScreen("room", transition: false)
                host.showSheet("tools")
                host.showFlash(title: "", text: "Saved.", level: .success)
                _ = RendererTestSupport.draw(vc.view)
                host.closeOverlay()
                host.showSheet("join")
                _ = RendererTestSupport.draw(vc.view)
                XCTAssertEqual(host.sheet?.screen, "join")
            }
        }
    }

    func testAScreenFillsTheWindowAndIsReadableWideOnAnIPad() {
        let host = RendererTestSupport.host()
        host.showScreen("settings", transition: false)
        let phone = RendererTestSupport.layOut(ScreenView(screen: "settings").environment(host), size: RendererTestSupport.iPhone)
        XCTAssertEqual(phone.view.bounds.size, RendererTestSupport.iPhone)
        let size = RendererTestSupport.idealSize(ScreenView(screen: "flash").environment(host).frame(width: 300))
        XCTAssertEqual(size.width, 300)
        XCTAssertLessThan(DesignShell.readableWidth, RendererTestSupport.iPadLandscape.width)
    }

    // MARK: layouts (sizes through SwiftUI, the way the screens use them)

    /// A one-screen design around a tree.
    private func measure(_ tree: DesignValue, width: CGFloat? = nil) throws -> CGSize {
        let host = RendererTestSupport.host()
        let node = try XCTUnwrap(try ScreenResolver(host.renderContext()).resolve(DesignNode(value: tree), scope: .empty))
        let view = NodeView(node: node).environment(host)
        if let width {
            let vc = UIHostingController(rootView: view.frame(width: width).fixedSize(horizontal: false, vertical: true))
            return vc.sizeThatFits(in: CGSize(width: width, height: 10_000))
        }
        return RendererTestSupport.idealSize(view)
    }

    private func box(_ w: Int, _ h: Int, _ style: [String: DesignValue] = [:]) -> DesignValue {
        var s = style
        s["width"] = .number(Double(w))
        s["height"] = .number(Double(h))
        return ["el": "spacer", "props": ["size": 1], "style": .object(s)]
    }

    func testAColumnWrapsItsChildrenWithGapAndPadding() throws {
        let size = try measure(["el": "column", "style": ["padding": 10, "gap": 8], "children": [box(20, 20), box(30, 30)]])
        XCTAssertEqual(size.height, 10 + 20 + 8 + 30 + 10, accuracy: 0.5)
        XCTAssertEqual(size.width, 10 + 30 + 10, accuracy: 0.5)
    }

    func testARowAddsWidthsAndTakesTheTallest() throws {
        let size = try measure(["el": "row", "style": ["gap": 4, "padding": "2 6"], "children": [box(40, 10), box(20, 30, ["margin": "0 0 0 5"])]])
        XCTAssertEqual(size.width, 6 + 40 + 4 + 5 + 20 + 6, accuracy: 0.5)
        XCTAssertEqual(size.height, 2 + 30 + 2, accuracy: 0.5)
    }

    func testAWrappingRowFlowsOntoMoreLines() throws {
        let kids = (0..<5).map { _ in box(50, 20) }
        let size = try measure(["el": "row", "props": ["wrap": true], "style": ["gap": 4], "children": .array(kids)], width: 120)
        XCTAssertEqual(size.height, 3 * 20 + 2 * 4, accuracy: 0.5, "two per line at 120 pt")
    }

    func testAStackIsAsBigAsItsBiggestChild() throws {
        let size = try measure(["el": "stack", "children": [box(40, 10), box(20, 30)]])
        XCTAssertEqual(size.width, 40, accuracy: 0.5)
        XCTAssertEqual(size.height, 30, accuracy: 0.5)
    }

    func testWeightsShareTheFreeSpace() throws {
        // A 120 pt row: the weighted text gets what the 40 pt box leaves — it wraps as a text 80 pt wide.
        let long: DesignValue = .string(String(repeating: "word ", count: 30))
        let row = try measure(["el": "column", "children": [["el": "row", "style": ["width": 120], "children": [
            box(40, 10), ["el": "text", "text": long, "style": ["weight": 1]],
        ]]]])
        let alone = try measure(["el": "column", "children": [["el": "text", "text": long, "style": ["width": 80]]]])
        XCTAssertEqual(row.height, alone.height, accuracy: 1)
        XCTAssertGreaterThan(row.height, 40)
        // A wrapping row: weighted children share their own sizes (LinearLayout's consumed excess).
        let t1 = try measure(["el": "text", "text": "short"]), t2 = try measure(["el": "text", "text": "a longer text"])
        let wrap = try measure(["el": "row", "children": [["el": "text", "text": "short", "style": ["weight": 1]],
                                                          ["el": "text", "text": "a longer text", "style": ["weight": 1]]]])
        XCTAssertEqual(wrap.width, t1.width + t2.width, accuracy: 1)
    }

    func testTextWrapsAtTheWidthItGets() throws {
        let long = String(repeating: "word ", count: 40)
        let one = try measure(["el": "text", "text": "word"])
        let wrapped = try measure(["el": "column", "children": [["el": "text", "text": .string(long)]]], width: 120)
        XCTAssertGreaterThan(wrapped.height, one.height * 4)
        let lines = try measure(["el": "column", "children": [["el": "text", "text": .string(long), "style": ["lines": 2]]]], width: 120)
        XCTAssertLessThan(lines.height, one.height * 3)
    }
}
