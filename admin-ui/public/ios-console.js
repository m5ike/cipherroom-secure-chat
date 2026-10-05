// M5cet operator console — iOS (6.14).
//
// The iOS app's page, next to Android's, laid out the same: it IS the Android
// page's code (android-console.js, window.M5MobileConsole) on /api/admin/ios,
// with what differs on iOS here:
//
//   Overview   the fleet (iPhones, iPads, APNs tokens), the server's key — the
//              same key as Android's — and getting the app (App Store,
//              TestFlight, the enrolment QR code)
//   Devices    as Android's, with the iOS model, system and push columns
//   Push       a control message to every device; APNs (status of the key from
//              the environment, the switch, the environment, the topic) and a
//              test push with Apple's answer
//   Design     the same builder, its own design (the iOS look), iPhone and iPad
//              frames, a check of what iOS cannot do and of the build it makes
//   Define     the very same m5mobile.define set as Android › Define (shared)
//   Builds     as Android's (ibld_…, for iOS app builds from 61400)
//   Releases   version records: App Store / TestFlight link, notes per language,
//              minimum build, staged rollout — no binaries (Apple installs)
//   Security   the same lock policy; bundle id, minimum build, store links;
//              passkeys on iOS (apple-app-site-association) instead of assetlinks
//   Events     as Android's
//
// Same rules as console.js: DOM nodes and textContent, never innerHTML.

