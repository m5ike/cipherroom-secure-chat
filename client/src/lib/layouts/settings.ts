// The settings panels of the top menu (4.13): profile, settings, privacy,
// encryption, notifications, analytics, the room's security and trust —
// the content of their windows (the window is "window.large"). Drawn by
// panels.tsx, which keeps what they do.

import { treeBuilder, type LNode } from "../layout-tree";
import type { LayoutContract } from "./contracts";

/** The classes of the panels' fields. */
const INPUT = "min-h-10 rounded-xl border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring";

/** ProfilePanel. */
export function profileTree(): LNode {
  const { n, text } = treeBuilder("pf");
  return n("group", {id:"group",name:"Profile panel"}, [
    n("panel", {id:"mb-5",name:"Profile",tag:"section",attrs:{class:"mb-5 space-y-3"}}, [
      n("panel", {id:"flex",tag:"div",attrs:{class:"flex items-start gap-3"}}, [
        n("panel", {id:"mt-0-5",tag:"div",attrs:{class:"mt-0.5 text-primary"}}, [
          n("icon", {id:"icon-circle-user-round",props:{icon:"circle-user-round"},attrs:{class:"h-4 w-4"}}),
        ]),
        n("panel", {id:"panel",tag:"div"}, [
          n("heading", {id:"text-sm",tag:"h3",attrs:{class:"text-sm font-semibold tracking-tight"},text:"{_'profile.title'}"}),
        ]),
      ]),
      n("panel", {id:"space-y-2",tag:"div",attrs:{class:"space-y-2"}}, [
        n("label", {id:"grid",name:"Display name (field)",tag:"label",attrs:{class:"grid gap-1 text-sm"}}, [
          n("area", {id:"font-medium",tag:"span",attrs:{class:"font-medium"},text:"{_'profile.display.name'}"}),
          n("input", {id:"input-profile-name",tag:"input",attrs:{"data-testid":"input-profile-name",class:INPUT,value:"=$prefs.name",maxlength:"42"},on:{change:{action:"setText",arg:"'name'"}}}),
        ]),
        n("label", {id:"grid-2",name:"Avatar (URL or emoji) (field)",tag:"label",attrs:{class:"grid gap-1 text-sm"}}, [
          n("area", {id:"font-medium-2",tag:"span",attrs:{class:"font-medium"},text:"{_'profile.avatar'}"}),
          n("input", {id:"input-profile-avatar",tag:"input",attrs:{"data-testid":"input-profile-avatar",class:INPUT,value:"=$prefs.avatar",placeholder:"🦊  or  https://..."},on:{change:{action:"setText",arg:"'avatar'"}}}),
        ]),
        n("label", {id:"grid-3",name:"Short bio (field)",tag:"label",attrs:{class:"grid gap-1 text-sm"}}, [
          n("area", {id:"font-medium-3",tag:"span",attrs:{class:"font-medium"},text:"{_'profile.bio'}"}),
          n("textarea", {id:"input-profile-bio",tag:"textarea",attrs:{"data-testid":"input-profile-bio",class:`${INPUT} min-h-24 py-2`,value:"=$prefs.bio",maxlength:"280"},on:{change:{action:"setText",arg:"'bio'"}}}),
        ]),
      ]),
    ]),
    n("panel", {id:"mb-5-2",name:"PassKey profile (server)",tag:"section",attrs:{class:"mb-5 space-y-3"}}, [
      n("panel", {id:"flex-2",tag:"div",attrs:{class:"flex items-start gap-3"}}, [
        n("panel", {id:"mt-0-5-2",tag:"div",attrs:{class:"mt-0.5 text-primary"}}, [
          n("icon", {id:"icon-key-round",props:{icon:"key-round"},attrs:{class:"h-4 w-4"}}),
        ]),
        n("panel", {id:"panel-2",tag:"div"}, [
          n("heading", {id:"text-sm-2",tag:"h3",attrs:{class:"text-sm font-semibold tracking-tight"},text:"{_'passkey.title'}"}),
        ]),
      ]),
      n("panel", {id:"space-y-2-2",tag:"div",attrs:{class:"space-y-2"}}, [
        n("group", {id:"group-2",if:"$account"}, [
          n("paragraph", {id:"text-xs-6",tag:"p",attrs:{class:"text-xs text-muted-foreground"}}, [
            text("{_'id.signedInAs'}", { id: "text-6" }),
            text(" ", { id: "text-7" }),
            n("area", {id:"profile-username",tag:"code",attrs:{"data-testid":"profile-username"},text:"{=$account.username == null ? $account.id : $account.username}"}),
            text(" · ", { id: "text-9" }),
            text("{_'id.nickname'}", { id: "text-10" }),
            text(": ", { id: "text-11" }),
            n("area", {id:"area",tag:"b",text:"{=$prefs.name || ('—')}"}),
          ]),
          n("panel", {id:"flex-3",tag:"div",attrs:{class:"flex flex-wrap gap-2"}}, [
            n("button", {id:"passkey-save",tag:"button",attrs:{type:"button",disabled:"=$busy",class:"inline-flex min-h-10 items-center gap-2 rounded-xl bg-primary px-3 text-sm font-semibold text-primary-foreground disabled:opacity-60","data-testid":"passkey-save"},on:{click:{action:"save"}},text:"{_'passkey.save'}"}),
          ]),
        ]),
        n("panel", {id:"profile-need-signin",tag:"div",if:"!$account",attrs:{class:"id-need","data-testid":"profile-need-signin"}}, [
          n("area", {id:"id-need-icon",tag:"span",attrs:{class:"id-need__icon","aria-hidden":"true"}}, [
            n("icon", {id:"icon-key-round-2",props:{icon:"key-round"},attrs:{class:"h-4 w-4"}}),
          ]),
          n("panel", {id:"panel-3",tag:"div"}, [
            n("area", {id:"area-2",tag:"strong",text:"{_'id.need.title'}"}),
            n("paragraph", {id:"paragraph",tag:"p",text:"{_'id.profile.note'}"}),
            n("button", {id:"profile-open-connection",tag:"button",if:"$canOpenConnection",attrs:{type:"button",class:"acc-btn","data-testid":"profile-open-connection"},on:{click:{action:"openConnection"}},text:"{_'id.need.open'}"}),
          ]),
        ]),
        n("paragraph", {id:"passkey-msg",tag:"p",if:"$msg",attrs:{class:"text-xs","data-testid":"passkey-msg"},text:"{$msg}"}),
      ]),
    ]),
  ]);
}

