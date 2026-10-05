// The outputs' logic (android fn/FnView, FnForm, FnAsk, FlowRow): buttons in
// rows, once-memory, file names, button styles, a form's initial values,
// collected values and problems (Outputs.checkFormValues), a question's
// answers, the call bubble's progress, and the views drawing every output type
// of the server's own report in a window (light and dark).

import M5Core
import M5Design
import M5Proto
import SwiftUI
import XCTest
@testable import M5cet

@MainActor
final class FnOutputsTests: XCTestCase {
    private func obj(_ s: String) -> JSONObject { (try? JSON.parse(s))?.objectValue ?? JSONObject() }

    func testConsecutiveButtonsShareARow() {
        let outputs: [JSON] = [["type": "text", "text": "a"], ["type": "button", "name": "x"], ["type": "button", "name": "y"], ["type": "markdown", "text": "b"],
                               ["type": "button", "name": "z"], "not an object"]
        let parts = FnOutputsLayout.parts(outputs)
        XCTAssertEqual(parts.count, 4)
        guard case .item(0, _) = parts[0], case .buttons(let row) = parts[1], case .item(3, _) = parts[2], case .buttons(let last) = parts[3] else { return XCTFail("\(parts)") }
        XCTAssertEqual(row.map(\.0), [1, 2])
        XCTAssertEqual(last.map(\.0), [4])
    }

    func testOnceMemory() {
        let k = "once-" + UUID().uuidString
        XCTAssertFalse(FnOnce.happened(k))
        XCTAssertTrue(FnOnce.firstTime(k))
        XCTAssertFalse(FnOnce.firstTime(k))
        XCTAssertTrue(FnOnce.happened(k))
        for i in 0..<2001 { FnOnce.firstTime(k + "-\(i)") }
        XCTAssertFalse(FnOnce.happened(k)) // the oldest went (the newest 2000 are kept)
    }

    func testFileNames() {
        XCTAssertEqual(FnOutputsLayout.fileName("Graf / týden!", "image.png"), "Graf  týden.png")
        XCTAssertEqual(FnOutputsLayout.fileName("", "image.svg"), "image.svg")
        XCTAssertEqual(FnOutputsLayout.imageName("image/jpeg"), "image.jpg")
        XCTAssertEqual(ToolsSheets.safeName("../a/b:c"), "_._a_b_c")
    }

    func testButtonStyles() {
        let look = ToolsLook(host: toolsHost())
        let primary = FnButtonStyle.of(css: " primary ", style: nil, look: look)
        XCTAssertEqual(primary.fill, look.color("@primary"))
        XCTAssertEqual(primary.ink, look.color("@onPrimary"))
        let own = FnButtonStyle.of(css: " danger ", style: obj("{\"color\":\"#00ff00\",\"background\":\"rgb(1,2,3)\"}"), look: look)
        XCTAssertEqual(own.ink, DesignColor(argb: 0xFF00_FF00).color)
        XCTAssertEqual(own.fill, DesignColor(argb: 0xFF01_0203).color)
        XCTAssertEqual(own.stroke, look.color("@danger"))
        XCTAssertEqual(FnButtonStyle.of(css: " ghost ", style: nil, look: look).fill, DesignColor.transparent.color)
    }

    // MARK: forms