(() => {
  "use strict";
  const C = window.M5Console;
  const M = window.M5MobileConsole;
  const Kit = window.M5Kit;
  if (!C || !M) return;
  const { h, clear, api, toast } = C;
  const K = M.kit;
  const { badge, when, size, guarded, may, kpi } = K;

  const API = "/api/admin/ios";
  const LANGS = ["en", "cs", "de", "es", "it", "fr", "sk", "sl", "fi"];
  const idiomName = (i) => ({ phone: "iPhone", pad: "iPad", watch: "Apple Watch", mac: "Mac", vision: "Vision Pro", tv: "Apple TV" }[i] || i || "");
  const ov = () => M.overview();
  const field = (label, control) => h("label", { class: "field" }, h("span", { class: "label" }, label), control);

  /* ============================================================ overview */

  function overviewView(body) {
    const o = ov();
    const c = o.counts;
    body.append(h("div", { class: "grid grid--kpi" },
      kpi("Devices", c.active, `${c.devices} enrolled · ${c.wiped} wiped`),
      kpi("iPhone / iPad", `${c.phones} / ${c.pads}`, "active devices"),
      kpi("Seen in 24 h", c.seen24h, "checked in or answered"),
      kpi("Builds", c.builds, "design bundles"),
      kpi("Releases", c.releases, "App Store / TestFlight versions"),
      kpi("Push", o.apns.ready ? "APNs" : "polling", o.apns.ready ? `${c.apns} devices with a token · ${c.voip} VoIP` : o.apns.reason)));
    if (!o.store.persistent) body.append(h("div", { class: "card warn" }, h("strong", {}, "In memory only. "), o.store.reason));
    body.append(h("div", { class: "grid grid--2" },
      h("div", { class: "card", "data-testid": "ios-key" },
        h("div", { class: "card__head" }, h("div", { class: "card__title" }, "The server's key"), h("div", { class: "card__hint" }, "The same key as Android's: it signs every bundle, release record, policy and control message. Devices pin it when they enrol; compare the fingerprint with the one in the app (About).")),
        h("dl", { class: "kv" },
          h("dt", {}, "Key id"), h("dd", { class: "mono" }, o.signing.kid),
          h("dt", {}, "Fingerprint"), h("dd", { class: "mono" }, o.signing.fingerprint),
          h("dt", {}, "Server version"), h("dd", {}, `${o.app.version} (build ${o.app.versionCode})`),
          h("dt", {}, "Bundles for apps from"), h("dd", {}, `build ${o.app.minAppCode}`),
          h("dt", {}, "Oldest build allowed"), h("dd", {}, o.app.minBuild ? `build ${o.app.minBuild} — older apps must update` : "any"),
          h("dt", {}, "Design"), h("dd", {}, `${o.design.rev || "default"}${o.design.updatedAt ? ` · ${when(o.design.updatedAt)} · ${o.design.updatedBy}` : " (built-in iOS look)"}`),
          h("dt", {}, "Enrolment"), h("dd", {}, o.config.enrollment),
          h("dt", {}, "Storage"), h("dd", { class: "mono small" }, o.store.file))),
      getAppCard()));
  }

  function getAppCard() {
    const c = ov().config;
    const server = h("input", { class: "input", value: K.chatUrl(), placeholder: "https://chat.example.com", "data-read": "1" });
    const qr = h("div", { class: "and-qr" });
    const link = h("div", { class: "mono small muted" });
    const show = async () => {
      const res = await C.raw(`${API}/codes/qr?server=${encodeURIComponent(server.value.trim())}`);
      if (!res.ok) { toast("Enter the chat's address (https://…).", "err"); return; }
      clear(qr).append(K.svgNode(await res.text()));
      link.textContent = res.headers.get("X-M5-Link") || "";
    };
    const store = (label, url) => h("div", { class: "row" }, h("strong", {}, label), url ? h("a", { href: url, target: "_blank", rel: "noopener noreferrer", class: "mono small" }, url) : h("span", { class: "muted small" }, "not set (Security)"));
    return h("div", { class: "card", "data-testid": "ios-get-app" },
      h("div", { class: "card__head" }, h("div", { class: "card__title" }, "Getting the app"), h("div", { class: "card__hint" }, "Apple installs it: the App Store, or TestFlight for testers (build with Xcode from ios/ — docs/ios-architecture.md). On the device the app asks for the server — or scan this code with the camera.")),
      h("div", { class: "stack ios-kv-links" }, store("App Store", c.appStoreUrl), store("TestFlight", c.testFlightUrl)),
      h("label", { class: "field" }, h("span", { class: "label" }, "The chat's address"), server),
      h("div", { class: "row" }, h("button", { class: "btn btn--sm", type: "button", "data-read": "1", onclick: show }, "Enrolment QR code"), c.enrollment === "code" ? h("span", { class: "muted small" }, "Codes are required: make one in Security.") : null),
      qr, link);
  }

  /* ================================================================ push */

  async function pushView(body) {
    const o = ov();
    const a = o.apns;
    const cfg = o.config;
    body.append(h("div", { class: "card" },
      h("div", { class: "card__head" }, h("div", { class: "card__title" }, "A control message to every active device"), h("div", { class: "card__hint" }, "Encrypted for each device and signed by the server. Over APNs when it is set up — flash, push, lock and wipe as alerts the Notification Service Extension opens (Apple sees only a neutral text), the rest as silent background pushes iOS delivers when it suits the battery — otherwise at the next check-in.")),
      may("push") ? K.commandForm(async (kind, payload) => {
        const r = await guarded(() => api(`${API}/commands`, { method: "POST", body: { kind, payload } }));
        if (r) toast(`${r.results.length} devices: ${r.results.filter((x) => x.via === "apns").length} over APNs, the rest at check-in.`, "ok");
      }, false) : h("div", { class: "muted small" }, "Your access does not include control messages.")));

    const enabled = h("input", { type: "checkbox", "data-testid": "apns-enabled" });
    enabled.checked = cfg.apns.enabled;
    const env = h("select", { class: "input input--sm", "data-testid": "apns-env" }, ...[["", "from APNS_ENV"], ["production", "production"], ["sandbox", "sandbox (development builds)"]].map(([v, l]) => h("option", { value: v }, l)));
    env.value = cfg.apns.env;
    const topic = h("input", { class: "input input--sm mono", value: cfg.apns.topic, placeholder: a.topic || cfg.bundleId, "data-testid": "apns-topic" });
    const test = h("select", { class: "input input--sm", "data-testid": "apns-test-device" });
    const kind = h("select", { class: "input input--sm" }, h("option", { value: "background" }, "silent (ping)"), h("option", { value: "alert" }, "visible (flash)"));
    const result = h("div", { class: "ios-result", "data-testid": "apns-test-result" });
    const devs = await guarded(() => api(`${API}/devices?status=active`));
    for (const d of devs?.devices || []) test.append(h("option", { value: d.id }, `${d.name} (${d.push}${d.voip ? " + VoIP" : ""})`));
    body.append(h("div", { class: "card", "data-testid": "apns-card" },
      h("div", { class: "card__head" }, h("div", { class: "card__title" }, "Apple Push Notification service"), h("div", { class: "card__hint" }, `Status: ${a.ready ? "ready" : a.reason}. The key (.p8) never comes here: APNS_KEY_FILE, APNS_KEY_ID and APNS_TEAM_ID are set in the server's environment (docs/ios-server.md). A device built for development reports the sandbox and is sent there.`)),
      h("dl", { class: "kv" },
        h("dt", {}, "Environment"), h("dd", {}, a.env || "—"), h("dt", {}, "Topic"), h("dd", { class: "mono" }, a.topic || "—"),
        h("dt", {}, "VoIP topic"), h("dd", { class: "mono" }, a.topic ? `${a.topic}.voip` : "—"),
        h("dt", {}, "Key id"), h("dd", { class: "mono" }, a.keyId || "—"), h("dt", {}, "Team"), h("dd", { class: "mono" }, a.teamId || "—")),
      h("label", { class: "row" }, enabled, "Send control messages over APNs"),
      h("div", { class: "grid grid--2" },
        h("label", { class: "field" }, h("span", { class: "label" }, "Environment"), env),
        h("label", { class: "field" }, h("span", { class: "label" }, "Topic (empty: APNS_TOPIC or the bundle id)"), topic)),
      h("div", { class: "row" },
        may("settings") ? h("button", { class: "btn btn--primary btn--sm", type: "button", onclick: async () => {
          const r = await guarded(() => api(`${API}/config`, { method: "PUT", body: { apns: { enabled: enabled.checked, env: env.value, topic: topic.value.trim() } } }), "APNs settings saved.");
          if (r) { M.setOverview(await api(API)); M.render(); }
        } }, "Save") : null,
        h("span", { class: "spacer" }), test, kind,
        may("push") ? h("button", { class: "btn btn--sm", type: "button", onclick: async () => {
          if (!test.value) return;
          const r = await guarded(() => api(`${API}/push/test`, { method: "POST", body: { device: test.value, type: kind.value } }));
          if (!r) return;
          const res = r.result;
          result.textContent = res ? (res.ok ? `Sent — APNs ${res.status}, apns-id ${res.apnsId}, ${res.attempts} attempt(s).` : `Refused — APNs ${res.status || "(no answer)"} ${res.reason || ""}${r.error ? `: ${r.error}` : ""}`) : `Not over APNs: ${r.error || (r.apns && !r.apns.ready ? r.apns.reason : "the device has no APNs token yet")} — it waits for the next check-in.`;
          toast(res && res.ok ? "Test push sent over APNs — watch the device." : "Not sent over APNs.", res && res.ok ? "ok" : "err");
        } }, "Test push") : null),
      result));
  }

  /* ============================================================ releases */

  async function releasesView(body) {
    const r = await guarded(() => api(`${API}/releases`));
    if (!r) return;
    const cfg = ov().config;
    const version = h("input", { class: "input input--sm", placeholder: "6.14.1", "data-testid": "rel-version" });
    const build = h("input", { class: "input input--sm", type: "number", min: "1", placeholder: "build (61401)" });
    const channel = h("select", { class: "input input--sm", "data-testid": "rel-channel" }, ...["stable", "beta", "dev"].map((c) => h("option", { value: c }, c)));
    const storeSel = h("select", { class: "input input--sm" }, h("option", { value: "appstore" }, "App Store"), h("option", { value: "testflight" }, "TestFlight"));
    const url = h("input", { class: "input input--sm mono", placeholder: cfg.appStoreUrl || "https://apps.apple.com/app/…", "data-testid": "rel-url" });
    channel.addEventListener("change", () => { storeSel.value = channel.value === "stable" ? "appstore" : "testflight"; url.placeholder = (storeSel.value === "testflight" ? cfg.testFlightUrl : cfg.appStoreUrl) || ""; });
    storeSel.addEventListener("change", () => { url.placeholder = (storeSel.value === "testflight" ? cfg.testFlightUrl : cfg.appStoreUrl) || ""; });
    const minBuild = h("input", { class: "input input--sm", type: "number", min: "0", value: "0" });
    const rollout = h("input", { class: "input input--sm", type: "number", min: "0", max: "100", value: "100" });
    const notes = Object.fromEntries(LANGS.map((l) => [l, h("textarea", { class: "input", rows: "2", placeholder: `Notes (${l})`, "data-lang": l })]));
    body.append(h("div", { class: "card stack" },
      h("div", { class: "card__head" }, h("div", { class: "card__title" }, "A new release"), h("div", { class: "card__hint" }, "No file: Apple installs the app. A release is the record of a version the App Store or TestFlight has — the server signs it, devices with an older build are told (in the rollout's share, every one below the minimum build), and the app opens the link.")),
      may("releases") ? h("div", { class: "stack" },
        h("div", { class: "grid grid--3" }, field("Version", version), field("Build (empty: from the version)", build), field("Channel", channel), field("Store", storeSel), field("Minimum build (0 = none)", minBuild), field("Rollout (% of devices)", rollout)),
        field("Link (empty: the one in Security)", url),
        h("div", { class: "ios-notes" }, ...LANGS.map((l) => notes[l])),
        h("div", { class: "row" }, h("button", { class: "btn btn--primary btn--sm", type: "button", "data-testid": "rel-create", onclick: async () => {
          const record = { version: version.value.trim(), channel: channel.value, store: storeSel.value, minBuild: Number(minBuild.value) || 0, rollout: Number(rollout.value), notes: Object.fromEntries(LANGS.map((l) => [l, notes[l].value])) };
          if (build.value) record.build = Number(build.value);
          if (url.value.trim()) record.url = url.value.trim();
          const res = await guarded(() => api(`${API}/releases`, { method: "POST", body: record }));
          if (res) { toast(`${res.release.version} (${res.release.build}) saved as a draft.`, "ok"); M.render(); }
        } }, "Save as a draft"))) : h("div", { class: "muted small" }, "Your access does not include releases.")));
    const tb = h("tbody");
    for (const x of r.releases) {
      const pct = h("input", { class: "input input--sm", type: "number", min: "0", max: "100", value: String(x.rollout), style: "width:72px" });
      tb.append(h("tr", { "data-release": x.id },
        h("td", {}, h("strong", {}, x.version), h("div", { class: "muted small" }, `build ${x.build}`)),
        h("td", {}, badge(x.status, K.statusTone(x.status)), " ", badge(x.channel, ""), " ", badge(x.store === "testflight" ? "TestFlight" : "App Store", "accent")),
        h("td", {}, `${x.rollout} %`, h("div", { class: "muted small" }, x.minBuild ? `required below ${x.minBuild}` : "not required")),
        h("td", { class: "small ios-kv-links" }, h("a", { href: x.url, target: "_blank", rel: "noopener noreferrer" }, x.url)),
        h("td", {}, when(x.createdAt), h("div", { class: "muted small" }, x.createdBy)),
        h("td", { class: "small" }, Object.entries(x.notes || {}).map(([l, t]) => `${l}: ${t}`).join(" · ") || "—"),
        h("td", {}, h("div", { class: "row" },
          x.status !== "published" && may("publish") ? h("button", { class: "btn btn--sm btn--primary", type: "button", onclick: async () => { const y = await guarded(() => api(`${API}/releases/${x.id}/publish`, { method: "POST", body: { notify: true } })); if (y) { toast(`Published; ${y.notified} devices told.`, "ok"); M.render(); } } }, "Publish") : null,
          x.status === "published" && may("publish") ? h("button", { class: "btn btn--sm", type: "button", onclick: async () => { if (await guarded(() => api(`${API}/releases/${x.id}/withdraw`, { method: "POST", body: {} }), "Withdrawn.")) M.render(); } }, "Withdraw") : null,
          may("releases") ? h("span", { class: "row" }, pct, h("button", { class: "btn btn--sm", type: "button", onclick: async () => { if (await guarded(() => api(`${API}/releases/${x.id}`, { method: "PATCH", body: { rollout: Number(pct.value) } }), "Rollout changed.")) M.render(); } }, "Set rollout")) : null,
          may("releases") ? h("button", { class: "btn btn--sm btn--danger", type: "button", onclick: async () => { if (!confirm(`Delete ${x.version}?`)) return; if (await guarded(() => api(`${API}/releases/${x.id}`, { method: "DELETE" }), "Deleted.")) M.render(); } }, "Delete") : null))));
    }
    body.append(h("div", { class: "card" }, h("div", { class: "card__head" }, h("div", { class: "card__title" }, "Releases")),
      r.releases.length ? h("div", { class: "table-wrap" }, h("table", { class: "tbl" }, h("thead", {}, h("tr", {}, ...["Version", "Status", "Rollout", "Link", "Created", "Notes", ""].map((t) => h("th", {}, t)))), tb)) : h("div", { class: "empty" }, "No release yet.")));
  }

  /* ============================================================ security */

  /** iOS's own settings on the Security tab: bundle id, the oldest build, the store links. */
  function securityExtra(cfg, f) {
    const bundleId = h("input", { class: "input input--sm mono", value: cfg.bundleId, "data-testid": "ios-bundle-id" });
    const minBuild = h("input", { class: "input input--sm", type: "number", min: "0", value: String(cfg.minAppBuild || 0), "data-testid": "ios-min-build" });
    const appStore = h("input", { class: "input input--sm mono", value: cfg.appStoreUrl, placeholder: "https://apps.apple.com/app/…/id…", "data-testid": "ios-appstore" });
    const testFlight = h("input", { class: "input input--sm mono", value: cfg.testFlightUrl, placeholder: "https://testflight.apple.com/join/…", "data-testid": "ios-testflight" });
    return {
      fields: [
        f("Bundle id", bundleId, "the app's identifier — the APNs topic and the passkeys' app id"),
        f("Oldest build allowed", minBuild, "major·10000 + minor·100 + patch (6.14.0 = 61400); older apps must update first; 0 = any"),
        f("App Store link", appStore),
        f("TestFlight link", testFlight),
      ],
      body: () => ({ bundleId: bundleId.value.trim(), minAppBuild: Number(minBuild.value) || 0, appStoreUrl: appStore.value.trim(), testFlightUrl: testFlight.value.trim() }),
    };
  }

  /** Passkeys on iOS: the apple-app-site-association this server publishes. */
  function passkeysCard() {
    const box = h("div", { class: "card stack", "data-testid": "ios-passkeys" },
      h("div", { class: "card__head" }, h("div", { class: "card__title" }, "Passkeys on iOS"), h("div", { class: "card__hint" }, "The app uses this server's passkeys when the domain lists it in /.well-known/apple-app-site-association (webcredentials) and the app has the Associated Domains entitlement webcredentials:<domain>. Apple's CDN fetches the file over https, without redirects.")),
      h("div", { class: "muted small" }, "Loading…"));
    void (async () => {
      const r = await guarded(() => api(`${API}/app-site`));
      if (!r) return;
      while (box.children.length > 1) box.lastChild.remove();
      const url = `${K.chatUrl()}${r.path}`;
      box.append(
        h("dl", { class: "kv" },
          h("dt", {}, "Team"), h("dd", { class: "mono" }, r.teamId || "— (APNS_TEAM_ID)"),
          h("dt", {}, "Bundle id"), h("dd", { class: "mono" }, r.bundleId),
          h("dt", {}, "Published"), h("dd", {}, r.published ? badge("yes", "ok") : badge("no — set APNS_TEAM_ID", "warn")),
          h("dt", {}, "Address"), h("dd", { class: "mono small" }, url)),
        r.association ? h("pre", { class: "ios-result" }, JSON.stringify(r.association, null, 2)) : null,
        h("div", { class: "row" }, h("button", { class: "btn btn--sm", type: "button", "data-read": "1", onclick: () => K.copyText(url, "Address copied.") }, "Copy the address")));
    })();
    return box;
  }

  /* ============================================================== design */

  /** The Design tab's iOS checks: what iOS cannot do (§ 5), the build it would make. */
  function designTools(current) {
    const check = async () => {
      const r = await guarded(() => api(`${API}/design/validate`, { method: "POST", body: { design: current() } }));
      if (!r) return;
      const lines = [
        h("div", {}, r.valid ? badge("valid", "ok") : badge("not valid", "err"), r.valid ? ` · for iOS apps from build ${r.minAppCode}` : ""),
        ...r.problems.map((p) => h("div", { class: "err small" }, p)),
        r.warnings.length ? h("h3", {}, "What the iOS app hides or does otherwise") : h("div", { class: "muted small" }, "Nothing that iOS cannot do."),
        ...r.warnings.map((w) => h("div", { class: "small" }, w)),
      ];
      if (Kit) Kit.openDialog({ title: "The design on iOS", subtitle: "the server's checks — nothing saved", body: h("div", { class: "stack", "data-testid": "ios-design-check" }, ...lines) });
      else toast(r.valid ? `Valid; ${r.warnings.length} iOS warnings.` : r.problems[0], r.valid ? "ok" : "err");
    };
    const preview = async () => {
      const r = await guarded(() => api(`${API}/design/preview`, { method: "POST", body: { design: current() } }));
      if (!r) return;
      const files = Object.entries(r.manifest.files).map(([path, x]) => h("tr", {}, h("td", { class: "mono small" }, path), h("td", {}, size(x.size))));
      if (Kit) Kit.openDialog({ title: "A build of this design", subtitle: `${size(r.size)} compressed · for iOS apps from ${r.minAppCode} — not built, nothing stored`, wide: true, body: h("div", { class: "table-wrap table-wrap--short" }, h("table", { class: "tbl" }, h("thead", {}, h("tr", {}, h("th", {}, "File"), h("th", {}, "Size"))), h("tbody", {}, ...files))) });
    };
    return [
      h("button", { class: "btn btn--sm", type: "button", "data-read": "1", "data-testid": "ios-design-validate", onclick: check }, "Check for iOS"),
      h("button", { class: "btn btn--sm", type: "button", "data-read": "1", onclick: preview }, "Build preview"),
    ];
  }

  /* ============================================================ platform */

  M.register({
    id: "ios",
    label: "iOS",
    route: "ios",
    title: "iOS",
    crumb: "Devices, builds, release records, design and security of the iOS app (iPhone and iPad)",
    rootId: "iosRoot",
    api: API,
    // The Android module's rights decide (Modules & groups): one module for the mobile apps.
    module: "android",
    frame: "ios",
    devices: [
      { id: "iphone17", label: "iPhone 17 · 402 × 874", w: 402, h: 874, kind: "phone" },
      { id: "iphone17promax", label: "iPhone 17 Pro Max · 440 × 956", w: 440, h: 956, kind: "phone" },
      { id: "iphonese", label: "iPhone SE · 375 × 667", w: 375, h: 667, kind: "se" },
      { id: "ipadmini", label: "iPad mini · 744 × 1133", w: 744, h: 1133, kind: "pad" },
      { id: "ipadpro11", label: "iPad Pro 11″ · 834 × 1210", w: 834, h: 1210, kind: "pad" },
      { id: "ipadpro13", label: "iPad Pro 13″ · 1032 × 1376", w: 1032, h: 1376, kind: "pad" },
    ],
    views: { overview: overviewView, push: pushView, releases: releasesView },
    modelOf: (d) => `${d.modelName || d.model}${d.idiom ? ` · ${idiomName(d.idiom)}` : ""}`,
    systemOf: (d) => [`${d.os || "iOS"} ${d.osVersion || ""}`.trim(), d.apnsEnv ? `APNs ${d.apnsEnv}` : idiomName(d.idiom)],
    pushBadge: (d) => h("span", {}, badge(d.push === "apns" ? (d.voip ? "APNs + VoIP" : "APNs") : "poll", d.push === "apns" ? "ok" : ""), d.apnsError ? badge(d.apnsError, "warn") : null),
    pushLine: (d) => `${d.push === "apns" ? "APNs" : "polling"}${d.voip ? " · VoIP (PushKit)" : ""}${d.apnsEnv ? ` · ${d.apnsEnv}` : ""}${d.apnsError ? ` · APNs last refused the token: ${d.apnsError}` : ""}`,
    deviceLine: (d) => `${d.modelName || d.model} (${d.model}) · ${d.os} ${d.osVersion} · ${idiomName(d.idiom)}`,
    securityExtra,
    passkeysCard,
    designTools,
    defineShared: "shared with Android",
    texts: {
      push: "APNs",
      poll: "Background check-in without APNs (minutes, at least 15 — iOS decides when)",
      screenshots: "Allow screenshots and the app switcher preview",
      unlockHint: "Every failed unlock (a wrong PIN or a refused Face ID / Touch ID) counts. After the last allowed one the device erases all its data and reports it (or locks for an hour when erasing is off). iOS cannot forbid a screenshot: with screenshots off the app shows a shield while the screen is recorded or shared, and in the app switcher.",
      defineHint: "The very same set as Android › Define — one source for both apps and Functions. A definition scoped android is for both mobile apps (the iOS app reads /api/define?scope=ios).",
    },
  });
})();
