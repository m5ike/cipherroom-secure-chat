// What the NFC screens hand out: a template's output and a card's report as
// files that live in memory only (Android VaultMedia.memoryUri — "never written
// to the disk"), through the system share sheet (Save to Files included), and
// the pictures of a document decoded for the screen.
//
// The report is M5NFC's CardReport (the web's card-report.ts — html, json, csv,
// text, the card's own files); card numbers and track data are masked unless the
// person turned the full data on (G-19).

import Foundation
import ImageIO
import M5NFC
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// A file in memory for the share sheet (ShareLink / UIActivityViewController).
struct NfcExportFile: Transferable, Equatable, Identifiable, Sendable {
    let name: String
    let mime: String
    let data: Data
    /// The report's format ("html", "json", "csv", "text"); "" for a file of the card.
    var format = ""
    var id: String { name }

    var type: UTType { UTType(mimeType: mime) ?? (name.hasSuffix(".jp2") ? UTType("public.jpeg-2000") ?? .data : .data) }

    static var transferRepresentation: some TransferRepresentation {
        DataRepresentation(exportedContentType: .json) { $0.data }.exportingCondition { $0.type == .json }.suggestedFileName { $0.name }
        DataRepresentation(exportedContentType: .html) { $0.data }.exportingCondition { $0.type == .html }.suggestedFileName { $0.name }
        DataRepresentation(exportedContentType: .commaSeparatedText) { $0.data }.exportingCondition { $0.type == .commaSeparatedText }.suggestedFileName { $0.name }
        DataRepresentation(exportedContentType: .plainText) { $0.data }.exportingCondition { $0.type == .plainText }.suggestedFileName { $0.name }
        DataRepresentation(exportedContentType: .jpeg) { $0.data }.exportingCondition { $0.type == .jpeg }.suggestedFileName { $0.name }
        DataRepresentation(exportedContentType: .png) { $0.data }.exportingCondition { $0.type == .png }.suggestedFileName { $0.name }
        DataRepresentation(exportedContentType: .data) { $0.data }
            .exportingCondition { ![UTType.json, .html, .commaSeparatedText, .plainText, .jpeg, .png].contains($0.type) }
            .suggestedFileName { $0.name }
    }
}

/// CardReport as files (the web's CardReportView.exportAs: html, json, csv, text, and every attachment).
enum NfcReportExport {
    static let formats = ["html", "json", "csv", "text"]

    /// "e-id" / "emv" / "card" — the report's base name.
    static func base(_ input: NfcJSON) -> String {
        let r = CardReport.report(input, format: "json")
        return r.kind == "mrtd" ? "e-id" : r.kind == "emv" ? "emv" : "card"
    }

    static func file(_ input: NfcJSON, format: String, lang: String, fullPan: Bool) -> NfcExportFile {
        let o = CardReport.Options(fullPan: fullPan, lang: lang)
        let b = base(input)
        if format == "html" {
            return NfcExportFile(name: b + "-report.html", mime: "text/html", data: Data(CardReport.document(input, options: o).utf8), format: format)
        }
        let r = CardReport.report(input, format: format, options: o)
        return NfcExportFile(name: b + "." + (format == "text" ? "txt" : format), mime: r.mime, data: Data(r.text.utf8), format: format)
    }

    /// The four formats, then the card's own files (EF.SOD, the data groups, the pictures).
    static func files(_ input: NfcJSON, lang: String, fullPan: Bool) -> [NfcExportFile] {
        var out = formats.map { file(input, format: $0, lang: lang, fullPan: fullPan) }
        let r = CardReport.report(input, format: "json", options: CardReport.Options(fullPan: fullPan, lang: lang))
        for f in r.files { if let d = Data(base64Encoded: f.data) { out.append(NfcExportFile(name: f.name, mime: f.mime.isEmpty ? "application/octet-stream" : f.mime, data: d)) } }
        return out
    }

    /// A format's button label: the design's word for JSON, the format's name for the others.
    static func label(_ format: String, words: NfcWords) -> String {
        switch format {
        case "json": return words("nfc.out.json")
        case "html": return words.or("nfc.report.html", "nfc.out.readable") + " · HTML"
        case "csv": return "CSV"
        default: return "TXT"
        }
    }
}

/// The pictures of a document (DG2 / DG5 / DG7, scans): JPEG, JPEG 2000 and PNG through ImageIO, at most 1600 px.
enum NfcImages {
    static func decode(base64: String, maxPixels: Int = 1600) -> UIImage? {
        guard let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters) else { return nil }
        return decode(data, maxPixels: maxPixels)
    }

    static func decode(_ data: Data, maxPixels: Int = 1600) -> UIImage? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(src) > 0 else { return nil }
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixels,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        return UIImage(cgImage: cg)
    }
}