/** SettingsPanel. */
export function settingsTree(): LNode {
  const { n, text } = treeBuilder("st");
  return n("group", {id:"group",name:"Settings panel"}, [
    n("panel", {id:"mb-5",name:"Language",tag:"section",attrs:{class:"mb-5 space-y-3"}}, [
      n("panel", {id:"flex",tag:"div",attrs:{class:"flex items-start gap-3"}}, [
        n("panel", {id:"mt-0-5",tag:"div",attrs:{class:"mt-0.5 text-primary"}}, [
          n("icon", {id:"icon-languages",props:{icon:"languages"},attrs:{class:"h-4 w-4"}}),
        ]),
        n("panel", {id:"panel",tag:"div"}, [
          n("heading", {id:"text-sm",tag:"h3",attrs:{class:"text-sm font-semibold tracking-tight"},text:"{_'common.language'}"}),
        ]),
      ]),
      n("panel", {id:"space-y-2",tag:"div",attrs:{class:"space-y-2"}}, [
        n("label", {id:"grid",name:"Language (field)",tag:"label",attrs:{class:"grid gap-1 text-sm"}}, [
          n("area", {id:"font-medium",tag:"span",attrs:{class:"font-medium"},text:"{_'common.language'}"}),
          n("select", {id:"select-language",tag:"select",attrs:{class:INPUT,value:"=$prefs.lang","data-testid":"select-language"},on:{change:{action:"setText",arg:"'lang'"}}}, [
            n("option", {id:"option",tag:"option",attrs:{value:"{$l.code}"},text:"{$l.label}",each:"$langs",as:"l",key:"$l.code"}),
          ]),
        ]),
        n("label", {id:"grid-2",name:"Timezone (field)",tag:"label",attrs:{class:"grid gap-1 text-sm"}}, [
          n("area", {id:"font-medium-2",tag:"span",attrs:{class:"font-medium"},text:"{_'common.timezone'}"}),
          n("input", {id:"input-timezone",tag:"input",attrs:{class:INPUT,value:"=$prefs.timezone","data-testid":"input-timezone"},on:{change:{action:"setText",arg:"'timezone'"}}}),
          n("area", {id:"text-xs-3",tag:"span",if:"$tzHint",attrs:{class:"text-xs text-muted-foreground"},text:"{$tzHint}"}),
        ]),
      ]),
    ]),
    n("panel", {id:"mb-5-2",name:"Appearance",tag:"section",attrs:{class:"mb-5 space-y-3"}}, [
      n("panel", {id:"flex-2",tag:"div",attrs:{class:"flex items-start gap-3"}}, [
        n("panel", {id:"mt-0-5-2",tag:"div",attrs:{class:"mt-0.5 text-primary"}}, [
          n("icon", {id:"icon-palette",props:{icon:"palette"},attrs:{class:"h-4 w-4"}}),
        ]),
        n("panel", {id:"panel-2",tag:"div"}, [
          n("heading", {id:"text-sm-2",tag:"h3",attrs:{class:"text-sm font-semibold tracking-tight"},text:"{_'menu.appearance'}"}),
        ]),
      ]),
      n("panel", {id:"space-y-2-2",tag:"div",attrs:{class:"space-y-2"}}, [
        n("paragraph", {id:"text-xs-5",tag:"p",attrs:{class:"text-xs text-muted-foreground"},text:"{_'settings.appearanceMoved'}"}),
        n("button", {id:"settings-open-appearance",tag:"button",if:"$canOpenAppearance",attrs:{type:"button",class:"inline-flex min-h-10 items-center gap-2 self-start rounded-xl border border-border bg-background px-3 text-sm font-semibold hover:bg-accent","data-testid":"settings-open-appearance"},on:{click:{action:"openAppearance"}}}, [
          n("icon", {id:"icon-palette-2",props:{icon:"palette"},attrs:{class:"h-4 w-4"}}),
          text(" ", { id: "text-8" }),
          text("{_'settings.openAppearance'}", { id: "text-9" }),
        ]),
      ]),
    ]),
    n("panel", {id:"mb-5-3",name:"File transfer limit",tag:"section",attrs:{class:"mb-5 space-y-3"}}, [
      n("panel", {id:"flex-3",tag:"div",attrs:{class:"flex items-start gap-3"}}, [
        n("panel", {id:"panel-3",tag:"div"}, [
          n("heading", {id:"text-sm-3",tag:"h3",attrs:{class:"text-sm font-semibold tracking-tight"},text:"{_'settings.maxAttachment.title'}"}),
          n("paragraph", {id:"text-xs-6",tag:"p",attrs:{class:"text-xs text-muted-foreground"},text:"{_'settings.maxAttachment.hint'}"}),
        ]),
      ]),
      n("panel", {id:"space-y-2-3",tag:"div",attrs:{class:"space-y-2"}}, [
        n("label", {id:"grid-3",name:"File transfer limit (field)",tag:"label",attrs:{class:"grid gap-1 text-sm"}}, [
          n("area", {id:"font-medium-3",tag:"span",attrs:{class:"font-medium"},text:"{_'settings.maxAttachment.title'}"}),
          n("select", {id:"select-max-attachment",tag:"select",attrs:{class:INPUT,value:"=$maxAttachment","data-testid":"select-max-attachment"},on:{change:{action:"maxAttachment"}}}, [
            n("option", {id:"option-2",tag:"option",attrs:{value:"=(100 * 1024) * 1024"},text:"100 MB"}),
            n("option", {id:"option-3",tag:"option",attrs:{value:"=(500 * 1024) * 1024"},text:"500 MB"}),
            n("option", {id:"option-4",tag:"option",attrs:{value:"=(1024 * 1024) * 1024"},text:"1 GB"}),
            n("option", {id:"option-5",tag:"option",attrs:{value:"=((10 * 1024) * 1024) * 1024"},text:"10 GB"}),
            n("option", {id:"option-6",tag:"option",attrs:{value:"unlimited"},text:"{_'settings.maxAttachment.unlimited'}"}),
          ]),
        ]),
      ]),
    ]),
  ]);
}

