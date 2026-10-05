// Ports of android/app/src/test/java/cz/m5cet/app/voice/VoiceFxTest.java and FxGateTest.java — the
// voice changer on the phone: the same presets, ranges, defaults and operator gate as the web and
// Android (test/fixtures/voice-fx.json — test/voice-fx.test.ts and the JVM tests read the same file),
// and the chain on synthetic signals: pitch moves a sine by the ratio, robot gives the sidebands, echo
// repeats, the limiter holds, idle is a pure delay, 16-bit PCM in place, a call's 10 ms buffers.

import XCTest
import M5Core
@testable import M5cet

enum RepoFiles {
    /// The repository's root (this file is ios/M5cetTests/Voice/…).
    static let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent()

    static func json(_ relative: String) throws -> JSONObject {
        let data = try Data(contentsOf: root.appendingPathComponent(relative))
        guard let o = try JSON.parse(Bytes(data)).objectValue else { throw CocoaError(.fileReadCorruptFile) }
        return o
    }
}

final class VoiceFxTests: XCTestCase {
    private static let fix: JSONObject = (try? RepoFiles.json("test/fixtures/voice-fx.json")) ?? JSONObject()

    private func sine(_ rate: Int, _ hz: Double, _ seconds: Double, _ amp: Double) -> [Double] {
        (0..<Int((Double(rate) * seconds).rounded())).map { amp * sin(2 * Double.pi * hz * Double($0) / Double(rate)) }
    }

    /// Magnitudes (Hann) of n = the largest power of two ≤ len, from `from`.
    private func mags(_ x: [Double], _ from: Int, _ len: Int) -> [Double] {
        var n = 1
        while n * 2 <= len { n *= 2 }
        var re = (0..<n).map { x[from + $0] * (0.5 - 0.5 * cos(2 * Double.pi * Double($0) / Double(n))) }
        var im = [Double](repeating: 0, count: n)
        VoiceFx.Fft(n).transform(&re, &im, inverse: false)
        return (0..<n / 2).map { hypot(re[$0], im[$0]) }
    }

    private func peakHz(_ x: [Double], _ rate: Int, _ from: Int, _ len: Int) -> Double {
        let m = mags(x, from, len)
        var best = 1
        for k in 1..<m.count where m[k] > m[best] { best = k }
        return Double(best) * Double(rate) / Double(m.count * 2)
    }

    private func levelAt(_ x: [Double], _ rate: Int, _ hz: Double, _ from: Int, _ len: Int) -> Double {
        let m = mags(x, from, len)
        let k = Int((hz * Double(m.count * 2) / Double(rate)).rounded())
        return max(m[k - 1], max(m[k], m[k + 1]))
    }

    private func params(_ o: JSONObject) -> VoiceFx.Params {
        var p = VoiceFx.neutralParams
        for k in VoiceFx.keys { if let v = o.double(k) { p = p.with(k, v) } }
        return p
    }

    private func run(_ p: VoiceFx.Params, _ x: [Double], _ rate: Int) -> [Double] {
        var out = x
        VoiceFx(sampleRate: rate, params: p).process(&out)
        return out
    }

    private func rms(_ x: [Double], _ a: Int, _ b: Int) -> Double {
        var s = 0.0
        for i in a..<b { s += x[i] * x[i] }
        return (s / Double(b - a)).squareRoot()
    }

    func testThePresetsAreTheWebs() throws {
        let fix = Self.fix
        XCTAssertFalse(fix.isEmpty, "test/fixtures/voice-fx.json")
        XCTAssertEqual(fix.array("presetIds")?.compactMap(\.stringValue), VoiceFx.presetIds)
        let presets = try XCTUnwrap(fix.object("presets"))
        XCTAssertEqual(presets.count, VoiceFx.presets.count)
        XCTAssertEqual(presets.keys, VoiceFx.presets.map(\.0)) // the same order
        for (id, p) in presets {
            let mine = try XCTUnwrap(VoiceFx.preset(id))
            for k in VoiceFx.keys { XCTAssertEqual(p[k]?.doubleValue, mine.get(k), "\(id) \(k)") }
        }
        XCTAssertEqual(fix.array("keys")?.compactMap(\.stringValue), VoiceFx.keys)
        let limits = try XCTUnwrap(fix.object("limits"))
        for k in VoiceFx.keys {
            let l = try XCTUnwrap(VoiceFx.limits(k))
            XCTAssertEqual(limits[k]?[0]?.doubleValue, l.0, k)
            XCTAssertEqual(limits[k]?[1]?.doubleValue, l.1, k)
        }
        for f in fix.array("frames") ?? [] {
            XCTAssertEqual(f["size"]?.int64Value.map(Int.init), VoiceFx.frameSize(for: Int(f["rate"]?.int64Value ?? 0)))
        }
    }

