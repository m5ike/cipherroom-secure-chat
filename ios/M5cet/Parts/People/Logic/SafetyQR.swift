// The QR code of a safety number, as the web's user info shows and scans it
// (client/src/components/UserInfoModal.tsx): "M5CET-SN:1:" and the 60 digits. The
// number is the same on both sides (Platform/Contacts Safety.number sorts the keys),
// so each person shows their code and scans the other's; a scanned code matches
// when its whole text is the one shown here. Drawn with CoreImage (error correction
// M, as the web's uqr), read back with CoreImage's detector in the tests.

import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation
import UIKit

enum SafetyQR {
    /// What the QR code of a safety number says before its digits.
    static let prefix = "M5CET-SN:1:"

    /// The QR payload of a number ("" without one: not twelve groups of five digits).
    static func payload(_ number: String?) -> String {
        let digits = (number ?? "").filter { $0.isASCII && $0.isNumber }
        return digits.count == 60 ? prefix + digits : ""
    }

    /// The digits a scanned code carries (nil: not a safety number's code).
    static func digits(_ scanned: String) -> String? {
        let t = scanned.trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.hasPrefix(prefix) else { return nil }
        let digits = String(t.dropFirst(prefix.count))
        return digits.count == 60 && digits.allSatisfy({ $0.isASCII && $0.isNumber }) ? digits : nil
    }

    /// A scanned code against the number shown here — the web compares the whole text.
    static func matches(_ scanned: String, number: String?) -> Bool {
        let mine = payload(number)
        return !mine.isEmpty && scanned.trimmingCharacters(in: .whitespacesAndNewlines) == mine
    }

    /// The code as an image, sharp pixels (nil for an empty text).
    static func image(_ text: String, scale: CGFloat = 8) -> UIImage? {
        guard !text.isEmpty else { return nil }
        let f = CIFilter.qrCodeGenerator()
        f.message = Data(text.utf8)
        f.correctionLevel = "M"
        guard let out = f.outputImage?.transformed(by: CGAffineTransform(scaleX: scale, y: scale)),
              let cg = CIContext().createCGImage(out, from: out.extent) else { return nil }
        return UIImage(cgImage: cg)
    }

    /// What a QR image says (CoreImage's detector).
    static func read(_ image: UIImage) -> String? {
        guard let ci = CIImage(image: image),
              let d = CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh]) else { return nil }
        return d.features(in: ci).compactMap { ($0 as? CIQRCodeFeature)?.messageString }.first
    }
}