/** PrivacyPanel. */
export function privacyTree(): LNode {
  const { n, text } = treeBuilder("pv");
  return n("group", {id:"group",name:"Privacy panel"}, [
    n("panel", {id:"mb-5",name:"Transparent consent for metadata collection",tag:"section",attrs:{class:"mb-5 space-y-3"}}, [
      n("panel", {id:"flex",tag:"div",attrs:{class:"flex items-start gap-3"}}, [
        n("panel", {id:"mt-0-5",tag:"div",attrs:{class:"mt-0.5 text-primary"}}, [
          n("icon", {id:"icon-shield-check",props:{icon:"shield-check"},attrs:{class:"h-4 w-4"}}),
        ]),
        n("panel", {id:"panel",tag:"div"}, [
          n("heading", {id:"text-sm",tag:"h3",attrs:{class:"text-sm font-semibold tracking-tight"},text:"{_'privacy.consent'}"}),
        ]),
      ]),
      n("panel", {id:"space-y-2",tag:"div",attrs:{class:"space-y-2"}}, [
        n("paragraph", {id:"text-xs-2",tag:"p",attrs:{class:"text-xs text-muted-foreground"},text:"{_'privacy.consent.body'}"}),
        n("label", {id:"flex-2",name:"I consent to operational metadata collection (field)",tag:"label",attrs:{class:"flex items-center justify-between rounded-xl border border-border bg-background px-3 py-2 text-sm"}}, [
          n("area", {id:"area",tag:"span",text:"{_'analytics.opt.in'}"}),
          n("input", {id:"check-analytics-consent",tag:"input",attrs:{type:"checkbox","data-testid":"check-analytics-consent",checked:"=$prefs.analyticsConsent"},on:{change:{action:"setCheck",arg:"'analyticsConsent'"}}}),
        ]),
      ]),
    ]),
    n("panel", {id:"mb-5-2",name:"Purge local preferences, keys and logs in this browser",tag:"section",attrs:{class:"mb-5 space-y-3"}}, [
      n("panel", {id:"flex-3",tag:"div",attrs:{class:"flex items-start gap-3"}}, [
        n("panel", {id:"mt-0-5-2",tag:"div",attrs:{class:"mt-0.5 text-primary"}}, [
          n("icon", {id:"icon-eraser",props:{icon:"eraser"},attrs:{class:"h-4 w-4"}}),
        ]),
        n("panel", {id:"panel-2",tag:"div"}, [
          n("heading", {id:"text-sm-2",tag:"h3",attrs:{class:"text-sm font-semibold tracking-tight"},text:"{_'privacy.local.purge'}"}),
        ]),
      ]),
      n("panel", {id:"space-y-2-2",tag:"div",attrs:{class:"space-y-2"}}, [
        n("button", {id:"button-local-purge",tag:"button",attrs:{type:"button","data-testid":"button-local-purge",class:"inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm hover:bg-accent"},on:{click:{action:"localPurge"}}}, [
          n("icon", {id:"icon-trash",props:{icon:"trash"},attrs:{class:"h-4 w-4"}}),
          text("{_'privacy.local.purge'}", { id: "text-5" }),
        ]),
      ]),
    ]),
    n("panel", {id:"mb-5-3",name:"Purge server logs and sync data for this device",tag:"section",attrs:{class:"mb-5 space-y-3"}}, [
      n("panel", {id:"flex-4",tag:"div",attrs:{class:"flex items-start gap-3"}}, [
        n("panel", {id:"mt-0-5-3",tag:"div",attrs:{class:"mt-0.5 text-primary"}}, [
          n("icon", {id:"icon-triangle-alert",props:{icon:"triangle-alert"},attrs:{class:"h-4 w-4"}}),
        ]),
        n("panel", {id:"panel-3",tag:"div"}, [
          n("heading", {id:"text-sm-3",tag:"h3",attrs:{class:"text-sm font-semibold tracking-tight"},text:"{_'privacy.server.purge'}"}),
        ]),
      ]),
      n("panel", {id:"space-y-2-3",tag:"div",attrs:{class:"space-y-2"}}, [
        n("button", {id:"button-server-purge",tag:"button",attrs:{type:"button","data-testid":"button-server-purge",class:"inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm hover:bg-accent"},on:{click:{action:"serverPurge"}}}, [
          n("icon", {id:"icon-cloud",props:{icon:"cloud"},attrs:{class:"h-4 w-4"}}),
          text("{_'privacy.server.purge'}", { id: "text-7" }),
        ]),
        n("paragraph", {id:"text-server-purge-result",tag:"p",if:"$serverStatus",attrs:{class:"text-xs text-muted-foreground","data-testid":"text-server-purge-result"},text:"{$serverStatus}"}),
      ]),
    ]),
  ]);
}