    func testAFormsInitialValues() {
        XCTAssertEqual(FnFormState.initialValue(obj("{\"type\":\"checkbox\",\"default\":\"true\"}")), .bool(true))
        XCTAssertEqual(FnFormState.initialValue(obj("{\"type\":\"switch\",\"default\":1}")), .bool(true))
        XCTAssertEqual(FnFormState.initialValue(obj("{\"type\":\"switch\"}")), .bool(false))
        XCTAssertEqual(FnFormState.initialValue(obj("{\"type\":\"multiselect\",\"default\":[1,\"b\"]}")), .array(["1", "b"]))
        XCTAssertEqual(FnFormState.initialValue(obj("{\"type\":\"multiselect\",\"default\":\"a\"}")), .array(["a"]))
        XCTAssertEqual(FnFormState.initialValue(obj("{\"type\":\"number\"}")), "")
        XCTAssertEqual(FnFormState.initialValue(obj("{\"type\":\"number\",\"default\":\"2.5\"}")), .double(2.5))
        XCTAssertEqual(FnFormState.initialValue(obj("{\"type\":\"range\",\"min\":3}")), .int(3))
        XCTAssertEqual(FnFormState.initialValue(obj("{\"type\":\"range\"}")), .int(0))
        XCTAssertEqual(FnFormState.initialValue(obj("{\"type\":\"text\",\"default\":7}")), "7")
    }

    func testAFormsValuesAndProblems() {
        let spec = obj("""
        {"type":"form","name":"order","fields":[{"name":"email","type":"email","required":true},{"name":"n","type":"number","min":2,"max":9},
         {"name":"phone","type":"masked","mask":"+{420} 000 000 000"},{"name":"note","type":"text"},{"name":"h","type":"hidden","default":"x"}],
         "panels":[{"title":"More","collapsed":true,"fields":[{"name":"ok","type":"checkbox","required":true},{"name":"tags","type":"multiselect","options":[{"value":"a","label":"A"},{"value":"b","label":"B","icon":"🅱️"}]}]}]}
        """)
        let f = FnFormState(spec: spec)
        XCTAssertEqual(f.fields.map { $0.optString("name") }, ["email", "n", "phone", "note", "h", "ok", "tags"])
        XCTAssertNil(f.check())
        XCTAssertEqual(f.problems["email"], "required")
        XCTAssertEqual(f.problems["ok"], "required")
        XCTAssertNil(f.problems["n"]) // an empty number is left out
        f.set("email", "not an address")
        f.set("n", "1")
        f.set("phone", .string(Outputs.applyMask("+{420} 000 000 000", "777123")))
        f.set("ok", true)
        XCTAssertNil(f.check())
        XCTAssertEqual(f.problems["email"], "email")
        XCTAssertEqual(f.problems["n"], "min 2")
        XCTAssertEqual(f.problems["phone"], "incomplete")
        XCTAssertEqual(FnFormState.problemText("min 2") { ToolsLook.words($0, [], { $0 }) }, "Not a valid value (min 2)")
        f.set("email", "a@b.cz")
        f.set("n", "4")
        f.set("phone", .string(Outputs.applyMask("+{420} 000 000 000", "777123456")))
        f.set("tags", ["b"])
        let values = f.check()
        XCTAssertEqual(values.map { JSON.object($0).canonical() },
                       "{\"email\":\"a@b.cz\",\"h\":\"x\",\"n\":4,\"note\":\"\",\"ok\":true,\"phone\":\"+420 777 123 456\",\"tags\":[\"b\"]}")
        XCTAssertEqual(FnFormState.options(spec.array("panels")![0].objectValue!.array("fields")![1].objectValue!).map(\.1), ["A", "🅱️ B"])
        // Sending locks it; a once-form stays sent.
        XCTAssertFalse(f.locked(reachable: true))
        XCTAssertTrue(f.locked(reachable: false))
        f.state = "busy"
        XCTAssertTrue(f.locked(reachable: true))
        let once = FnFormState(spec: obj("{\"once\":true,\"fields\":[]}"), sent: true)
        XCTAssertTrue(once.locked(reachable: true))
    }

    // MARK: questions

