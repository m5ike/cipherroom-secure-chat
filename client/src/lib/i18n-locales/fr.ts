// 6.13: the texts of this language — i18n/locales/fr/web*.json, bundled into
// this module's own chunk (loaded only when the language is chosen). A
// missing file is simply absent (the build passes before the translations
// exist); outside Vite (the server's tsx) import.meta.glob is not there and
// lib/i18n-load.ts reads the files from disk instead.
import { collectLocaleFiles } from "../i18n-locales";

export default collectLocaleFiles(() => import.meta.glob<Record<string, string>>("../../../../i18n/locales/fr/web*.json", { eager: true, import: "default" }));