/** EncryptionPanel. */
export function encryptionTree(): LNode {
  const { n, text } = treeBuilder("en");
  return n("group", {id:"group",name:"Encryption panel"}, [
    n("panel", {id:"mb-5",name:"WebRTC DTLS-SRTP",tag:"section",attrs:{class:"mb-5 space-y-3"}}, [
      n("panel", {id:"flex",tag:"div",attrs:{class:"flex items-start gap-3"}}, [
        n("panel", {id:"mt-0-5",tag:"div",attrs:{class:"mt-0.5 text-primary"}}, [
          n("icon", {id:"icon-lock",props:{icon:"lock"},attrs:{class:"h-4 w-4"}}),
        ]),
        n("panel", {id:"panel",tag:"div"}, [
          n("heading", {id:"text-sm",tag:"h3",attrs:{class:"text-sm font-semibold tracking-tight"},text:"{_'encryption.dtls.label'}"}),
        ]),
      ]),
      n("panel", {id:"space-y-2",tag:"div",attrs:{class:"space-y-2"}}, [
        n("paragraph", {id:"text-sm-2",tag:"p",attrs:{class:"text-sm text-muted-foreground"},text:"{_'encryption.dtls.body'}"}),
      ]),
    ]),
    n("panel", {id:"mb-5-2",name:"AES-GCM payload (256 bit)",tag:"section",attrs:{class:"mb-5 space-y-3"}}, [
      n("panel", {id:"flex-2",tag:"div",attrs:{class:"flex items-start gap-3"}}, [
        n("panel", {id:"mt-0-5-2",tag:"div",attrs:{class:"mt-0.5 text-primary"}}, [
          n("icon", {id:"icon-shield-check",props:{icon:"shield-check"},attrs:{class:"h-4 w-4"}}),
        ]),
        n("panel", {id:"panel-2",tag:"div"}, [
          n("heading", {id:"text-sm-3",tag:"h3",attrs:{class:"text-sm font-semibold tracking-tight"},text:"{_'encryption.aes.label'}"}),
        ]),
      ]),
      n("panel", {id:"space-y-2-2",tag:"div",attrs:{class:"space-y-2"}}, [
        n("paragraph", {id:"text-sm-4",tag:"p",attrs:{class:"text-sm text-muted-foreground"},text:"{_'encryption.aes.body'}"}),
      ]),
    ]),
    n("panel", {id:"mb-5-3",name:"PBKDF2 key derivation",tag:"section",attrs:{class:"mb-5 space-y-3"}}, [
      n("panel", {id:"flex-3",tag:"div",attrs:{class:"flex items-start gap-3"}}, [
        n("panel", {id:"mt-0-5-3",tag:"div",attrs:{class:"mt-0.5 text-primary"}}, [
          n("icon", {id:"icon-key-round",props:{icon:"key-round"},attrs:{class:"h-4 w-4"}}),
        ]),
        n("panel", {id:"panel-3",tag:"div"}, [
          n("heading", {id:"text-sm-5",tag:"h3",attrs:{class:"text-sm font-semibold tracking-tight"},text:"{_'encryption.kdf.label'}"}),
        ]),
      ]),
      n("panel", {id:"space-y-2-3",tag:"div",attrs:{class:"space-y-2"}}, [
        n("paragraph", {id:"text-sm-6",tag:"p",attrs:{class:"text-sm text-muted-foreground"},text:"{_'encryption.kdf.body'}"}),
      ]),
    ]),
    n("paragraph", {id:"rounded-2xl",tag:"p",attrs:{class:"rounded-2xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200"},text:"{_'encryption.disclaimer'}"}),
    n("panel", {id:"mb-5-4",tag:"section",attrs:{class:"mb-5 space-y-3"}}, [
      n("panel", {id:"flex-4",tag:"div",attrs:{class:"flex items-start gap-3"}}, [
        n("panel", {id:"mt-0-5-4",tag:"div",attrs:{class:"mt-0.5 text-primary"}}, [
          n("icon", {id:"icon-triangle-alert",props:{icon:"triangle-alert"},attrs:{class:"h-4 w-4"}}),
        ]),
        n("panel", {id:"panel-4",tag:"div"}, [
          n("heading", {id:"text-sm-7",tag:"h3",attrs:{class:"text-sm font-semibold tracking-tight"},text:"TTL"}),
        ]),
      ]),
      n("panel", {id:"space-y-2-4",tag:"div",attrs:{class:"space-y-2"}}, [
        n("label", {id:"grid",name:"Default TTL for my messages (field)",tag:"label",attrs:{class:"grid gap-1 text-sm"}}, [
          n("area", {id:"font-medium",tag:"span",attrs:{class:"font-medium"},text:"{_'ttl.user.default'}"}),
          n("input", {id:"input-ttl-default",tag:"input",attrs:{type:"number",min:"0",max:"=(60 * 24) * 30","data-testid":"input-ttl-default",value:"=$prefs.ttlDefaultMinutes",class:INPUT},on:{change:{action:"ttlDefault"}}}),
          n("area", {id:"text-xs-5",tag:"span",attrs:{class:"text-xs text-muted-foreground"},text:"{_'ttl.unit.minutes'}"}),
        ]),
      ]),
    ]),
  ]);
}

