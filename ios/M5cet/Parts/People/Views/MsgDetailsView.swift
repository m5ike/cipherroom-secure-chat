// The message details (android/…/ui/parts/MsgDetails.java, 6.2): a dialog from the
// bottom with everything this device knows of a message — MsgDetailsModel's rows,
// kinds, timeline, receipts per recipient, the attachment's actions (open, save,
// share, forward: the chat part's msg.* actions), hiding it for a while and
// deleting it from this device — both logged for the operator's audit, never the
// text. It follows the message while open (a receipt arriving shows at once) and
// closes when the message is deleted. A SecureDialog (in the app's window).

import M5Core
import M5Design
import M5Proto
import SwiftUI

struct MsgDetailsView: View {
    let room: any RoomModel
    let messageId: String
    let hides: any DetailsHiding
    /// The clock (tests and screenshots fix it).
    var now: () -> Int64 = { Millis.now }
    var timeZone: TimeZone?

    @Environment(DesignHost.self) private var host
    @Environment(\.peopleClose) private var close
    @State private var gone = false

    var body: some View {
        let ctx = host.renderContext()
        let fg = ctx.swiftColor("@onSurface", .black), muted = ctx.swiftColor("@muted", .gray)
        let primary = ctx.swiftColor("@primary", .blue), danger = ctx.swiftColor("@danger", .red)
        let m = room.message(messageId)
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text(verbatim: host.peopleText("msg.info"))
                        .font(.system(size: 19, weight: .bold))
                        .foregroundStyle(fg)
                        .accessibilityAddTraits(.isHeader)
                    Spacer(minLength: 8)
                    Button { close() } label: { DesignIcon(name: "x", size: 22, color: fg).frame(width: 44, height: 44) }
                        .accessibilityLabel(Text(verbatim: host.peopleText("nav.close")))
                        .accessibilityIdentifier("msginfo.close")
                }
                if let m, !m.deleted {
                    details(m, fg: fg, muted: muted, primary: primary, danger: danger)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 12)
            .padding(.bottom, 20)
            .frame(maxWidth: 640)
            .frame(maxWidth: .infinity)
        }
        .background(ctx.swiftColor("@surface", .white).ignoresSafeArea())
        .onChange(of: m == nil || m?.deleted == true) { _, missing in if missing && !gone { gone = true; close() } }
    }

    @ViewBuilder
    private func details(_ m: ChatMessage, fg: Color, muted: Color, primary: Color, danger: Color) -> some View {
        let t: (String) -> String = { host.peopleText($0) }
        let at = now()
        let c = MsgDetailsModel.content(m, roomLabel: room.label, peerName: { room.peerName($0) },
                                        forwardVerified: (room as? any PeopleRoomExtras)?.forwardVerified(m) ?? false,
                                        hidden: hides.hidden(m, now: at), t: t, lang: host.services.lang, now: at, tz: timeZone)
        ForEach(Array(c.rows.enumerated()), id: \.offset) { _, r in line(r, fg: fg, muted: muted) }
        if !c.kinds.isEmpty {
            section(t("msginfo.kinds"), primary)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(Array(c.kinds.enumerated()), id: \.offset) { _, k in
                        Text(verbatim: k)
                            .font(.system(size: 12.5))
                            .foregroundStyle(fg)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 4)
                            .background(primary.opacity(0.12), in: Capsule())
                    }
                }
            }
        }
        section(t("msginfo.audit"), primary)
        ForEach(Array(c.timeline.enumerated()), id: \.offset) { _, st in
            HStack(spacing: 0) {
                DesignIcon(name: st.icon, size: 16, color: primary).frame(width: 24, height: 20)
                Text(verbatim: st.label)
                    .font(.system(size: 14))
                    .foregroundStyle(fg)
                    .padding(.horizontal, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                Text(verbatim: st.time).font(.system(size: 12.5)).foregroundStyle(muted)
            }
            .padding(.vertical, 4)
            .accessibilityElement(children: .combine)
        }
        if !c.receipts.isEmpty {
            section(t("msginfo.receipts"), primary)
            ForEach(Array(c.receipts.enumerated()), id: \.offset) { _, r in line(r, fg: fg, muted: muted) }
        }
        if let a = c.attachment {
            section(t("msginfo.attachment"), primary)
            line(a, fg: fg, muted: muted)
            if c.attachmentReady {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        PeoplePill(icon: "external-link", label: t("file.open"), color: primary) { fileAction("msg.open", m) }
                        PeoplePill(icon: "download", label: t("file.save"), color: primary) { fileAction("msg.save", m) }
                        PeoplePill(icon: "share-2", label: t("file.share"), color: primary) { fileAction("msg.share", m) }
                        PeoplePill(icon: "forward", label: t("msg.forward"), color: primary) { fileAction("msg.forward", m) }
                    }
                    .padding(.top, 6)
                }
            }
        }
        if c.canHide {
            section(t("msginfo.hideTitle"), primary)
            if c.hidden {
                PeoplePill(icon: "eye", label: t("msginfo.unhide"), color: primary) {
                    hides.unhide(room, m)
                    close()
                }
                .padding(.top, 4)
                .accessibilityIdentifier("msginfo.unhide")
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(Array(DetailsHides.names.enumerated()), id: \.offset) { i, name in
                            PeoplePill(icon: i == DetailsHides.names.count - 1 ? "log-in" : "eye-off", label: t("msginfo.hide." + name), color: primary) {
                                hides.hide(room, m, choice: i)
                                host.flash(title: "", text: t("msginfo.hiddenFlash"), level: .info)
                                close()
                            }
                            .accessibilityIdentifier("msginfo.hide." + name)
                        }
                    }
                    .padding(.top, 4)
                }
            }
            PeoplePill(icon: "trash", label: t("msginfo.delete"), color: danger) { askDelete(m) }
                .padding(.top, 12)
                .accessibilityIdentifier("msginfo.delete")
            Text(verbatim: t("msginfo.auditNote"))
                .font(.system(size: 12))
                .foregroundStyle(muted)
                .padding(.top, 10)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func section(_ title: String, _ color: Color) -> some View {
        Text(verbatim: title)
            .font(.system(size: 13, weight: .bold))
            .foregroundStyle(color)
            .padding(.top, 16)
            .padding(.bottom, 4)
            .accessibilityAddTraits(.isHeader)
    }

    /// A line: the label (muted, fixed width), the value (selectable), an optional detail under it.
    private func line(_ r: MsgDetailsContent.Row, fg: Color, muted: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            Text(verbatim: r.label).font(.system(size: 13.5)).foregroundStyle(muted).frame(width: 118, alignment: .leading)
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: r.value).font(.system(size: 14)).foregroundStyle(fg).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                if !r.detail.isEmpty { Text(verbatim: r.detail).font(.system(size: 12.5)).foregroundStyle(muted) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
    }

    /// The attachment's actions are the chat part's (msg.open / save / share / forward): the dialog goes first.
    private func fileAction(_ action: String, _ m: ChatMessage) {
        close()
        let host = host, id = m.id
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(350))
            _ = host.runner.runFromApp(action, value: .string(id))
        }
    }

    private func askDelete(_ m: ChatMessage) {
        let t: (String) -> String = { host.peopleText($0) }
        let room = room, hides = hides, host = host, close = close
        SecureDialog.alert(host: host, title: t("msginfo.delete"), message: t("msginfo.deleteAsk"), actions: [
            .init(label: t("msginfo.deleteYes"), role: .destructive) {
                gone = true
                hides.delete(room, m)
                host.flash(title: "", text: t("msginfo.deleted"), level: .success)
                close()
            },
            .init(label: t("msginfo.cancel"), role: .cancel),
        ])
    }
}
