// MIFARE DESFire read helpers (6.3 / 6.10) — the read-only native commands of
// A/nfc/CardOps.java desfireApps and the decoders of TemplateViews.java's
// DESFire section: GetVersion (three frames), GetApplicationIDs, GetFreeMemory,
// GetKeySettings, each wrapped in ISO 7816 (90 cmd 00 00 00) and followed while
// the card answers 91AF. On iOS a DESFire card arrives as an NFCMiFareTag with
// mifareFamily .desfire and these APDUs go through sendMiFareISO7816Command
// (`NfcCapabilities.desfire`) — no AID is needed. Nothing here authenticates or writes.

import Foundation
import M5Core

public enum Desfire {
    /// The native read commands (G-18 allows exactly these: ApduTemplates.readOnlyCommands["desfire"]).
    public static let getVersion = 0x60, additionalFrame = 0xaf, getApplicationIds = 0x6a, getFreeMemory = 0x6e, getKeySettings = 0x45

    /// A native command wrapped in ISO 7816: 90 cmd 00 00 (Lc data) 00.
    public static func wrap(_ cmd: Int, _ data: [UInt8] = []) -> [UInt8] {
        data.isEmpty ? Bytes.u8(0x90, cmd, 0x00, 0x00, 0x00) : Bytes.u8(0x90, cmd, 0x00, 0x00, data.count) + data + [0x00]
    }

    /// Sends a native read command and follows 91AF frames; the joined data, and the last status word.
    /// Refuses anything that is not a read (G-18).
    public static func command(_ t: any ApduChannel, _ cmd: Int) async throws -> (data: [UInt8], sw: Int) {
        guard ApduTemplates.readCommand(0x90, cmd) else { throw NfcError(.notARead, "not a read command: 90 \(String(format: "%02X", cmd))") }
        var r = Apdu.split(try await t.transmit(wrap(cmd)))
        var data = r.data
        var frames = 0
        while r.sw == 0x91af && frames < 32 {
            r = Apdu.split(try await t.transmit(wrap(additionalFrame)))
            data += r.data
            frames += 1
        }
        return (data, r.sw)
    }

    /// GetVersion, decoded: the hardware frame (vendor, type, subtype, major, minor, storage, protocol),
    /// the software frame, and the production data (UID, batch, week / year).
    public struct Version: Sendable, Hashable {
        public let vendor: Int, type: Int, subtype: Int, major: Int, minor: Int, storage: Int, protocolType: Int
        public let swMajor: Int?, swMinor: Int?
        public let uid: [UInt8]?, batch: [UInt8]?, week: Int?, year: Int?

        /// From the joined GetVersion frames (7 + 7 + 14 bytes; fewer when the card stopped early).
        public init?(_ d: [UInt8]) {
            guard d.count >= 7 else { return nil }
            vendor = Int(d[0]); type = Int(d[1]); subtype = Int(d[2]); major = Int(d[3]); minor = Int(d[4]); storage = Int(d[5]); protocolType = Int(d[6])
            if d.count >= 14 { swMajor = Int(d[10]); swMinor = Int(d[11]) } else { swMajor = nil; swMinor = nil }
            if d.count >= 28 {
                uid = Array(d[14..<21]); batch = Array(d[21..<26]); week = Desfire.bcd(Int(d[26])); year = 2000 + Desfire.bcd(Int(d[27]))
            } else { uid = nil; batch = nil; week = nil; year = nil }
        }

        public var vendorName: String { vendor == 0x04 ? "NXP" : String(format: "%02X", vendor) }
        public var product: String { Desfire.product(type: type, major: major) }
        public var storageText: String { Desfire.storageText(storage) }

        public var json: NfcJSONObject {
            var o: NfcJSONObject = ["vendor": .string(vendorName), "product": .string(product), "hardware": .string("\(major).\(minor)"),
                                    "storage": .string(storageText), "protocol": .string(String(format: "%02X", protocolType))]
            if let a = swMajor, let b = swMinor { o["software"] = .string("\(a).\(b)") }
            if let u = uid { o["uid"] = .string(Hex.upper(u)) }
            if let b = batch { o["batch"] = .string(Hex.upper(b)) }
            if let w = week, let y = year, w > 0 || y > 2000 { o["produced"] = .string("\(y)-W\(w)") }
            return o
        }
    }

