// ui/media/Previews (6.2): previews of an attachment in its bubble — the first
// lines of a text, the first page of a PDF, a video's first frame. Everything is
// read from memory (ChatVaultMedia) and kept in memory (ChatState): PDFKit opens
// the bytes as they are, no file descriptor and no temporary file is needed.

import AVFoundation
import Foundation
import M5Proto
import PDFKit
import UIKit

enum MediaPreviews {
    enum Kind { case image, audio, video, pdf, text, other }

    private static let textExt: Set<String> = ["txt", "md", "markdown", "csv", "tsv", "json", "log", "xml", "yaml", "yml", "ini", "conf"]

    static func type(_ m: ChatMessage) -> Kind {
        let mime = (m.fileMime ?? "").lowercased()
        let name = (m.fileName ?? "").lowercased()
        let ext = name.contains(".") ? String(name[name.index(after: name.lastIndex(of: ".")!)...]) : ""
        if m.fileImage { return .image }
        if mime.hasPrefix("audio/") { return .audio }
        if mime.hasPrefix("video/") { return .video }
        if mime == "application/pdf" || ext == "pdf" { return .pdf }
        if mime.hasPrefix("text/") || mime == "application/json" || mime == "application/xml" { return .text }
        if textExt.contains(ext) { return .text }
        return .other
    }

    /// The icon of a type (the footer, a file without a preview).
    static func icon(_ t: Kind) -> String {
        switch t {
        case .image: return "file-image"
        case .audio: return "file-headphone"
        case .video: return "file-play"
        case .pdf, .text: return "file-text"
        case .other: return "file"
        }
    }

    // MARK: text

    /// The first lines of a text file (at most 8 KB read, each line at most 160 characters); nil when unreadable.
    static func textHead(_ bytes: Data, lines: Int) -> String? {
        let head = bytes.prefix(8 * 1024)
        let full = head.count == 8 * 1024
        let all = String(decoding: head, as: UTF8.self).replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var out = [String]()
        for (i, raw) in all.enumerated() where out.count < lines {
            if i == all.count - 1 && full { break } // cut in the middle
            var line = raw.replacingOccurrences(of: "\t", with: " ")
            if out.isEmpty && line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
            if line.utf16.count > 160 { line = String(utf16CodeUnits: Array(line.utf16.prefix(160)), count: 160) + "…" }
            out.append(line)
        }
        return out.joined(separator: "\n")
    }

    // MARK: PDF

    /// The first page as a picture (at most maxWidth px wide, at most 3× as tall), and how many pages there are;
    /// nil when it cannot be drawn (damaged, password-protected, over 40 MB).
    static func pdfFirstPage(_ bytes: Data, maxWidth: CGFloat) -> (image: UIImage, pages: Int)? {
        if bytes.count > 40 << 20 { return nil }
        guard let doc = PDFDocument(data: bytes), !doc.isLocked, doc.pageCount > 0, let page = doc.page(at: 0) else { return nil }
        let box = page.bounds(for: .mediaBox)
        let s = min(3, maxWidth / max(1, box.width))
        var size = CGSize(width: max(1, (box.width * s).rounded()), height: max(1, (box.height * s).rounded()))
        if size.height > size.width * 3 { size.height = size.width * 3 }
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: size, format: format).image { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
            ctx.cgContext.translateBy(x: 0, y: box.height * s)
            ctx.cgContext.scaleBy(x: s, y: -s)
            ctx.cgContext.translateBy(x: -box.minX, y: -box.minY)
            page.draw(with: .mediaBox, to: ctx.cgContext)
        }
        return (image, doc.pageCount)
    }

    // MARK: video

    /// A video's first frame, its size (rotation applied) and length; nil when it is not a playable video.
    static func videoFrame(_ asset: AVAsset, maxPx: CGFloat) async -> (image: UIImage?, width: Int, height: Int, durationMs: Int64)? {
        do {
            let duration = try await asset.load(.duration)
            let tracks = try await asset.loadTracks(withMediaType: .video)
            var w = 0, h = 0
            if let t = tracks.first {
                let (natural, transform) = try await t.load(.naturalSize, .preferredTransform)
                let r = CGRect(origin: .zero, size: natural).applying(transform)
                w = Int(abs(r.width).rounded()); h = Int(abs(r.height).rounded())
            }
            let gen = AVAssetImageGenerator(asset: asset)
            gen.appliesPreferredTrackTransform = true
            gen.maximumSize = CGSize(width: maxPx, height: maxPx)
            let frame = try? await gen.image(at: .zero).image
            let image = frame.map { UIImage(cgImage: $0) }
            if (w <= 0 || h <= 0), let f = frame { w = f.width; h = f.height }
            let ms = duration.isNumeric ? Int64((duration.seconds * 1000).rounded()) : 0
            return (image, w, h, ms)
        } catch {
            return nil
        }
    }
}
