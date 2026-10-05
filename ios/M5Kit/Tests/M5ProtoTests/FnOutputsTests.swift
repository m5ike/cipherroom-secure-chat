// The output rules (client/src/lib/fn-outputs.ts) — android fn/OutputsTest,
// the cases of test/fn-outputs.test.tsx and test/functions-lib.test.ts.

import M5Core
import M5Proto
import Testing

/// The same JSON, whatever the order of keys.
func fnSame(_ expected: String, _ actual: JSONObject?, sourceLocation: SourceLocation = #_sourceLocation) {
    fnSame(expected, actual.map(JSON.object), sourceLocation: sourceLocation)
}

func fnSame(_ expected: String, _ actual: JSON?, sourceLocation: SourceLocation = #_sourceLocation) {
    let e = try? JSON.parse(expected)
    #expect(e != nil, "expected JSON parses", sourceLocation: sourceLocation)
    #expect(e == actual, "\(actual.map { $0.canonical() } ?? "nil") is \(expected)", sourceLocation: sourceLocation)
}

func fnSame(_ expected: String, _ actual: [JSON], sourceLocation: SourceLocation = #_sourceLocation) {
    fnSame(expected, JSON.array(actual), sourceLocation: sourceLocation)
}

/// A JSON object from its text.
func fnObj(_ s: String) -> JSONObject { JSON.parseObject(s) ?? JSONObject() }

/// A JSON array from its text.
func fnList(_ s: String) -> [JSON] { (try? JSON.parse(s))?.arrayValue ?? [] }

