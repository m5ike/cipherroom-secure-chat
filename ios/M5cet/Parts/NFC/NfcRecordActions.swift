// What an opened record of an M5Cet card does on the screen — Android
// NfcWorkbench.actOnRecord / saveRecord / showText: a server room is joined, a
// link opened (through the design's url.open, which asks first), Wi-Fi and a
// website login shown with "Copy password", a contact offered to Contacts, the
// account's records handed to the vault (not on iOS yet — the hand-off text),
// a message shown with Copy.
//
// iOS: there is no public way to open the Wi-Fi settings, so the Wi-Fi record
// offers Copy password and Close (Android also had "Wi-Fi settings").

import Contacts
import ContactsUI
import M5Design
import UIKit

@MainActor
enum NfcRecordActions {
    static func perform(_ outcome: NfcRecordOutcome, words: NfcWords, host: DesignHost?) {
        switch outcome {
        case .join(let room, let pass, let name):
            NfcJoin.finish(room: room, passphrase: pass, name: name, host: host)
        case .url(let url):
            if !url.isEmpty { _ = host?.runner.runFromApp("url.open", value: .string(url)) }
        case .wifi(let ssid, let password):
            var text = words("nfc.rec.wifi") + "\nSSID: " + ssid
            if !password.isEmpty { text += "\n" + words("nfc.wifi.pw") + ": " + password }
            NfcPresenter.alert(title: words("nfc.rec.wifi"), message: text,
                               buttons: password.isEmpty ? [] : [NfcAlertButton(words("msg.copy")) { host?.copy(password) }], close: words("nav.close"))
        case .contact(let name, let tel, let email, let org):
            let c = CNMutableContact()
            if !name.isEmpty {
                let parts = name.split(separator: " ", maxSplits: 1).map(String.init)
                c.givenName = parts.first ?? name
                if parts.count > 1 { c.familyName = parts[1] }
            }
            if !tel.isEmpty { c.phoneNumbers = [CNLabeledValue(label: CNLabelPhoneNumberMobile, value: CNPhoneNumber(stringValue: tel))] }
            if !email.isEmpty { c.emailAddresses = [CNLabeledValue(label: CNLabelHome, value: email as NSString)] }
            if !org.isEmpty { c.organizationName = org }
            guard let top = NfcPresenter.top() else { host?.flash(title: "", text: words("file.noApp"), level: .warn); return }
            let vc = CNContactViewController(forNewContact: c)
            let closer = NfcContactCloser()
            vc.delegate = closer
            objc_setAssociatedObject(vc, &NfcContactCloser.key, closer, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
            top.present(UINavigationController(rootViewController: vc), animated: true)
        case .urlLogin(let url, let user, let password):
            NfcPresenter.alert(title: words("nfc.rec.urlLogin"), message: url + "\n" + user, buttons: [
                NfcAlertButton(words("nfc.rec.open")) { _ = host?.runner.runFromApp("url.open", value: .string(url)) },
                NfcAlertButton(words("nfc.login.copyPw")) { host?.copy(password) },
            ], close: words("nav.close"))
        case .handoff(let title):
            host?.flash(title: "", text: words("nfc.rec.handoff"), level: .info)
            text(title, words("nfc.rec.handoff"), words: words, host: host)
        case .text(let title, let body):
            text(title, body, words: words, host: host)
        }
    }

    /// A record's text with Copy (Android showText).
    static func text(_ title: String, _ body: String, words: NfcWords, host: DesignHost?) {
        NfcPresenter.alert(title: title, message: body, buttons: [NfcAlertButton(words("msg.copy")) { host?.copy(body) }], close: words("nav.close"))
    }
}

/// Closes the new-contact screen when the person saved or cancelled it.
final class NfcContactCloser: NSObject, CNContactViewControllerDelegate {
    nonisolated(unsafe) static var key: UInt8 = 0

    func contactViewController(_ viewController: CNContactViewController, didCompleteWith contact: CNContact?) {
        MainActor.assumeIsolated { viewController.navigationController?.dismiss(animated: true) }
    }
}
