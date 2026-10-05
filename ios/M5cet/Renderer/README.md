# Renderer — vykreslování designu ve SwiftUI (vlna 2)

Port `A/ui/{Renderer, Ui, Icons, SvgPath, SystemBars}` a směrování obrazovek z `A/ui/MainActivity`
(`A/` = `android/app/src/main/java/cz/m5cet/app/`); model designu, `Expr`, akce a `ActionGuard` jsou v `M5Kit/M5Design`.

* Výchozí design je v balíčku aplikace: `Bundle.main.url(forResource: "default-design", withExtension: "json", subdirectory: "m5")`
  (také `icons.json`, `themes.json`) — kopíruje je build fáze „Copy design assets“ přímo z `android/app/src/main/assets/m5/`.
* Nahradí `App/RootView.swift` (zástupná obrazovka); odkazy `m5cet://` bere z `AppModel.pendingLink` / `AppModel.onLink`.
* iPad: všechny orientace, Split View, více oken (`WindowGroup`) — rozvržení podle `horizontalSizeClass`.