    func testAQuestionsFormAnswersAsText() {
        let i = FnRun.Interaction(obj("{\"runId\":\"r\",\"id\":\"i\",\"kind\":\"form\",\"spec\":{\"fields\":[{\"name\":\"name\",\"required\":true},{\"name\":\"ok\",\"type\":\"boolean\"},{\"name\":\"tier\",\"values\":[\"a\",\"b\"]},{\"name\":\"pin\",\"type\":\"secret\"}]}}"))
        XCTAssertEqual(FnAskView.missing(i.fields, texts: [:]), ["name"])
        XCTAssertEqual(FnAskView.missing(i.fields, texts: ["name": " Alice "]), [])
        let v = FnAskView.values(i.fields, texts: ["name": "Alice", "pin": "1234"], switches: ["ok": true], choices: [:])
        XCTAssertEqual(JSON.object(v).canonical(), "{\"name\":\"Alice\",\"ok\":\"true\",\"pin\":\"1234\",\"tier\":\"a\"}")
        XCTAssertEqual(FnAskView.keyboard("integer"), .numberPad)
        XCTAssertEqual(FnAskView.keyboard("email"), .emailAddress)
        XCTAssertEqual(FnAskView.keyboard("tel"), .phonePad)
        XCTAssertFalse(FnAskView.capitalize("hostname"))
    }

    // MARK: the call bubble

    func testTheCallBubblesProgressInBothForms() {
        XCTAssertEqual(FnCallView.progress(obj("{\"progress\":{\"p\":0.4,\"text\":\" DNS \"}}")).p, 0.4)
        XCTAssertEqual(FnCallView.progress(obj("{\"progress\":{\"p\":0.4,\"text\":\" DNS \"}}")).text, "DNS")
        XCTAssertEqual(FnCallView.progress(obj("{\"progress\":0.7,\"progressText\":\"TLS\"}")).text, "TLS")
        XCTAssertEqual(FnCallView.progress(obj("{}")).p, -1)
        var m = ChatMessage()
        m.fnLocal = obj("{\"keyword\":\"x\",\"query\":\"/x\",\"pending\":true}")
        XCTAssertTrue(FnMessageContent.isCall(m))
        XCTAssertTrue(FnMessageContent.handles(m))
        var plain = ChatMessage()
        plain.text = "hi"
        XCTAssertFalse(FnMessageContent.handles(plain))
    }

    // MARK: drawing

    /// Every output of the server's report, plus the rest of the kinds, draws in a window (both tones).
    func testEveryOutputDraws() throws {
        let done = ToolsFixtures.body("runReport").components(separatedBy: "\n\n").first { $0.hasPrefix("event: done") }!
        let d = FnRun.Done(obj(String(done.components(separatedBy: "\n").first { $0.hasPrefix("data: ") }!.dropFirst(6))))
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        let more: [JSON] = [["type": "text", "text": "plain"], ["type": "code", "text": "let x = 1"], ["type": "json", "value": ["a": 1], "title": "JSON"],
                            ["type": "image", "mime": "image/png", "data": .string(png), "alt": "dot"], ["type": "file", "name": "a.txt", "mime": "text/plain", "data": "eA=="],
                            ["type": "flash", "text": "done", "level": "success"], ["type": "js", "code": "x"], ["type": "window", "id": "ai"],
                            ["type": "form", "name": "f", "fields": [["name": "e", "type": "email"]]], ["type": "audio", "mime": "audio/wav", "data": "UklGRg=="]]
        let engine = ToolsFnEngine(transport: FakeTransport())
        for dark in [false, true] {
            let host = toolsHost()
            host.toneOverride = dark
            let look = ToolsLook(host: host)
            let view = FnOutputsView(key: "draw-\(dark)", outputs: d.outputs + more, meta: FnRun.meta(.object(d.message(keyword: "report", name: "R", visibility: "caller").local)),
                                     createdAt: Millis.now, ink: nil, host: engine.outputsHost(host), look: look)
                .environment(host)
                .frame(width: 360)
            let (vc, window) = RendererTestSupport.show(ScrollView { view }, size: CGSize(width: 390, height: 1600), dark: dark)
            defer { window.isHidden = true }
            settle(0.5)
            let image = RendererTestSupport.draw(vc.view)
            XCTAssertGreaterThan(image.size.height, 0)
        }
    }
}