    static func bcd(_ b: Int) -> Int { ((b >> 4) & 0x0f) * 10 + (b & 0x0f) }

    static func bytesText(_ n: UInt64) -> String { n >= 1024 && n % 1024 == 0 ? "\(n / 1024) KB" : "\(n) B" }

    /// The storage byte: 2^n bytes, or between 2^n and 2^(n+1) when its lowest bit is set.
    public static func storageText(_ b: Int) -> String {
        let size: UInt64 = 1 << UInt64((b >> 1) & 0x3f)
        return b & 1 == 0 ? bytesText(size) : bytesText(size) + " – " + bytesText(size &* 2)
    }

    /// The DESFire generation by hardware type and major version (NXP AN12343 / AN12752).
    public static func product(type: Int, major: Int) -> String {
        if type == 0x08 { return "MIFARE DESFire Light" }
        if type == 0x01 {
            switch major {
            case 0x00: return "MIFARE DESFire (MF3ICD40)"
            case 0x01: return "MIFARE DESFire EV1"
            case 0x12: return "MIFARE DESFire EV2"
            case 0x22: return "MIFARE DESFire EV2 XL"
            case 0x33: return "MIFARE DESFire EV3"
            default: return "MIFARE DESFire"
            }
        }
        return String(format: "type %02X", type)
    }

    /// GetApplicationIDs → the AIDs, each 3 bytes little-endian, as hex ("123456").
    public static func applicationIds(_ d: [UInt8]) -> [String] {
        stride(from: 0, to: d.count - d.count % 3, by: 3).map { String(format: "%02X%02X%02X", d[$0 + 2], d[$0 + 1], d[$0]) }
    }

    /// GetFreeMemory → bytes (3 bytes little-endian), or nil.
    public static func freeMemory(_ d: [UInt8]) -> Int? { d.count >= 3 ? Int(d[0]) | Int(d[1]) << 8 | Int(d[2]) << 16 : nil }

    /// GetKeySettings of the PICC (or an application).
    public struct KeySettings: Sendable, Hashable {
        public let settings: Int, maxKeys: Int
        public init?(_ d: [UInt8]) { guard d.count >= 2 else { return nil }; settings = Int(d[0]); maxKeys = Int(d[1]) }
        public var keyCount: Int { maxKeys & 0x0f }
        public var crypto: String { (maxKeys & 0xc0) == 0x80 ? "AES" : (maxKeys & 0xc0) == 0x40 ? "3K3DES" : "DES / 2K3DES" }
        public var masterKeyChangeable: Bool { settings & 0x01 != 0 }
        public var freeDirectoryList: Bool { settings & 0x02 != 0 }
        public var freeCreateDelete: Bool { settings & 0x04 != 0 }
        public var configurationChangeable: Bool { settings & 0x08 != 0 }
    }

    /// The public information of a DESFire card (CardOps.desfireApps): its version and its applications,
    /// plus free memory and the PICC key settings when the card gives them without a key.
    public static func readInfo(_ t: any ApduChannel) async throws -> NfcJSONObject {
        var out = NfcJSONObject()
        let v = try await command(t, getVersion)
        if v.sw == 0x9100, let version = Version(v.data) { out["version"] = .object(version.json); out["versionHex"] = .string(Hex.upper(v.data)) }
        let a = try await command(t, getApplicationIds)
        out["applications"] = NfcJSON(a.sw >> 8 == 0x91 ? applicationIds(a.data) : [])
        let f = try await command(t, getFreeMemory)
        if f.sw == 0x9100, let free = freeMemory(f.data) { out["freeMemory"] = NfcJSON(free) }
        let k = try await command(t, getKeySettings)
        if k.sw == 0x9100, let ks = KeySettings(k.data) {
            out["keySettings"] = ["settings": .string(String(format: "%02X", ks.settings)), "keys": NfcJSON(ks.keyCount), "crypto": .string(ks.crypto)]
        }
        return out
    }
}