/** NotificationsPanel. */
export function notificationsTree(): LNode {
  const { n } = treeBuilder("nt");
  return n("group", {id:"group",name:"Notifications panel"}, [
    n("panel", {id:"mb-5",name:"Push & system notifications",tag:"section",attrs:{class:"mb-5 space-y-3"}}, [
      n("panel", {id:"flex",tag:"div",attrs:{class:"flex items-start gap-3"}}, [
        n("panel", {id:"mt-0-5",tag:"div",attrs:{class:"mt-0.5 text-primary"}}, [
          n("icon", {id:"icon-bell-ring",props:{icon:"bell-ring"},attrs:{class:"h-4 w-4"}}),
        ]),
        n("panel", {id:"panel",tag:"div"}, [
          n("heading", {id:"text-sm",tag:"h3",attrs:{class:"text-sm font-semibold tracking-tight"},text:"{_'notif.title'}"}),
        ]),
      ]),
      n("panel", {id:"space-y-2",tag:"div",attrs:{class:"space-y-2"}}, [
        n("paragraph", {id:"text-xs-2",tag:"p",attrs:{class:"text-xs text-muted-foreground"},text:"{if $pushAvailable}{if $lang === 'cs'}Push server (VAPID) je nakonfigurovaný.{elseif $lang === 'de'}Push-Server (VAPID) ist konfiguriert.{else}Push server (VAPID) is configured.{/if}{else}{if $lang === 'cs'}Push není konfigurován — použijí se lokální notifikace v tabu.{elseif $lang === 'de'}Push nicht konfiguriert — lokale Benachrichtigungen im Tab.{else}Push not configured — falling back to in-tab notifications.{/if}{/if}"}),
        n("panel", {id:"flex-2",tag:"div",attrs:{class:"flex flex-wrap gap-2"}}, [
          n("button", {id:"button-notif-disable",tag:"button",if:"$prefs.notificationsEnabled",attrs:{type:"button","data-testid":"button-notif-disable",class:"inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm hover:bg-accent"},on:{click:{action:"disable"}},text:"{_'common.disable'}"}),
          n("button", {id:"button-notif-enable",tag:"button",if:"!$prefs.notificationsEnabled",attrs:{type:"button","data-testid":"button-notif-enable",class:"inline-flex min-h-10 items-center gap-2 rounded-xl bg-primary px-3 text-sm font-semibold text-primary-foreground"},on:{click:{action:"enable"}},text:"{_'common.enable'}"}),
          n("button", {id:"button-notif-test-local",tag:"button",if:"$canTestLocal",attrs:{type:"button","data-testid":"button-notif-test-local",class:"inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm hover:bg-accent"},on:{click:{action:"testLocal"}},text:"Test local notification"}),
          n("button", {id:"button-notif-test-push",tag:"button",if:"$canTestPush",attrs:{type:"button","data-testid":"button-notif-test-push",disabled:"=!$pushAvailable || !$signedIn",class:"inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm hover:bg-accent disabled:opacity-60"},on:{click:{action:"testPush"}},text:"Test web push"}),
        ]),
        n("slot", {id:"part-need-sign-in",slot:"needSignIn",if:"!$signedIn"}),
        n("paragraph", {id:"text-notif-test-result",tag:"p",if:"$testResult",attrs:{class:"text-xs text-muted-foreground","data-testid":"text-notif-test-result"},text:"{$testResult}"}),
      ]),
    ]),
  ]);
}

/** AnalyticsPanel. */
export function analyticsTree(): LNode {
  const { n } = treeBuilder("an");
  return n("group", {id:"group",name:"Analytics panel"}, [
    n("panel", {id:"mb-5",name:"Analytics & consent",tag:"section",attrs:{class:"mb-5 space-y-3"}}, [
      n("panel", {id:"flex",tag:"div",attrs:{class:"flex items-start gap-3"}}, [
        n("panel", {id:"mt-0-5",tag:"div",attrs:{class:"mt-0.5 text-primary"}}, [
          n("icon", {id:"icon-shield-check",props:{icon:"shield-check"},attrs:{class:"h-4 w-4"}}),
        ]),
        n("panel", {id:"panel",tag:"div"}, [
          n("heading", {id:"text-sm",tag:"h3",attrs:{class:"text-sm font-semibold tracking-tight"},text:"{_'analytics.title'}"}),
        ]),
      ]),
      n("panel", {id:"space-y-2",tag:"div",attrs:{class:"space-y-2"}}, [
        n("paragraph", {id:"text-xs-2",tag:"p",attrs:{class:"text-xs text-muted-foreground"},text:"{_'privacy.consent.body'}"}),
        n("label", {id:"flex-2",name:"I consent to operational metadata collection (field)",tag:"label",attrs:{class:"flex items-center justify-between rounded-xl border border-border bg-background px-3 py-2 text-sm"}}, [
          n("area", {id:"area",tag:"span",text:"{_'analytics.opt.in'}"}),
          n("input", {id:"check-analytics-consent-2",tag:"input",attrs:{type:"checkbox","data-testid":"check-analytics-consent-2",checked:"=$prefs.analyticsConsent"},on:{change:{action:"setCheck",arg:"'analyticsConsent'"}}}),
        ]),
      ]),
    ]),
  ]);
}