    func testTheDefaultsAreTheWebs() throws {
        var d = [String: JSON]()
        for (k, v) in MicFx.defaults { d[k] = v }
        let def = try XCTUnwrap(Self.fix.object("defaults"))
        XCTAssertEqual(def["on"], d["voiceFx.on"])
        XCTAssertEqual(def["preset"], d["voiceFx.preset"])
        let custom = try XCTUnwrap(def.object("custom"))
        for k in VoiceFx.keys { XCTAssertEqual(custom[k]?.doubleValue, d["voiceFx." + k]?.doubleValue, k) }
        // The settings' parameters: a preset, or the custom values.
        XCTAssertEqual(-7, MicFx.fromSettings { d[$0] }.pitch)
        d["voiceFx.preset"] = "custom"
        XCTAssertEqual(-5, MicFx.fromSettings { d[$0] }.pitch)
        XCTAssertEqual(-3, MicFx.fromSettings { d[$0] }.formant)
    }

    func testClampsWhatComesIn() {
        let p = VoiceFx.Params(pitch: 40, formant: -99, robot: 5, echo: 2, echoMs: 5, echoFeedback: 3, whisper: -1, gain: 99)
        XCTAssertEqual(12, p.pitch)
        XCTAssertEqual(-12, p.formant)
        XCTAssertEqual(0, p.robot) // under 20 Hz is off
        XCTAssertEqual(1, p.echo)
        XCTAssertEqual(40, p.echoMs)
        XCTAssertEqual(0.9, p.echoFeedback)
        XCTAssertEqual(0, p.whisper)
        XCTAssertEqual(12, p.gain)
        XCTAssertTrue(VoiceFx.preset("off")!.neutral)
        XCTAssertFalse(VoiceFx.preset("echo")!.neutral)
        XCTAssertEqual(VoiceFx.neutralParams, VoiceFx.paramsFor("custom", custom: nil))
    }

    func testFftRoundTrip() {
        let n = 256
        let x = (0..<n).map { sin(Double($0) * 0.3) + 0.2 * cos(Double($0) * 1.7) }
        var re = x, im = [Double](repeating: 0, count: n)
        let f = VoiceFx.Fft(n)
        f.transform(&re, &im, inverse: false)
        f.transform(&re, &im, inverse: true)
        for i in 0..<n { XCTAssertEqual(x[i], re[i] / Double(n), accuracy: 1e-9) }
    }

    func testIdleIsAPureDelay() {
        for rate in [48_000, 16_000] {
            let x = sine(rate, 440, 0.3, 0.5)
            let out = run(VoiceFx.neutralParams, x, rate)
            let d = VoiceFx(sampleRate: rate, params: VoiceFx.neutralParams).latency
            XCTAssertEqual(VoiceFx.frameSize(for: rate), d)
            for i in stride(from: d, to: x.count, by: 97) { XCTAssertEqual(x[i - d], out[i], accuracy: 1e-12) }
            for i in 0..<d { XCTAssertEqual(0, out[i]) }
        }
    }

    func testPitchMovesASineByTheRatio() throws {
        let sines = try XCTUnwrap(Self.fix.array("sines"))
        for case let .object(c) in sines {
            let rate = Int(c.int64("rate") ?? 0)
            let x = sine(rate, c.double("hz") ?? 0, 1, 0.5)
            let out = run(params(c.object("params") ?? JSONObject()), x, rate)
            let found = peakHz(out, rate, Int(Double(rate) * 0.3), Int(Double(rate) * 0.6))
            let want = c.double("peakHz") ?? 0
            XCTAssertLessThan(abs(found - want) / want, 0.03, "\(c.stringify()) → \(found)")
            let ratio = rms(out, rate / 2, rate) / rms(x, rate / 2, rate)
            XCTAssertTrue(ratio > 0.6 && ratio < 1.5, "loudness \(ratio)")
        }
    }

