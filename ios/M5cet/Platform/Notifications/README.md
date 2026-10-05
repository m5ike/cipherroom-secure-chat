# Platform/Notifications — upozornění, konverzace, zámek

Port `A/telecom/{Notify, Conversations, ConversationPlan, ReplyReceiver, LockScreen}` a textů `A/push/NotifyTemplate`
(`A/` = `android/app/src/main/java/cz/m5cet/app/`).

| Android | iOS |
|---|---|
| `Notify` (kanály, upozornění zpráv a hovorů, `neutralizeAll`) | UserNotifications: `UNUserNotificationCenter` (delegát, kategorie, `threadIdentifier` = místnost), oprávnění k upozorněním |
| `ReplyReceiver` (odpověď z upozornění) | akce `UNTextInputNotificationAction` |
| `Conversations`, `ConversationPlan` (místnosti jako konverzace, zkratky) | Communication Notifications (`INSendMessageIntent`, entitlement `com.apple.developer.usernotifications.communication` — přidat s funkcí) |
| `LockScreen` (co zůstane mimo zamčenou obrazovku) | `UNNotificationContent.interruptionLevel`, náhledy; neutrální text při zámku aplikace (G-22) |
| zapečetěný obsah push zprávy | **`ios/M5cetNotifications`** (Notification Service Extension): dešifrování nebo neutrální text („Nová zpráva“, `Localizable.xcstrings`) |

Rozšíření sdílí s aplikací App Group `$(M5_APP_GROUP)` a skupinu Keychainu (stav zámku, klíče pro zapečetěné zprávy).
Instalace delegáta při startu: `App/Bootstrap.swift`.
