// What the app puts into a screen's scope (android/…/ui/MainActivity.scopeFor):
// every screen sees $app, $form, $settings, $define and $account; each screen
// its own state ($lock, $rooms, $room, $msg, $call, $log…), which the app's
// state providers build (server/android/design.ts SCREENS lists them).

import Foundation

public enum ScreenScope {
    /// screen id → its group and the variables the console documents for it (server SCREENS `vars`).
    public static let screens: [(id: String, group: String, vars: [String])] = [
        ("splash", "system", ["app", "status", "busy"]),
        ("lock", "system", ["app", "lock"]),
        ("enroll", "system", ["app", "enroll"]),
        ("rooms", "app", ["app", "rooms", "selectedCount", "connectedCount", "unreadTotal"]),
        ("rooms.item", "parts", ["room"]),
        ("join", "app", ["form", "error"]),
        ("room", "room", ["room", "rooms", "me", "users", "call"]),
        ("message.in", "parts", ["msg"]),
        ("message.out", "parts", ["msg"]),
        ("message.sys", "parts", ["msg"]),
        ("users", "room", ["users", "count", "dock", "autoHide"]),
        ("users.item", "parts", ["user"]),
        ("users.handle", "parts", ["count", "edge", "open"]),
        ("settings", "app", ["app", "settings"]),
        ("call", "room", ["call", "room"]),
        ("update", "system", ["update"]),
        ("about", "app", ["app", "device", "server"]),
        ("flash", "parts", ["flash"]),
        ("tools", "app", ["tools", "settings"]),
        ("attach", "room", ["composer", "settings"]),
        ("send.options", "room", ["composer", "settings"]),
        ("dictate.options", "room", ["settings", "voices"]),
        ("call.options", "room", ["settings", "call"]),
        ("settings.user", "app", ["account", "keys", "connection"]),
        ("settings.messages", "app", ["settings"]),
        ("settings.voice", "app", ["settings", "voices"]),
        ("settings.location", "app", ["settings", "location"]),
        ("settings.calls", "app", ["settings"]),
        ("settings.appearance", "app", ["settings", "presets"]),
        ("settings.security", "app", ["security", "settings"]),
        ("ai", "app", ["ai"]),
        ("voice", "app", ["voice", "settings", "voices"]),
        ("nfc", "app", ["nfc", "room"]),
        ("users.person", "parts", ["form.person", "settings"]),
        ("settings.people", "app", ["settings"]),
        ("nfc.builder", "app", []),
        ("settings.notify", "app", ["settings", "notify", "account"]),
        ("settings.voiceFx", "app", ["settings", "voiceFx"]),
        ("room.edit", "app", ["form"]),
        ("settings.profile", "app", ["profile", "form", "account"]),
        ("log", "app", ["log", "form", "settings"]),
        ("message.sender", "parts", ["form.sender"]),
        ("message.forward", "parts", ["form.forward"]),
        ("message.model", "parts", ["form.model"]),
    ]

    /// $app: the design's name, the app's version and code, the design's version.
    public static func app(design: Design, version: String, code: Int) -> DesignValue {
        ["name": .string(design.appName), "version": .string(version), "code": .number(Double(code)), "bundle": .string(design.version)]
    }

    /// The scope of a screen: the common variables, then the screen's own (`own` wins).
    /// 6.7 (audit S14): the lock and enrolment screens never see $form.
    public static func scope(screen: String, app: DesignValue, form: [String: DesignValue], settings: SettingsModel,
                             define: DesignValue = .object([:]), account: DesignValue = .object([:]), own: [String: DesignValue] = [:]) -> Scope {
        var vars: [String: DesignValue] = [
            "app": app,
            "form": screen == "lock" || screen == "enroll" ? .object([:]) : .object(form),
            "settings": settings.scope(),
            "define": define,
            "account": account,
        ]
        for (k, v) in own { vars[k] = v }
        return Scope(vars)
    }

    /// MainActivity.roomScope: a room as the room, call and NFC screens see it (an empty one when none is active).
    public static func room(key: String?, name: String = "", users: Int = 0, unread: Int = 0, status: String = "offline", connected: Bool = false,
                            notice: String = "", active: Bool = false) -> DesignValue {
        guard let key else {
            return ["key": "", "name": "", "users": 0, "unread": 0, "status": "offline", "connected": false]
        }
        return ["key": .string(key), "name": .string(name), "users": .number(Double(users)), "unread": .number(Double(unread)), "status": .string(status),
                "connected": .bool(connected), "notice": .string(notice), "active": .bool(active)]
    }
}