    func testRobotGivesTheSidebandsNotTheTone() throws {
        let rings = try XCTUnwrap(Self.fix.array("rings"))
        for case let .object(c) in rings {
            let rate = Int(c.int64("rate") ?? 0)
            let hz = c.double("hz") ?? 0
            let out = run(VoiceFx.neutralParams.with("robot", c.double("robot") ?? 0), sine(rate, hz, 1, 0.5), rate)
            let side = c.array("sidebands") ?? []
            let s = min(levelAt(out, rate, side[0].doubleValue!, rate / 4, rate / 2), levelAt(out, rate, side[1].doubleValue!, rate / 4, rate / 2))
            XCTAssertGreaterThan(s, 20 * levelAt(out, rate, hz, rate / 4, rate / 2), c.stringify())
        }
    }

    func testEchoRepeatsWithTheFeedback() {
        var e = VoiceFx.makeEcho(rate: 1000)
        e.set(mix: 0.5, ms: 100, feedback: 0.4)
        let out = (0..<400).map { e.next($0 == 0 ? 1 : 0) }
        XCTAssertEqual(1, out[0])
        XCTAssertEqual(0.5, out[100], accuracy: 1e-12)
        XCTAssertEqual(0.2, out[200], accuracy: 1e-12)
        XCTAssertEqual(0.08, out[300], accuracy: 1e-12)
        for i in 1..<out.count where i % 100 != 0 { XCTAssertEqual(0, out[i]) }
    }

    func testTheLimiterHolds() {
        XCTAssertEqual(0.5, VoiceFx.softLimit(0.5))
        XCTAssertEqual(-0.8, VoiceFx.softLimit(-0.8))
        for v in [0.9, 1.5, 10, -3] {
            XCTAssertLessThanOrEqual(abs(VoiceFx.softLimit(v)), 1)
            XCTAssertGreaterThan(abs(VoiceFx.softLimit(v)), 0.8)
        }
        let out = run(VoiceFx.neutralParams.with("gain", 12), sine(16_000, 300, 0.5, 0.9), 16_000)
        for v in out { XCTAssertLessThanOrEqual(abs(v), 1) }
    }

    func testWhisperIsTheSameNoiseForTheSameSeedAndAboutAsLoud() {
        let rate = 16_000
        var x = sine(rate, 300, 1, 0.5)
        for h in 2..<12 { let y = sine(rate, 300 * Double(h), 1, 0.5 / Double(h)); for i in x.indices { x[i] += y[i] } }
        let w = VoiceFx.preset("whisper")!
        let a = run(w, x, rate), b = run(w, x, rate)
        XCTAssertEqual(a, b)
        let ratio = rms(a, rate / 2, rate) / rms(x, rate / 2, rate)
        XCTAssertTrue(ratio > 0.4 && ratio < 2.5, "whisper loudness \(ratio)")
        var n = VoiceFx.Noise(7), m = VoiceFx.Noise(7)
        for _ in 0..<5 { XCTAssertEqual(n.next(), m.next()) }
    }

    func testTheNoiseIsXorshift32AsTheWebs() {
        // voice-fx.ts makeNoise(1): s ^= s << 13; s ^= s >>> 17; s ^= s << 5 (uint32) / 2^32.
        var n = VoiceFx.Noise(1)
        XCTAssertEqual(270369.0 / 4294967296.0, n.next())
        XCTAssertEqual(67634689.0 / 4294967296.0, n.next())
    }

    func testSixteenBitPcmInPlaceAndStereoStaysStereo() {
        let rate = 16_000
        var pcm = [Int16](repeating: 0, count: rate * 2)
        for f in 0..<rate { let v = Int16(8000 * sin(2 * Double.pi * 300 * Double(f) / Double(rate))); pcm[f * 2] = v; pcm[f * 2 + 1] = v }
        let fx = VoiceFx(sampleRate: rate, params: VoiceFx.preset("deep"))
        fx.process(&pcm, frames: rate, channels: 2)
        var differ = 0
        for f in 0..<rate { XCTAssertEqual(pcm[f * 2], pcm[f * 2 + 1]); if pcm[f * 2] != 0 { differ += 1 } }
        XCTAssertGreaterThan(differ, rate / 2)
    }

