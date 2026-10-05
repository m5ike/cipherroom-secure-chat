// DEBUG only: the tools in the renderer's sample mode (`-M5Screen …`) never
// touch a network — the engine talks to ToolsPreviewTransport, which answers
// like the server's routes did when the test fixtures were made
// (ios/M5cetTests/Tools/fixtures). For screenshots, `-M5Tools <demo>` plays one:
//
//   -M5Screen ai   -M5Tools ai    a question to the assistant and its streamed Markdown answer
//   -M5Screen room -M5Tools fn    /report example.org (progress, then the model's HTML report) and a
//                                 second run still working (dots, progress bar, what it does) — drawn by a
//                                 sample message list until the chat's own one shows these (FnMessageContent)
//   -M5Screen voice -M5Tools voice a dictated transcript on the voice pad
//
// Compiled out of Release.

#if DEBUG
import Foundation
import M5Core
import M5Design
import M5Proto
import SwiftUI

@MainActor
enum ToolsDebug {
    /// The demo asked for (-M5Tools), nil without one.
    static var mode: String? { UserDefaults.standard.string(forKey: "M5Tools").flatMap { $0.isEmpty ? nil : $0 } }
    /// The renderer's sample mode: no network for the tools.
    static var sample: Bool { DebugLaunch.screen != nil }

    private static var played: Set<String> = []

    /// Once per launch.
    static func once(_ demo: String) -> Bool { played.insert(demo).inserted }

    static func install(_ slots: SlotRegistry) {
        guard sample, let mode else { return }
        if mode == "fn" {
            // Now (before the sample mode's own list), and again after the other parts' installs (a later registration wins).
            slots.register("messages") { _ in AnyView(FnSampleThread()) }
            DispatchQueue.main.async { slots.register("messages") { _ in AnyView(FnSampleThread()) } }
        }
    }

    /// -M5Tools ai: a question, the answer streamed in.
    static func aiDemo(_ model: AiChatModel) {
        guard sample, mode == "ai", once("ai") else { return }
        Task { @MainActor in
            for _ in 0..<50 where ToolParts.assistant.status == nil { try? await Task.sleep(for: .milliseconds(100)) }
            model.input = "Shrň mi prosím, co umí /report."
            model.send()
        }
    }

    /// -M5Tools fn: a finished report and a run still working, in the active room.
    static func fnDemo(_ host: DesignHost) {
        guard sample, mode == "fn", once("fn"), let engine = ToolParts.engine, let room = CoreModels.shared.rooms.active else { return }
        Task { @MainActor in
            engine.load()
            for _ in 0..<50 where engine.commands().state(bearer: engine.bearerCache).enabled != true { try? await Task.sleep(for: .milliseconds(100)) }
            _ = engine.run(room: room, text: "/report example.org", host: host)
            try? await Task.sleep(for: .milliseconds(1800))
            _ = engine.run(room: room, text: "/report slow.example", host: host)
        }
    }

    /// -M5Tools voice: words on the pad.
    static func voiceDemo(_ pad: VoicePadModel) {
        guard sample, mode == "voice", once("voice") else { return }
        pad.transcript = "Ahoj, dorazím kolem šesté. Vezmu s sebou klíče od chaty a mapu."
    }
}