/** RoomSecurityPanel. */
export function roomSecurityTree(): LNode {
  const { n } = treeBuilder("rs");
  return n("group", {id:"group",name:"Room security panel"}, [
    n("paragraph", {id:"text-sm",tag:"p",if:"!$room",attrs:{class:"text-sm text-muted-foreground"},text:"{if $lang === 'cs'}Připoj se nejprve do místnosti.{elseif $lang === 'de'}Bitte zuerst einem Raum beitreten.{else}Join a room first.{/if}"}),
    n("group", {id:"group-2",if:"$room"}, [
      n("panel", {id:"mb-5",name:"Room security",tag:"section",attrs:{class:"mb-5 space-y-3"}}, [
        n("panel", {id:"flex",tag:"div",attrs:{class:"flex items-start gap-3"}}, [
          n("panel", {id:"mt-0-5",tag:"div",attrs:{class:"mt-0.5 text-primary"}}, [
            n("icon", {id:"icon-puzzle",props:{icon:"puzzle"},attrs:{class:"h-4 w-4"}}),
          ]),
          n("panel", {id:"panel",tag:"div"}, [
            n("heading", {id:"text-sm-2",tag:"h3",attrs:{class:"text-sm font-semibold tracking-tight"},text:"{_'room.security.title'}"}),
          ]),
        ]),
        n("panel", {id:"space-y-2",tag:"div",attrs:{class:"space-y-2"}}, [
          n("label", {id:"grid",name:"Message ordering (field)",tag:"label",attrs:{class:"grid gap-1 text-sm"}}, [
            n("area", {id:"font-medium",tag:"span",attrs:{class:"font-medium"},text:"{_'room.sort'}"}),
            n("select", {id:"select",tag:"select",attrs:{class:INPUT,value:"=$security.sort"},on:{change:{action:"sort"}}}, [
              n("option", {id:"option",tag:"option",attrs:{value:"asc"},text:"{_'room.sort.asc'}"}),
              n("option", {id:"option-2",tag:"option",attrs:{value:"desc"},text:"{_'room.sort.desc'}"}),
            ]),
          ]),
          n("label", {id:"flex-2",name:"Delivery status (field)",tag:"label",attrs:{class:"flex items-center justify-between rounded-xl border border-border bg-background px-3 py-2 text-sm"}}, [
            n("area", {id:"area",tag:"span",text:"{_'room.delivery'}"}),
            n("input", {id:"input",tag:"input",attrs:{type:"checkbox",checked:"=$security.deliveryReceipts"},on:{change:{action:"securityCheck",arg:"'deliveryReceipts'"}}}),
          ]),
          n("label", {id:"flex-3",name:"Read receipts (field)",tag:"label",attrs:{class:"flex items-center justify-between rounded-xl border border-border bg-background px-3 py-2 text-sm"}}, [
            n("area", {id:"area-2",tag:"span",text:"{_'room.read'}"}),
            n("input", {id:"input-2",tag:"input",attrs:{type:"checkbox",checked:"=$security.readReceipts"},on:{change:{action:"securityCheck",arg:"'readReceipts'"}}}),
          ]),
          n("label", {id:"flex-4",name:"Typing indicator (field)",tag:"label",attrs:{class:"flex items-center justify-between rounded-xl border border-border bg-background px-3 py-2 text-sm"}}, [
            n("area", {id:"area-3",tag:"span",text:"{_'room.typing'}"}),
            n("input", {id:"input-3",tag:"input",attrs:{type:"checkbox",checked:"=$security.typingIndicator"},on:{change:{action:"securityCheck",arg:"'typingIndicator'"}}}),
          ]),
        ]),
      ]),
      n("panel", {id:"mb-5-2",name:"Message expiry (TTL)",tag:"section",attrs:{class:"mb-5 space-y-3"}}, [
        n("panel", {id:"flex-5",tag:"div",attrs:{class:"flex items-start gap-3"}}, [
          n("panel", {id:"mt-0-5-2",tag:"div",attrs:{class:"mt-0.5 text-primary"}}, [
            n("icon", {id:"icon-triangle-alert",props:{icon:"triangle-alert"},attrs:{class:"h-4 w-4"}}),
          ]),
          n("panel", {id:"panel-2",tag:"div"}, [
            n("heading", {id:"text-sm-3",tag:"h3",attrs:{class:"text-sm font-semibold tracking-tight"},text:"{_'ttl.title'}"}),
          ]),
        ]),
        n("panel", {id:"space-y-2-2",tag:"div",attrs:{class:"space-y-2"}}, [
          n("label", {id:"grid-2",name:"Override for this room (field)",tag:"label",attrs:{class:"grid gap-1 text-sm"}}, [
            n("area", {id:"font-medium-2",tag:"span",attrs:{class:"font-medium"},text:"{_'ttl.room.override'}"}),
            n("input", {id:"input-room-ttl-default",tag:"input",attrs:{type:"number",min:"0",max:"=(60 * 24) * 30",value:"=$ttl.defaultMinutes",class:INPUT,"data-testid":"input-room-ttl-default"},on:{change:{action:"ttl",arg:"'defaultMinutes'"}}}),
            n("area", {id:"text-xs-4",tag:"span",attrs:{class:"text-xs text-muted-foreground"},text:"{_'ttl.unit.minutes'}"}),
          ]),
          n("label", {id:"grid-3",name:"Absolute room TTL (field)",tag:"label",attrs:{class:"grid gap-1 text-sm"}}, [
            n("area", {id:"font-medium-3",tag:"span",attrs:{class:"font-medium"},text:"{_'ttl.room.absolute'}"}),
            n("input", {id:"input-room-ttl-absolute",tag:"input",attrs:{type:"number",min:"0",max:"=(60 * 24) * 30",value:"=$ttl.absoluteMinutes",class:INPUT,"data-testid":"input-room-ttl-absolute"},on:{change:{action:"ttl",arg:"'absoluteMinutes'"}}}),
            n("area", {id:"text-xs-5",tag:"span",attrs:{class:"text-xs text-muted-foreground"},text:"{_'ttl.unit.minutes'}"}),
          ]),
        ]),
      ]),
    ]),
  ]);
}