    func testACallBufferChangesInPlace() {
        let rate = 48_000, frames = 480
        MicFx.use(VoiceFx.preset("robot")!)
        defer { MicFx.use(VoiceFx.neutralParams) }
        let s = MicFx.Stream(rate: rate)
        var buf = [Int16](repeating: 0, count: frames)
        var before = [Int16](), after = [Int16]()
        for block in 0..<20 {
            for i in 0..<frames { buf[i] = Int16(8000 * sin(2 * Double.pi * 440 * Double(block * frames + i) / Double(rate))) }
            if block == 19 { before = buf }
            s.process(&buf, frames: frames, channels: 1)
            if block == 19 { after = buf }
        }
        XCTAssertGreaterThan(s.latency, 0)
        XCTAssertNotEqual(before, after)
    }

    func testAStreamNeverOnTouchesNothing() {
        MicFx.use(VoiceFx.neutralParams)
        let s = MicFx.Stream(rate: 16_000)
        var pcm: [Int16] = [1, 2, 3, -4, 5]
        s.process(&pcm, frames: pcm.count, channels: 1)
        XCTAssertEqual([1, 2, 3, -4, 5], pcm)
        XCTAssertEqual(0, s.latency)
    }

    func testTheSwitchAndTheGateBothDecide() {
        let settings: (String) -> JSON? = { ["voiceFx.preset": "robot"][$0] }
        MicFx.recompute(switchOn: true, gateAllows: false, settings: settings)
        XCTAssertFalse(MicFx.active)
        MicFx.recompute(switchOn: false, gateAllows: true, settings: settings)
        XCTAssertFalse(MicFx.active)
        let v = MicFx.version
        MicFx.recompute(switchOn: true, gateAllows: true, settings: settings)
        XCTAssertTrue(MicFx.active)
        XCTAssertEqual(v + 1, MicFx.version)
        MicFx.recompute(switchOn: true, gateAllows: true, settings: settings)
        XCTAssertEqual(v + 1, MicFx.version) // the same parameters: no new version
        MicFx.use(VoiceFx.neutralParams)
    }
}

final class FxGateTests: XCTestCase {
    func testDecidesLikeTheWeb() throws {
        let fix = try RepoFiles.json("test/fixtures/voice-fx.json")
        let cases = try XCTUnwrap(fix.array("gate"))
        XCTAssertFalse(cases.isEmpty)
        for case let .object(c) in cases {
            var modules = JSONObject()
            if let rule = c.object("rule") { modules[FxGate.module] = .object(rule) }
            let groups = (c.array("groups") ?? []).compactMap(\.stringValue)
            XCTAssertEqual(c.bool("allowed"), FxGate.allowed(modules: modules, id: FxGate.module, groups: groups), c.optString("about"))
        }
    }

    func testARuleAsTheServerSanitisesIt() {
        let user = ["user"]
        // enabled is anything but false; the access words fall back like sanitizeModules.
        XCTAssertTrue(FxGate.allowed(modules: JSONObject([(FxGate.module, .object(JSONObject()))]), id: FxGate.module, groups: user))
        XCTAssertFalse(FxGate.allowed(modules: JSONObject([(FxGate.module, .object(JSONObject([("enabled", false)])))]), id: FxGate.module, groups: user))
        XCTAssertFalse(FxGate.allowed(modules: JSONObject([(FxGate.module, .object(JSONObject([("groups", ["staff"])])))]), id: FxGate.module, groups: user))
        XCTAssertFalse(FxGate.allowed(modules: nil, id: FxGate.module, groups: user))
    }

    func testTheUsersGroups() {
        XCTAssertEqual(["guest"], FxGate.groups(signedIn: false, accountGroups: ["staff"]))
        XCTAssertEqual(["user"], FxGate.groups(signedIn: true, accountGroups: []))
        XCTAssertEqual(["staff"], FxGate.groups(signedIn: true, accountGroups: ["staff"]))
    }
}