@Suite("fn Outputs")
struct FnOutputsTests {
    @Test func markdownOfEachKind() {
        let outputs = fnList("[{\"type\":\"markdown\",\"text\":\"# Hi\"},{\"type\":\"code\",\"text\":\"x=1\",\"lang\":\"py\"},"
            + "{\"type\":\"table\",\"columns\":[\"a\",\"b\"],\"rows\":[[1,2],[\"x|y\",4]],\"title\":\"T\"},{\"type\":\"json\",\"value\":{\"ok\":true}},"
            + "{\"type\":\"flash\",\"text\":\"done\",\"level\":\"success\"},{\"type\":\"image\",\"mime\":\"image/png\",\"data\":\"AA==\",\"alt\":\"chart\"}]")
        #expect(Outputs.toMarkdown(outputs) == "# Hi\n\n```py\nx=1\n```\n\n**T**\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n| x\\|y | 4 |\n\n```json\n{\n  \"ok\": true\n}\n```\n\n> done\n\n_(image: chart)_")
        #expect(Outputs.toMarkdown([]) == "")
        #expect(Outputs.toMarkdown(fnList("[{\"type\":\"button\",\"name\":\"b\",\"title\":\"Buy\",\"icon\":\"🛒\"},{\"type\":\"js\",\"code\":\"x\"}]")) == "[🛒 Buy]")
        #expect(Outputs.toMarkdown(fnList("[{\"type\":\"file\",\"name\":\"a.pdf\"},"
            + "{\"type\":\"audio\",\"title\":\"Song\"},{\"type\":\"video\"},{\"type\":\"form\",\"text\":\"Fill in\"},{\"type\":\"window\",\"id\":\"x\"}]"))
            == "_(file: a.pdf)_\n\n_(audio: Song)_\n\n_(video)_\n\n**Form**\nFill in")
        // Objects in cells are JSON, new lines are spaces, numbers as JavaScript writes them.
        #expect(Outputs.toMarkdown(fnList("[{\"type\":\"table\",\"columns\":[\"k\"],\"rows\":[[[1,\"a/b\"],\"x\\ny\",0.5,1e21]]}]"))
            == "| k |\n| --- |\n| [1,\"a/b\"] | x y | 0.5 | 1e+21 |")
    }

    @Test func checksEachTypeAndSaysWhy() {
        let b = Outputs.check(.object(fnObj("{\"type\":\"button\",\"name\":\"go\",\"title\":\"Go\",\"css\":\"primary evil-class primary\",\"style\":{\"color\":\" red \",\"background\":\"url(x)\"}}")))
        fnSame("{\"type\":\"button\",\"name\":\"go\",\"title\":\"Go\",\"css\":\"primary\",\"style\":{\"color\":\"red\"}}", b.output)
        #expect(Outputs.check(.object(fnObj("{\"type\":\"button\",\"title\":\"no name\"}"))).reason?.contains("needs a name") == true)
        #expect(Outputs.check(.object(fnObj("{\"type\":\"audio\",\"mime\":\"audio/wav\",\"data\":\"UklGRg==\"}"))).ok)
        #expect(!Outputs.check(.object(fnObj("{\"type\":\"audio\",\"mime\":\"text/html\",\"data\":\"AAAA\"}"))).ok)
        #expect(!Outputs.check(.object(fnObj("{\"type\":\"image\",\"mime\":\"image/png\\n\",\"data\":\"AAAA\"}"))).ok)
        #expect(!Outputs.check(.object(fnObj("{\"type\":\"image\",\"mime\":\"image/png\",\"data\":\"AA=A\"}"))).ok)
        #expect(!Outputs.check(.object(fnObj("{\"type\":\"js\",\"code\":\"\"}"))).ok)
        #expect(Outputs.check(.object(fnObj("{\"type\":\"nope\"}"))).reason == "unknown output type \"nope\"")
        #expect(Outputs.check(.object(fnObj("{\"type\":5}"))).reason == "unknown output type \"5\"")
        #expect(Outputs.check(.string("text")).reason == "not an object")
        fnSame("{\"type\":\"code\",\"text\":\"x\",\"lang\":\"\"}", Outputs.check(.object(fnObj("{\"type\":\"code\",\"text\":\"x\"}"))).output)
        fnSame("{\"type\":\"json\",\"value\":null}", Outputs.check(.object(fnObj("{\"type\":\"json\"}"))).output)
        fnSame("{\"type\":\"file\",\"name\":\"a_b_c\",\"mime\":\"text/plain\",\"data\":\"\"}",
               Outputs.check(.object(fnObj("{\"type\":\"file\",\"name\":\"a/b\\\\c\",\"mime\":\"text/plain\",\"data\":\"\"}"))).output)
        fnSame("{\"type\":\"window\",\"id\":\"files\",\"args\":null}", Outputs.check(.object(fnObj("{\"type\":\"window\",\"id\":\"files\"}"))).output)
        fnSame("{\"type\":\"js\",\"code\":\"x()\",\"height\":2000,\"hidden\":true}",
               Outputs.check(.object(fnObj("{\"type\":\"js\",\"code\":\"x()\",\"height\":\"9999\",\"hidden\":true}"))).output)
        fnSame("{\"type\":\"table\",\"columns\":[\"1\",\"null\"],\"rows\":[]}", Outputs.check(.object(fnObj("{\"type\":\"table\",\"columns\":[1,null],\"rows\":[]}"))).output)
        #expect(Outputs.check(.object(fnObj("{\"type\":\"table\",\"columns\":[],\"rows\":[1]}"))).reason == "table: columns and rows must be lists")

        let form = Outputs.check(.object(fnObj("{\"type\":\"form\",\"name\":\"f\",\"panels\":[{\"layout\":\"columns\",\"columns\":9,\"fields\":["
            + "{\"name\":\"a\",\"type\":\"masked\",\"mask\":\"000\"},{\"name\":\"bad name!\",\"type\":\"text\"},"
            + "{\"name\":\"s\",\"type\":\"multiselect\",\"options\":[\"x\",{\"value\":\"y\",\"label\":\"Y\",\"icon\":\"🍎\"}]}]}]}")))
        fnSame("{\"type\":\"form\",\"name\":\"f\",\"panels\":[{\"fields\":[{\"name\":\"a\",\"type\":\"masked\",\"mask\":\"000\"},"
            + "{\"name\":\"s\",\"type\":\"multiselect\",\"options\":[{\"value\":\"x\",\"label\":\"x\"},{\"value\":\"y\",\"label\":\"Y\",\"icon\":\"🍎\"}]}],"
            + "\"layout\":\"columns\",\"columns\":4}]}", form.output)
        fnSame("{\"type\":\"form\",\"name\":\"form\",\"fields\":[{\"name\":\"\",\"type\":\"static\",\"text\":\"hi\"},{\"name\":\"n\",\"type\":\"number\",\"min\":2,\"step\":0.5,\"default\":null,\"required\":true}]}",
               Outputs.check(.object(fnObj("{\"type\":\"form\",\"fields\":[{\"type\":\"static\",\"text\":\"hi\"},{\"name\":\"n\",\"type\":\"number\",\"min\":\"2\",\"step\":0.5,\"default\":null,\"required\":true},{\"name\":\"n\"}]}"))).output)
        #expect(Outputs.check(.object(fnObj("{\"type\":\"form\",\"fields\":[]}"))).reason == "form: a form needs fields (or panels with fields)")
    }

    @Test func formValuesAndMasks() {
        let spec = fnObj("{\"name\":\"f\",\"fields\":[{\"name\":\"e\",\"type\":\"email\",\"required\":true},{\"name\":\"n\",\"type\":\"number\",\"min\":2},{\"name\":\"p\",\"type\":\"masked\",\"mask\":\"000 000\"}]}")
        let p0 = Outputs.checkFormValues(spec, fnObj("{\"e\":\"\",\"n\":1,\"p\":\"12\"}"))
        #expect(p0.dictionary == ["e": "required", "n": "min 2", "p": "incomplete"])
        #expect(p0.names == ["e", "n", "p"])
        #expect(Outputs.checkFormValues(spec, fnObj("{\"e\":\"a@b.cz\",\"n\":3,\"p\":\"123 456\"}")).isEmpty)
        #expect(Outputs.checkFormValues(spec, fnObj("{\"e\":\"a b@c.cz\"}"))["e"] == "email")
        #expect(Outputs.checkFormValues(spec, fnObj("{\"e\":\"a@b.cz\",\"n\":\"abc\"}"))["n"] == "number")
        let more = fnObj("{\"name\":\"g\",\"panels\":[{\"fields\":[{\"name\":\"ok\",\"type\":\"switch\",\"required\":true},"
            + "{\"name\":\"code\",\"type\":\"text\",\"pattern\":\"^[A-Z]{2}$\"},{\"name\":\"tags\",\"type\":\"multiselect\",\"required\":true},{\"name\":\"r\",\"type\":\"range\",\"max\":10}]}]}")
        let p = Outputs.checkFormValues(more, fnObj("{\"ok\":false,\"code\":\"abc\",\"tags\":[],\"r\":11}"))
        #expect(p["ok"] == "required")
        #expect(p["code"] == "pattern")
        #expect(p["tags"] == "required")
        #expect(p["r"] == "max 10")
        #expect(Outputs.checkFormValues(more, fnObj("{\"ok\":true,\"code\":\"CZ\",\"tags\":[\"a\"],\"r\":\"10\"}")).isEmpty)

        #expect(Outputs.applyMask("+{420} 000 000 000", "777123456") == "+420 777 123 456")
        #expect(Outputs.applyMask("+{420} 000 000 000", "+420 777 123 456") == "+420 777 123 456")
        #expect(Outputs.applyMask("+\\4\\2\\0 000", "123") == "+420 123")
        #expect(Outputs.applyMask("aa-0000", "ab1234") == "ab-1234")
        #expect(Outputs.maskPlaceholder("+{420} 000 000 000") == "+420 ___ ___ ___")
        #expect(Outputs.maskTokens("+{420} 000 000 000").count == 16)
    }

    @Test func aRoomMessageCarriesWhatFits() {
        let big = JSONObject([("type", "image"), ("mime", "image/png"), ("data", .string(String(repeating: "A", count: 800_000)))])
        let shared = Outputs.shareable([.object(fnObj("{\"type\":\"text\",\"text\":\"hi\"}")), .object(big)])
        #expect(shared.count == 2)
        fnSame("{\"type\":\"text\",\"text\":\"(image — too large to share in the room)\"}", shared[1])
        // Sizes are JSON.stringify's: "/" is not escaped (org.json on Android would write "\/").
        let data = String(repeating: "/", count: 699_950)
        let slashes = JSONObject([("type", "image"), ("mime", "image/png"), ("data", .string(data))])
        #expect(Js.stringify(.object(slashes)).utf16.count == data.utf16.count + "{\"type\":\"image\",\"mime\":\"image/png\",\"data\":\"\"}".utf16.count)
        #expect(Outputs.shareable([.object(slashes)])[0]["type"] == "image")
    }

    @Test func peersOutputsAreCheckedAgain() {
        fnSame("[{\"type\":\"text\",\"text\":\"ok\"},{\"type\":\"flash\",\"text\":\"x\",\"level\":\"info\"}]",
               Outputs.sanitize(.array(fnList("[{\"type\":\"text\",\"text\":\"ok\"},{\"type\":\"js\",\"code\":5},{\"type\":\"flash\",\"text\":\"x\",\"level\":\"boom\"}]"))))
        #expect(Outputs.sanitize(.object(JSONObject())).isEmpty)
        let many = (0..<60).map { JSON.object(JSONObject([("type", "text"), ("text", .string("t\($0)"))])) }
        #expect(Outputs.sanitize(.array(many)).count == 50)
        // The total budget: what does not fit ends the list.
        let two = fnList("[{\"type\":\"text\",\"text\":\"aaaa\"},{\"type\":\"text\",\"text\":\"bbbb\"}]")
        #expect(Outputs.sanitize(.array(two), maxTotal: "{\"type\":\"text\",\"text\":\"aaaa\"}".utf16.count + 5).count == 1)
    }

    @Test func buttonColours() {
        #expect(CssColor.parse("red") == 0xFFFF_0000)
        #expect(CssColor.parse("#123") == 0xFF11_2233)
        #expect(CssColor.parse("#11223380") == 0x8011_2233)
        #expect(CssColor.parse("rgb(10, 20, 30)") == 0xFF0A_141E)
        #expect(CssColor.parse("rgba(100%,0,0,0.5)") == 0x80FF_0000)
        #expect(CssColor.parse("hsl(120deg, 100%, 50%)") == 0xFF00_FF00)
        #expect(CssColor.parse("rebeccapurplish") == nil)
        #expect(CssColor.parse("#12345") == nil)
        // (beyond the Android test) a number that passes the pattern but is none, and the transparent name
        #expect(CssColor.parse("rgb(1.2.3, 0, 0)") == nil)
        #expect(CssColor.parse(" Transparent ") == 0)
    }

    /// (beyond the Android test) JavaScript's String() and Number() as the ports rely on them.
    @Test func javaScriptSemantics() {
        #expect(Js.str(nil) == "undefined")
        #expect(Js.str(.null) == "null")
        #expect(Js.str(.array([1, .null, "a"])) == "1,,a")
        #expect(Js.str(.object(JSONObject())) == "[object Object]")
        #expect(Js.toNumber(.string(" 0x10 ")) == 16)
        #expect(Js.toNumber(.string("0b101")) == 5)
        #expect(Js.toNumber(.string("0o17")) == 15)
        #expect(Js.toNumber(.string("1.")) == 1)
        #expect(Js.toNumber(.string(".5e1")) == 5)
        #expect(Js.toNumber(.string("")) == 0)
        #expect(Js.toNumber(.string("1e")).isNaN)
        #expect(Js.toNumber(.string("0x")).isNaN)
        #expect(Js.toNumber(.string("0x" + String(repeating: "f", count: 20))) == 1.2089258196146292e24)
        #expect(Js.toNumber(.bool(true)) == 1)
        #expect(Js.toNumber(nil).isNaN)
        #expect(Js.stringify(.array([1, .object(JSONObject([("a", "b")]))]), indent: 2) == "[\n  1,\n  {\n    \"a\": \"b\"\n  }\n]")
        #expect(Js.trim("\u{FEFF}\u{A0} x \u{2028}") == "x")
        #expect(Js.cut("a😀", 2) == "a\u{FFFD}")
        #expect(Js.lowerRoot("\u{039F}\u{0394}\u{039F}\u{03A3}") == "\u{03BF}\u{03B4}\u{03BF}\u{03C2}")
    }
}
