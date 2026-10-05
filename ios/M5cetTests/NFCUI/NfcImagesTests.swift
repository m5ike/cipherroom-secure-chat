// A document's pictures on the screen: JPEG, PNG and JPEG 2000 (many e-ID faces
// are — Android could not show them, ImageIO can), scaled to at most 1600 px; and
// the report's files carry their types for the share sheet.

import ImageIO
import M5NFC
import UIKit
import UniformTypeIdentifiers
import XCTest
@testable import M5cet

final class NfcImagesTests: XCTestCase {
    private func encoded(_ type: UTType, size: CGSize = CGSize(width: 60, height: 80)) throws -> Data {
        let image = UIGraphicsImageRenderer(size: size, format: { let f = UIGraphicsImageRendererFormat(); f.scale = 1; return f }()).image { ctx in
            UIColor.gray.setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
        }
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, type.identifier as CFString, 1, nil), let cg = image.cgImage else {
            throw XCTSkip("ImageIO cannot write \(type.identifier) here")
        }
        CGImageDestinationAddImage(dest, cg, nil)
        guard CGImageDestinationFinalize(dest) else { throw XCTSkip("ImageIO cannot write \(type.identifier) here") }
        return out as Data
    }

    func testJpegPngAndJpeg2000AreShown() throws {
        for type in [UTType.jpeg, .png] {
            let img = try XCTUnwrap(NfcImages.decode(base64: try encoded(type).base64EncodedString()), type.identifier)
            XCTAssertEqual(img.size, CGSize(width: 60, height: 80))
        }
        let jp2Type = try XCTUnwrap(UTType("public.jpeg-2000"))
        let jp2 = try encoded(jp2Type)
        XCTAssertEqual(Array(jp2.prefix(12)), [0x00, 0x00, 0x00, 0x0C, 0x6A, 0x50, 0x20, 0x20, 0x0D, 0x0A, 0x87, 0x0A], "a JP2 file")
        let img = try XCTUnwrap(NfcImages.decode(jp2), "JPEG 2000 through ImageIO")
        XCTAssertEqual(img.size, CGSize(width: 60, height: 80))
    }

    func testLargePicturesAreScaledAndBrokenOnesAreNot() throws {
        let big = try encoded(.jpeg, size: CGSize(width: 3200, height: 2400))
        let img = try XCTUnwrap(NfcImages.decode(big))
        XCTAssertEqual(max(img.size.width, img.size.height), 1600)
        XCTAssertNil(NfcImages.decode(base64: "AAAADGpQICANCocKAAAAFGZ0eXA="), "a cut JPEG 2000: the placeholder")
        XCTAssertNil(NfcImages.decode(base64: "not base64 !!"))
    }

    func testExportFilesKeepTheirTypes() {
        XCTAssertEqual(NfcExportFile(name: "e-id.json", mime: "application/json", data: Data()).type, .json)
        XCTAssertEqual(NfcExportFile(name: "e-id-report.html", mime: "text/html", data: Data()).type, .html)
        XCTAssertEqual(NfcExportFile(name: "e-id.csv", mime: "text/csv", data: Data()).type, .commaSeparatedText)
        XCTAssertEqual(NfcExportFile(name: "e-id.txt", mime: "text/plain", data: Data()).type, .plainText)
        XCTAssertEqual(NfcExportFile(name: "face.jp2", mime: "image/jp2", data: Data()).type, UTType("public.jpeg-2000"))
    }
}