/// The server's answers as the fixtures captured them (the commands, a report, the assistant).
struct ToolsPreviewTransport: FnTransport {
    func open(_ request: FnRequest) async throws -> FnOpened {
        let path = request.url.path
        let body = request.body.flatMap { String(data: $0, encoding: .utf8) }.flatMap { (try? JSON.parse($0))?.objectValue }
        switch path {
        case "/api/client-config":
            return Self.json(##"{"ok":true,"config":{"composer":{"triggers":[{"char":"/","action":"functions"},{"char":"@","action":"mentions"},{"char":"#","action":"tags"}],"tags":[]}}}"##)
        case "/api/functions/commands":
            return Self.json(##"{"ok":true,"enabled":true,"commands":[{"keyword":"ask","name":"Asker","summary":"","runtime":"server","visibility":"caller","mine":true,"inputs":[],"events":[],"model":"tools-ask","icon":"🙋","usage":""},{"keyword":"check","name":"Checker","summary":"","runtime":"server","visibility":"caller","mine":true,"inputs":[{"name":"n","type":"integer","label":"Count","help":"how many","required":true,"min":1,"max":10}],"events":[],"model":"tools-check","icon":"shield-check","usage":""},{"keyword":"report","name":"Domain report","summary":"A domain's DNS and TLS.","runtime":"server","visibility":"caller","mine":true,"inputs":[{"name":"host","type":"hostname","required":true}],"events":["button"],"model":"tools-report","icon":"file-text","usage":"/report example.org"}]}"##)
        case "/api/functions/run":
            let host = body?.object("inputs")?.optString("host") ?? "example.org"
            return host == "slow.example" ? Self.slowRun() : Self.reportRun(host)
        case "/api/ai/status":
            return Self.json(##"{"ok":true,"enabled":true,"state":"ready","models":[{"ref":"local-ai/assistant","label":"Assistant","provider":"Local AI","reasoning":false,"vision":false}],"default":"local-ai/assistant","limits":{"maxOutputTokens":2048,"maxInputChars":24000}}"##)
        case "/api/ai/chat":
            return Self.aiAnswer()
        case "/api/speech/status":
            return Self.json(##"{"ok":true,"tts":{"enabled":false,"connectors":[]},"stt":{"enabled":false,"connectors":[]}}"##)
        default:
            return Self.json(##"{"ok":false,"code":"no-command","message":"No such command, or it is not available to you."}"##, status: 404)
        }
    }

    private static func json(_ s: String, status: Int = 200) -> FnOpened {
        FnOpened(head: FnHead(status: status, contentType: "application/json"), body: AsyncThrowingStream { c in c.yield(Data(s.utf8)); c.finish() })
    }

    /// Events, one every `gapMs`; `hold` keeps the stream alive afterwards (a progress every 5 s).
    private static func events(_ list: [(String, String)], gapMs: Int, hold: (String, String)? = nil) -> FnOpened {
        let (stream, c) = AsyncThrowingStream<Data, any Error>.makeStream()
        let feeder = Task {
            for (name, data) in list {
                try? await Task.sleep(for: .milliseconds(gapMs))
                if Task.isCancelled { return }
                c.yield(Data("event: \(name)\ndata: \(data)\n\n".utf8))
            }
            if let hold {
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(5))
                    c.yield(Data("event: \(hold.0)\ndata: \(hold.1)\n\n".utf8))
                }
                return
            }
            c.finish()
        }
        c.onTermination = { _ in feeder.cancel() }
        return FnOpened(head: FnHead(status: 200, contentType: "text/event-stream"), body: stream)
    }

    private static func reportRun(_ host: String) -> FnOpened {
        let html = "<div class=\\\"m5h-head\\\"><div class=\\\"m5h-title\\\">\(host)</div><div class=\\\"m5h-sub\\\">DNS · TLS · mail</div></div>"
            + "<table class=\\\"m5h-kv\\\"><tr><th>A</th><td>93.184.216.34</td></tr><tr><th>AAAA</th><td>2606:2800:21f:cb07::1</td></tr>"
            + "<tr><th>TLS</th><td><span class=\\\"m5h-badge m5h-badge--ok\\\">valid · 74 days</span></td></tr>"
            + "<tr><th>SPF</th><td><span class=\\\"m5h-badge m5h-badge--warn\\\">soft fail</span></td></tr></table>"
            + "<details class=\\\"m5h-sec\\\" open><summary>MX</summary><ul class=\\\"m5h-files\\\"><li>10 mail.\(host)</li><li>20 backup.\(host)</li></ul></details>"
            + "<p class=\\\"m5h-muted\\\">More: <a href=\\\"https://\(host)/\\\">\(host)</a></p>"
        let done = ##"{"ok":true,"runId":"run_preview_1","status":"done","outputs":[{"type":"html","html":"\##(html)","title":"Domain report"},{"type":"button","name":"again","title":"Again","data":{"host":"\##(host)"},"css":"primary"},{"type":"button","name":"mail","title":"Mail only","css":"outline"}],"error":null,"ms":812,"visibility":"caller","chain":"chn_preview0001","call":0,"model":"tools-report","keyword":"report","name":"Domain report","icon":"file-text","events":["button"]}"##
        return events([("start", ##"{"runId":"run_preview_1","keyword":"report","name":"Domain report","icon":"file-text","visibility":"caller"}"##),
                       ("progress", ##"{"runId":"run_preview_1","type":"progress","p":0.3,"text":"Looking up DNS…"}"##),
                       ("progress", ##"{"runId":"run_preview_1","type":"progress","p":0.7,"text":"Checking TLS…"}"##),
                       ("done", done)], gapMs: 300)
    }

    private static func slowRun() -> FnOpened {
        let tls = ##"{"runId":"run_preview_2","type":"progress","p":0.62,"text":"Checking TLS on slow.example…"}"##
        return events([("start", ##"{"runId":"run_preview_2","keyword":"report","name":"Domain report","icon":"file-text","visibility":"caller"}"##),
                       ("progress", ##"{"runId":"run_preview_2","type":"progress","p":0.3,"text":"Looking up DNS…"}"##),
                       ("progress", tls)], gapMs: 300, hold: ("progress", tls))
    }

    private static func aiAnswer() -> FnOpened {
        let pieces = ["/report", " zkontroluje", " doménu:\n\n", "- **DNS** — záznamy A, AAAA", " a MX\n", "- **TLS** — platnost", " certifikátu\n",
                      "- **pošta** — SPF", " a DKIM\n\n", "Napiš třeba `/report example.org`."]
        var list = pieces.map { ("delta", "{\"text\":\(JSON.string($0).stringify())}") }
        list.append(("done", "{\"text\":\(JSON.string(pieces.joined()).stringify()),\"model\":\"assistant\",\"ref\":\"local-ai/assistant\",\"usage\":{\"input\":12,\"output\":48},\"ms\":900}"))
        return events(list, gapMs: 120)
    }
}

/// The room's messages with the functions' bubbles (until the chat's own list draws FnMessageContent).
struct FnSampleThread: View {
    @Environment(DesignHost.self) private var host

    var body: some View {
        let look = ToolsLook(host: host)
        let room = CoreModels.shared.rooms.active
        let messages = Array((room?.messages ?? []).suffix(6))
        ScrollViewReader { proxy in
            ScrollView(.vertical) {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(messages, id: \.id) { m in row(m, look).id(m.id) }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(.horizontal, 12).padding(.vertical, 10)
            }
            .onChange(of: messages.map(\.id)) { _, _ in proxy.scrollTo("end", anchor: .bottom) }
        }
        .task { ToolsDebug.fnDemo(host) }
    }

    @ViewBuilder
    private func row(_ m: ChatMessage, _ look: ToolsLook) -> some View {
        if m.kind == "sys" {
            Text(verbatim: m.text).toolsFont(12).foregroundStyle(look.color("@muted")).frame(maxWidth: .infinity)
        } else if let id = FnModelFace.of(m) {
            HStack(alignment: .top, spacing: 8) {
                ZStack {
                    Circle().fill(DesignColor(argb: id.argb).color)
                    if id.lucide { DesignIcon(name: FnModelFace.glyph(id, has: FnModelFace.appHas), size: 18, color: .white) } else { Text(verbatim: id.icon) }
                }
                .frame(width: 36, height: 36)
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: id.name).toolsFont(13, weight: .bold).foregroundStyle(look.color("@primary"))
                    FnMessageContent(message: m, ink: look.color("@onBubbleIn"))
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(RoundedRectangle(cornerRadius: 16).fill(look.color("@bubbleIn")))
            }
            .padding(.trailing, 16)
        } else if m.mine {
            HStack {
                Spacer(minLength: 48)
                Group {
                    if FnMessageContent.handles(m) { FnMessageContent(message: m, ink: look.color("@onBubbleOut"), accent: look.color("@onBubbleOut")) }
                    else { Text(verbatim: m.visibleText).toolsFont(15.5).foregroundStyle(look.color("@onBubbleOut")) }
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(RoundedRectangle(cornerRadius: 16).fill(look.color("@bubbleOut")))
            }
        } else {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: m.senderName).toolsFont(12, weight: .bold).foregroundStyle(look.color("@primary"))
                Text(verbatim: m.visibleText).toolsFont(15.5).foregroundStyle(look.color("@onBubbleIn"))
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 16).fill(look.color("@bubbleIn")))
            .padding(.trailing, 48)
        }
    }
}
#endif
