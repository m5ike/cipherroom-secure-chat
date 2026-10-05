// The input controls inside the design's rows: a switch keeps its whole track inside the row
// (Android measures a Switch at its whole size — WRAP_CONTENT after the weighted label; iOS 26's
// UISwitch draws 2 pt wider than SwiftUI's Toggle measures it, and the row's clip cut its end off).

import M5Design
import SwiftUI
import UIKit
import XCTest
@testable import M5cet

@MainActor
final class RendererControlsLayoutTests: XCTestCase {
    private func switches(in v: UIView) -> [UISwitch] {
        var out: [UISwitch] = []
        if let s = v as? UISwitch { out.append(s) }
        for s in v.subviews { out += switches(in: s) }
        return out
    }

    /// Every switch's drawn frame lies, across, inside every box above it that clips (up to the window).
    private func assertSwitchesUnclipped(_ root: UIView, in window: UIWindow, _ what: String, file: StaticString = #filePath, line: UInt = #line) -> Int {
        let found = switches(in: root)
        for s in found where !s.isHidden && s.window != nil {
            let f = s.convert(s.bounds, to: window)
            var p = s.superview
            while let q = p {
                if q.clipsToBounds {
                    let c = q.convert(q.bounds, to: window)
                    XCTAssertGreaterThanOrEqual(f.minX, c.minX - 0.5, "\(what): a switch starts left of its clip \(c)", file: file, line: line)
                    XCTAssertLessThanOrEqual(f.maxX, c.maxX + 0.5, "\(what): a switch at \(f) is cut off by \(type(of: q)) at \(c.maxX)", file: file, line: line)
                }
                if q is UIScrollView { break }
                p = q.superview
            }
        }
        return found.count
    }

    func testASwitchInASettingsRowIsWhollyInsideTheRow() throws {
        let host = RendererTestSupport.host()
        // Settings › Notifications' row: icon, weighted label, switch; a labelled switch on its own line too.
        let tree: DesignValue = ["el": "column", "children": [
            ["id": "r", "el": "row", "style": ["padding": "10 12 10 20", "gap": 18, "align": "center"], "children": [
                ["id": "i", "el": "icon", "props": ["icon": "eye", "size": 22, "color": "@muted"]],
                ["id": "l", "el": "text", "text": "Show room names", "style": ["size": 16, "weight": 1]],
                ["id": "s", "el": "switch", "props": ["setting": "watch.on"]],
            ]],
            ["id": "s2", "el": "switch", "text": "Labelled", "props": ["setting": "notify.quiet"], "style": ["padding": "0 12 0 20"]],
        ]]
        let node = try XCTUnwrap(try ScreenResolver(host.renderContext()).resolve(DesignNode(value: tree), scope: .empty))
        let size = RendererTestSupport.iPhone
        let (vc, window) = RendererTestSupport.show(NodeView(node: node).environment(host).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top), size: size)
        defer { window.isHidden = true }
        _ = RendererTestSupport.draw(vc.view)
        XCTAssertEqual(assertSwitchesUnclipped(vc.view, in: window, "row"), 2)
        // The row's switch ends at the row's padding (402 − 12), not past it.
        let s = try XCTUnwrap(switches(in: vc.view).min { $0.convert($0.bounds, to: window).minY < $1.convert($1.bounds, to: window).minY })
        XCTAssertEqual(s.convert(s.bounds, to: window).maxX, size.width - 12, accuracy: 0.5)
    }

    func testEverySettingsScreensSwitchesAreUnclippedOnAPhoneAndAnIPad() {
        let state = SampleScreenState()
        let screens = DesignAssets.builtIn.document.screens.keys.filter { $0.hasPrefix("settings") }.sorted()
        for (size, regular) in [(RendererTestSupport.iPhone, false), (RendererTestSupport.iPadLandscape, true)] {
            let host = RendererTestSupport.host(state: state)
            SampleSlots.register(into: host.services.slots, state: state)
            host.showScreen("splash", transition: false)
            let (vc, window) = RendererTestSupport.show(DesignShell(host: host), size: size, regular: regular)
            defer { window.isHidden = true }
            var total = 0
            for id in screens {
                host.showScreen(id, transition: false)
                _ = RendererTestSupport.draw(vc.view)
                total += assertSwitchesUnclipped(vc.view, in: window, id)
            }
            XCTAssertGreaterThan(total, 10, "the settings screens have switches")
        }
    }
}