/** TrustPanel. */
export function trustTree(): LNode {
  const { n, text, icon } = treeBuilder("tr");
  const cs = (a: string, b: string) => `{if $lang === 'cs'}${a}{else}${b}{/if}`;
  const section = (id: string, iconName: string, title: string, desc: string, body: LNode[]) =>
    n("panel", { id, tag: "section", attrs: { class: "mb-5 space-y-3" } }, [
      n("panel", { id: `${id}-head`, attrs: { class: "flex items-start gap-3" } }, [
        n("panel", { id: `${id}-icon`, attrs: { class: "mt-0.5 text-primary" } }, [icon(iconName, "h-4 w-4", {}, { id: `${id}-icon-svg` })]),
        n("panel", { id: `${id}-titles` }, [
          n("heading", { id: `${id}-title`, attrs: { class: "text-sm font-semibold tracking-tight" }, text: title }),
          n("paragraph", { id: `${id}-desc`, attrs: { class: "text-xs text-muted-foreground" }, text: desc }),
        ]),
      ]),
      n("panel", { id: `${id}-body`, attrs: { class: "space-y-2" } }, body),
    ]);
  return n("group", { id: "trust" }, [
    section("trust-tofu", "shield-check", "DTLS fingerprint TOFU",
      cs("Každý peer připojení má jedinečný SHA-256 otisk. Při prvním spojení se uloží. Při změně otisku dostanete varování — ověřte s protistranou přes Signal, telefon nebo osobně.",
        "Each peer connection has a unique SHA-256 fingerprint. The first observed fingerprint is stored. If it later changes you get a warning — verify out of band."), [
        n("paragraph", { id: "trust-empty", if: "($entries|length) === 0", attrs: { class: "text-sm text-muted-foreground", "data-testid": "trust-empty" }, text: cs("Zatím žádné otisky — připojte se k místnosti.", "No fingerprints yet — join a room.") }),
        n("list", { id: "trust-list", if: "($entries|length) > 0", attrs: { class: "space-y-3", "data-testid": "trust-list" } }, [
          n("item", { id: "trust-entry", name: "A peer", each: "$entries", as: "e", key: "$e.peerId", attrs: { class: "rounded-xl border border-border bg-background p-3 font-mono text-xs" } }, [
            n("panel", { id: "trust-entry-head", attrs: { class: "flex items-center justify-between" } }, [
              n("area", { id: "trust-peer", attrs: { class: "truncate font-semibold" }, text: "{$e.short}" }),
              n("area", { id: "trust-stored", attrs: { class: "text-muted-foreground" }, text: `${cs("uloženo", "stored")}: {$e.stored}` }),
            ]),
            n("panel", { id: "trust-fingerprint", attrs: { class: "mt-1 break-all text-[11px] leading-relaxed text-foreground", "data-testid": "trust-fingerprint" }, text: "{$e.formatted}" }),
            n("panel", { id: "trust-indicator", attrs: { class: "mt-1 text-[10px] text-muted-foreground" }, text: `${cs("SHA-256 indikátor: ", "SHA-256 indicator: ")}{$e.head}…{$e.tail}` }),
          ]),
        ]),
      ]),
    section("trust-dpa", "key-round", cs("Detekce přítomnosti (DPA)", "Presence detection (DPA)"),
      cs("Room-key otisk slouží jako anti-spam. Identifikátor místnosti je deterministický z `roomId + passphrase`; změna hesla změní room-key.",
        "Room-key fingerprint acts as a DPA anchor. The room id is deterministic from roomId + passphrase; rotating the passphrase rotates the room key."), [
        n("group", { id: "trust-room", if: "$roomFingerprint" }, [
          n("paragraph", { id: "trust-room-caption", attrs: { class: "text-xs text-muted-foreground" }, text: cs("Room-key otisk (deterministický, ne fingerprint RTC)", "Room-key fingerprint (deterministic, non-RTC)") }),
          n("panel", { id: "room-fingerprint", attrs: { "data-testid": "room-fingerprint", class: "break-all rounded-xl border border-border bg-background p-3 font-mono text-xs" }, text: "{$roomFingerprint}" }),
        ]),
        n("paragraph", { id: "trust-room-none", if: "!$roomFingerprint", attrs: { class: "text-xs text-muted-foreground" }, text: cs("Připojte se k místnosti pro výpočet room-key otisku.", "Join a room to compute the room-key fingerprint.") }),
      ]),
  ]);
}

/* ------------------------------------------------------------ contracts */

type SettingsId = "panel.profile" | "panel.settings" | "panel.privacy" | "panel.encryption" | "panel.notifications" | "panel.analytics" | "panel.roomSecurity" | "panel.trust";

const PREFS = { path: "$prefs", type: "object" as const, description: "The user's preferences (.name, .avatar, .bio, .lang, .timezone, .analyticsConsent, .ttlDefaultMinutes, .notificationsEnabled…)." };
const SET_TEXT = { name: "setText", description: "A preference typed or chosen.", arg: "its name ('name', 'lang'…)", event: "change" };
const SET_CHECK = { name: "setCheck", description: "A preference ticked.", arg: "its name ('analyticsConsent')", event: "change" };

export const SETTINGS_CONTRACTS: Record<SettingsId, LayoutContract> = {
  "panel.profile": {
    description: "Profile: the name, avatar and bio, and saving the profile with the account.",
    vars: [PREFS, { path: "$account", type: "object", description: "The signed-in account (.username, .id), or nothing." }, { path: "$busy", type: "yes/no", description: "Saving." }, { path: "$msg", type: "text", description: "What saving said." }, { path: "$canOpenConnection", type: "yes/no", description: "The Connection window can be opened." }],
    actions: [SET_TEXT, { name: "save", description: "Save the profile with the account." }, { name: "openConnection", description: "Open the Connection window (sign in)." }],
    slots: [], refs: [],
  },
  "panel.settings": {
    description: "Settings: the language, the time zone, where appearance went, the largest attachment.",
    vars: [PREFS, { path: "$langs", type: "list", description: "The languages: .code, .label." }, { path: "$tzHint", type: "text", description: "This device's time zone." }, { path: "$canOpenAppearance", type: "yes/no", description: "The Appearance panel can be opened." }, { path: "$maxAttachment", type: "text", description: "The largest attachment (bytes, or unlimited)." }],
    actions: [SET_TEXT, { name: "openAppearance", description: "Open Appearance." }, { name: "maxAttachment", description: "The largest attachment chosen.", event: "change" }],
    slots: [], refs: [],
  },
  "panel.privacy": {
    description: "Privacy: consent to analytics, and deleting data here and on the server.",
    vars: [PREFS, { path: "$serverStatus", type: "text", description: "What the server said to the deletion." }],
    actions: [SET_CHECK, { name: "localPurge", description: "Delete this device's data." }, { name: "serverPurge", description: "Delete the data on the server." }],
    slots: [], refs: [],
  },
  "panel.encryption": {
    description: "Encryption: what protects the messages, and the messages' default lifetime.",
    vars: [PREFS],
    actions: [{ name: "ttlDefault", description: "The default lifetime (minutes).", event: "change" }],
    slots: [], refs: [],
  },
  "panel.notifications": {
    description: "Notifications: on / off, web push, and tests.",
    vars: [PREFS, { path: "$pushAvailable", type: "yes/no", description: "The server has web push (VAPID)." }, { path: "$signedIn", type: "yes/no", description: "Signed in (web push needs it)." }, { path: "$lang", type: "text", description: "The language (cs, en, de)." }, { path: "$canTestLocal", type: "yes/no", description: "A local test is possible." }, { path: "$canTestPush", type: "yes/no", description: "A push test is possible." }, { path: "$testResult", type: "text", description: "What a test said." }],
    actions: [{ name: "enable", description: "Turn notifications on." }, { name: "disable", description: "Turn them off." }, { name: "testLocal", description: "Send a local test." }, { name: "testPush", description: "Send a web push test." }],
    slots: [{ name: "needSignIn", description: "“Sign in first” (signed out)." }], refs: [],
  },
  "panel.analytics": {
    description: "Analytics: the consent.",
    vars: [PREFS],
    actions: [SET_CHECK],
    slots: [], refs: [],
  },
  "panel.roomSecurity": {
    description: "The room's security: the order, receipts, typing, and the messages' lifetime in this room.",
    vars: [{ path: "$room", type: "text", description: "The room (empty: not in one)." }, { path: "$lang", type: "text", description: "The language." }, { path: "$security", type: "object", description: ".sort (asc / desc), .deliveryReceipts, .readReceipts, .typingIndicator." }, { path: "$ttl", type: "object", description: ".defaultMinutes, .absoluteMinutes." }],
    actions: [{ name: "sort", description: "The order chosen.", event: "change" }, { name: "securityCheck", description: "A receipt or the typing indicator ticked.", arg: "its name", event: "change" }, { name: "ttl", description: "A lifetime typed (minutes).", arg: "'defaultMinutes' or 'absoluteMinutes'", event: "change" }],
    slots: [], refs: [],
  },
  "panel.trust": {
    description: "Trust: the peers' DTLS fingerprints (trust on first use) and the room key's fingerprint.",
    vars: [{ path: "$lang", type: "text", description: "The language." }, { path: "$entries", type: "list", description: "Fingerprints: .peerId, .short, .stored, .formatted, .head, .tail." }, { path: "$roomFingerprint", type: "text", description: "The room key's fingerprint (formatted)." }],
    actions: [],
    slots: [], refs: [],
  },
};

export const SETTINGS_VARIANTS: Record<SettingsId, ReadonlyArray<{ id: string; label: string }>> = {
  "panel.profile": [{ id: "signedin", label: "Signed in" }, { id: "signedout", label: "Signed out" }],
  "panel.settings": [{ id: "plain", label: "Settings" }],
  "panel.privacy": [{ id: "plain", label: "Privacy" }],
  "panel.encryption": [{ id: "plain", label: "Encryption" }],
  "panel.notifications": [{ id: "on", label: "On, push available" }, { id: "off", label: "Off, no push, signed out" }],
  "panel.analytics": [{ id: "plain", label: "Analytics" }],
  "panel.roomSecurity": [{ id: "room", label: "In a room" }, { id: "none", label: "Not in a room" }],
  "panel.trust": [{ id: "peers", label: "With fingerprints" }, { id: "empty", label: "Nothing yet" }],
};
