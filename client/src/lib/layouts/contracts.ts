// What each layout may use — the values its component hands over, the
// actions its events may run, the live parts (slots) it draws itself and the
// refs it keeps. The Layout builder offers exactly these while editing
// (suggestions, pickers, the help window); a layout using something else
// simply gets nothing for it.

import type { LayoutId } from "./index";
import { WINDOW_CONTRACTS } from "./windows";
import { ROOM_CONTRACTS } from "./room";
import { ROOM_BAR_CONTRACT } from "./roombar";
import { PHONE_BRIDGE_CONTRACT } from "./phonebridge";
import { DIALOG_CONTRACTS } from "./dialogs";
import { ACCOUNT_CONTRACTS } from "./account";
import { SETTINGS_CONTRACTS } from "./settings";
import { TOOL_CONTRACTS } from "./tools";
import { SHARE_CONTRACTS } from "./share";
import { PHONE_CONTRACTS } from "./phone";
import { CONNECTION_CONTRACTS } from "./connections";
import { AI_CONTRACTS } from "./ai";

export type ContractVar = { path: string; type: "text" | "number" | "yes/no" | "list" | "object"; description: string };
export type ContractAction = { name: string; description: string; arg?: string; event?: string };
export type ContractPart = { name: string; description: string; arg?: string };
export type LayoutContract = { description: string; vars: ContractVar[]; actions: ContractAction[]; slots: ContractPart[]; refs: ContractPart[] };

const MESSAGE_VARS: ContractVar[] = [
  { path: "$id", type: "text", description: "The message's id (test ids: message-{$id})." },
  { path: "$mine", type: "yes/no", description: "Sent by me." },
  { path: "$isSystem", type: "yes/no", description: "A system notice." },
  { path: "$senderId", type: "text", description: "The sender's peer id." },
  { path: "$senderName", type: "text", description: "The sender's nickname." },
  { path: "$timeLabel", type: "text", description: "The meta line (the old “incoming / outgoing meta” text)." },
  { path: "$createdAt", type: "number", description: "When it was sent (ms) — {$createdAt|date:'H:i'}." },
  { path: "$bodyText", type: "text", description: "The text (open, when sealed)." },
  { path: "$secure", type: "yes/no", description: "End-to-end verified (and the lock icon is on)." },
  { path: "$private", type: "yes/no", description: "Only to some people." },
  { path: "$to", type: "text", description: "Their names (private)." },
  { path: "$forwardedFrom", type: "text", description: "Forwarded from whom." },
  { path: "$loc", type: "object", description: "6.1: the sender's position (.lat, .lon, .acc, .url — an OpenStreetMap link), or nothing." },
  { path: "$replyTo", type: "object", description: "The quoted message: .id, .senderName, .text." },
  { path: "$attachment", type: "object", description: "A file: .name, .mime, .size, .sizeText, .dataUrl, .isImage, .isAudio; 6.2: .kind (image, video, audio, pdf, text, file), .isVideo, .isPdf, .isText, .mediaUrl (a blob: URL to play), .preview and .previewMore (a text's first lines), .hasPreview." },
  { path: "$attachments", type: "list", description: "6.2: the files of the message for the footer: .index, .name, .mime, .kind, .icon, .sizeText, .available (its bytes are here), .dropped (left out of the history)." },
  { path: "$shareMenu", type: "number", description: "6.2: the file whose share menu is open (its .index), or nothing." },
  { path: "$map", type: "object", description: "6.2: the map preview of $loc (client config › map), or nothing: .style, .tiles (.src, .style, .key), .pinStyle, .caption, .captionStyle, .coords, .attribution, .gray, .url, .width, .height." },
  { path: "$hidden", type: "yes/no", description: "6.2: hidden in this view (drawn only while hidden messages are shown)." },
  { path: "$tap", type: "yes/no", description: "Hold-to-read." },
  { path: "$revealed", type: "yes/no", description: "Open (held, unsealed)." },
  { path: "$vanishing", type: "yes/no", description: "Disappears after it was read." },
  { path: "$vanished", type: "yes/no", description: "Gone (a tombstone)." },
  { path: "$vanishedAtText", type: "text", description: "“ · date” of the tombstone." },
  { path: "$sealed", type: "yes/no", description: "Sealed with a code." },
  { path: "$sealedOpen", type: "yes/no", description: "Sealed and opened." },
  { path: "$sealCode", type: "text", description: "My code for my sealed message." },
  { path: "$codeInput", type: "text", description: "What is typed into the code field." },
  { path: "$codeError", type: "yes/no", description: "A wrong code was tried." },
  { path: "$sealedWith", type: "text", description: "sender-key, pair or room." },
  { path: "$queued", type: "yes/no", description: "Still on its way (outgoing)." },
  { path: "$fnRunning", type: "yes/no", description: "A chat command is running — the bubble pulses (6.5)." },
  { path: "$delivery", type: "text", description: "queued, stored, delivered, read or sent (outgoing)." },
  { path: "$collapsed", type: "yes/no", description: "A system notice folded to its first line." },
  { path: "$bubbleStyle", type: "object", description: "The colours the user picked for this sender (use as “CSS from data”)." },
  { path: "$hasInfo", type: "yes/no", description: "The info button can be shown." },
  { path: "$canReply", type: "yes/no", description: "Reply is available." },
  { path: "$canForward", type: "yes/no", description: "Forward is available." },
  { path: "$showActions", type: "yes/no", description: "Reply or forward is available." },
  { path: "$showAvatar", type: "yes/no", description: "Avatars are on (outgoing)." },
  { path: "$avatar", type: "text", description: "My avatar (outgoing)." },
  { path: "$headerText", type: "text", description: "The system notice's header (the old “system header” text)." },
  { path: "$showLogo", type: "yes/no", description: "The logo of system notices is on." },
];

const MESSAGE_ACTIONS: ContractAction[] = [
  { name: "info", description: "Open the message's details." },
  { name: "reply", description: "Reply to it." },
  { name: "forward", description: "Forward it." },
  { name: "quoteJump", description: "Scroll to the quoted message." },
  { name: "unfold", description: "Unfold a folded system notice." },
  { name: "holdStart", description: "Hold-to-read: start (pointer down).", event: "pointerdown" },
  { name: "holdEnd", description: "Hold-to-read: stop (pointer up / leave).", event: "pointerup" },
  { name: "codeChange", description: "The code field changed.", event: "change" },
  { name: "codeKey", description: "A key in the code field (Enter opens).", event: "keydown" },
  { name: "codeSubmit", description: "Try the code." },
  { name: "save", description: "6.2: save a file (the argument: its $f.index).", arg: "$f.index" },
  { name: "share", description: "6.2: share a file — the system's share sheet, else the share menu.", arg: "$f.index" },
  { name: "open", description: "6.2: open a file (a PDF) in a new tab.", arg: "$f.index" },
  { name: "copyName", description: "6.2: copy a file's name (the share menu).", arg: "$f.index" },
  { name: "closeShare", description: "6.2: close the share menu." },
];

export const LAYOUT_CONTRACTS: Readonly<Record<LayoutId, LayoutContract>> = {
  header: {
    description: "The bar at the top: the logo (opens the Room window), the connection status, the connection switcher, the account badge, the menu and fullscreen.",
    vars: [
      { path: "$status", type: "text", description: "idle, deriving, connecting, joined or offline." },
      { path: "$room", type: "text", description: "The room." },
      { path: "$openPeerCount", type: "number", description: "People connected." },
      { path: "$reconnectPending", type: "yes/no", description: "The connection is being restored." },
      { path: "$statusTitle", type: "text", description: "The status tooltip (state, attempts, RTT)." },
      { path: "$showSwitcher", type: "yes/no", description: "The saved-connection switcher is available." },
      { path: "$profiles", type: "list", description: "Saved connections: .id, .label." },
      { path: "$activeProfileId", type: "text", description: "The one in use." },
      { path: "$showFullscreen", type: "yes/no", description: "Fullscreen is possible here." },
      { path: "$fullscreen", type: "yes/no", description: "In fullscreen." },
      { path: "$signedIn", type: "yes/no", description: "Signed in with a passkey." },
      { path: "$username", type: "text", description: "The account's username." },
    ],
    actions: [
      { name: "openRoom", description: "Open the Room window." },
      { name: "switchProfile", description: "Connect the picked saved connection (a select's change).", event: "change" },
      { name: "toggleFullscreen", description: "Fullscreen on / off." },
    ],
    slots: [
      { name: "signedIn", description: "The signed-in badge (nothing when signed out)." },
      { name: "menu", description: "The menu — designed in the Menu builder." },
    ],
    refs: [],
  },
  chat: {
    description: "The window under the bar: the info bar, the conversation (file cards, messages, the empty state) and the composer.",
    vars: [
      { path: "$notice", type: "text", description: "The last notice." },
      { path: "$room", type: "text", description: "The room." },
      { path: "$myIdShort", type: "text", description: "The end of my peer id." },
      { path: "$connected", type: "yes/no", description: "Connected (or connecting)." },
      { path: "$copied", type: "yes/no", description: "The room was just copied." },
      { path: "$transfers", type: "list", description: "File transfers in progress (for the file card part)." },
      { path: "$empty", type: "yes/no", description: "No messages yet." },
      { path: "$emptyTitle", type: "text", description: "The empty state's title (the old template)." },
      { path: "$emptyBody", type: "text", description: "The empty state's text (the old template)." },
      { path: "$messages", type: "list", description: "The messages shown (for the message part)." },
      { path: "$hiddenMessages", type: "number", description: "Earlier messages not shown." },
      { path: "$newestFirst", type: "yes/no", description: "Newest at the top." },
      { path: "$showEarlierText", type: "text", description: "“Show N earlier”." },
      { path: "$hiddenCount", type: "number", description: "6.2: messages I hid (for now)." },
      { path: "$showHidden", type: "yes/no", description: "6.2: hidden messages are shown too." },
      { path: "$showHiddenText", type: "text", description: "6.2: “Show hidden (N)” / “Hide them again (N)”." },
    ],
    actions: [
      { name: "disconnect", description: "Disconnect from the room." },
      { name: "copyRoom", description: "Copy the room's name." },
      { name: "openRoom", description: "Open the Room window." },
      { name: "showEarlier", description: "Show earlier messages." },
      { name: "toggleHidden", description: "6.2: show / hide again the messages I hid." },
    ],
    slots: [
      { name: "transfer", description: "A file transfer card.", arg: "a transfer ($tr)" },
      { name: "message", description: "A message — its layout is Incoming / Outgoing / System message.", arg: "a message ($m)" },
      { name: "composer", description: "The composer — its own layout." },
    ],
    refs: [
      { name: "dock", description: "The info bar (its bottom edge docks the recipients widget)." },
      { name: "end", description: "The end of the conversation (scrolled into view)." },
    ],
  },
  "message.in": { description: "A message from someone else.", vars: MESSAGE_VARS, actions: MESSAGE_ACTIONS, slots: [{ name: "badge", description: "The sender's badge (avatar, name, their colours and info)." }], refs: [{ name: "root", description: "The message (for “read” and vanishing timers)." }] },
  "message.out": { description: "My own message.", vars: MESSAGE_VARS, actions: MESSAGE_ACTIONS, slots: [], refs: [{ name: "root", description: "The message (for “read” and vanishing timers)." }] },
  "message.sys": { description: "A system notice (joined, left, keys…).", vars: MESSAGE_VARS, actions: MESSAGE_ACTIONS, slots: [], refs: [{ name: "root", description: "The message (for “read” and vanishing timers)." }] },
  composer: {
    description: "Writing and sending: the quoted message, emoji, attachments, the field, send options and who receives it.",
    vars: [
      { path: "$replyTo", type: "object", description: "Replying to: .id, .senderName, .text." },
      { path: "$emojiOpen", type: "yes/no", description: "The emoji row is open." },
      { path: "$emojis", type: "list", description: "The quick emoji." },
      { path: "$filesOn", type: "yes/no", description: "The files module is on for this user." },
      { path: "$openPeerCount", type: "number", description: "People connected (attachments need someone)." },
      { path: "$room", type: "text", description: "The room." },
      { path: "$placeholder", type: "text", description: "The field's placeholder (the old template)." },
      { path: "$messageInput", type: "text", description: "What is typed (bind it as the field's value)." },
      { path: "$everyone", type: "yes/no", description: "Sending to everyone in the room." },
      { path: "$recipientNames", type: "text", description: "Who receives it, when not everyone." },
    ],
    actions: [
      { name: "submit", description: "Send (the form's submit).", event: "submit" },
      { name: "input", description: "The field changed (keeps $messageInput).", event: "change" },
      { name: "keydown", description: "A key in the field (Enter sends).", event: "keydown" },
      { name: "toggleEmoji", description: "Emoji row on / off." },
      { name: "insertEmoji", description: "Insert an emoji.", arg: "the emoji" },
      { name: "pickFile", description: "Choose a file." },
      { name: "pickImage", description: "Choose an image." },
      { name: "attachment", description: "A file was chosen (the hidden inputs).", event: "change" },
      { name: "replyJump", description: "Scroll to the quoted message." },
      { name: "cancelReply", description: "Stop replying." },
    ],
    slots: [
      { name: "recorder", description: "The voice message recorder." },
      { name: "sendOptions", description: "The send button with its options (tap, vanish, seal)." },
    ],
    refs: [
      { name: "fileInput", description: "The hidden file input (pickFile clicks it)." },
      { name: "imageInput", description: "The hidden image input (pickImage clicks it)." },
    ],
  },
  widget: {
    description: "The recipients panel — floating, or docked to the left, right or bottom edge: people, latency, who receives, the room, its settings.",
    vars: [
      { path: "$title", type: "text", description: "The title (the old template)." },
      { path: "$locked", type: "yes/no", description: "Docked to an edge (any — kept for layouts made before 6.0)." },
      { path: "$docked", type: "yes/no", description: "Docked to an edge (6.0)." },
      { path: "$dock", type: "text", description: "The edge: none (floating), left, right or bottom." },
      { path: "$dockLabel", type: "text", description: "The edge, in words (Free, Left, Right, Bottom)." },
      { path: "$dockIcon", type: "text", description: "An icon for the edge (move, panel-left, panel-right, panel-bottom)." },
      { path: "$dockOptions", type: "list", description: "The edges to choose from: .id, .label, .icon, .current." },
      { path: "$showDockMenu", type: "yes/no", description: "The edge chooser is open." },
      { path: "$autoHide", type: "yes/no", description: "Docked and sliding into its edge behind a handle (the handle is the widget.handle layout); no: pinned." },
      { path: "$hidden", type: "yes/no", description: "Slid into its edge right now." },
      { path: "$room", type: "text", description: "The room." },
      { path: "$autoRoom", type: "yes/no", description: "Sending to everyone." },
      { path: "$appearance", type: "object", description: "Position, size, opacity, zoom and colour the user set (use as “CSS from data”; docked, the edge holder places and slides it)." },
      { path: "$showConfig", type: "yes/no", description: "The settings are open." },
      { path: "$configRows", type: "list", description: "Settings: .key, .label, .min, .max, .step, .value, .display." },
      { path: "$accent", type: "text", description: "The colour the user picked." },
      { path: "$accentValue", type: "text", description: "The colour for a colour input." },
      { path: "$hasPeers", type: "yes/no", description: "Anybody here." },
      { path: "$peers", type: "list", description: "People: .id, .name, .avatar, .status, .away, .online, .reachable, .checked, .disabled, .tone, .rttTitle, .bars (.on, .height); 6.7: .presence (online, away or far — for the status dot), .presenceLabel, .seenText (“Last seen 12 min ago”)." },
    ],
    actions: [
      { name: "startDrag", description: "Start moving the panel (pointer down on the head): a docked one undocks, dropped near an edge it docks there.", event: "pointerdown" },
      { name: "toggleConfig", description: "Settings on / off." },
      { name: "toggleLock", description: "Dock (to the right edge, on a phone the bottom) / undock — the button of layouts made before 6.0." },
      { name: "toggleDockMenu", description: "The edge chooser on / off." },
      { name: "setDock", description: "Dock to an edge (or float).", arg: "none, left, right or bottom" },
      { name: "dockChange", description: "The edge chosen in a select (its value: none, left, right, bottom).", event: "change" },
      { name: "togglePin", description: "Pinned / auto-hide (docked)." },
      { name: "autoHideChange", description: "Auto-hide checkbox changed.", event: "change" },
      { name: "minimize", description: "Minimise to the button." },
      { name: "configChange", description: "A setting's range changed.", arg: "the setting's key", event: "change" },
      { name: "accentChange", description: "The colour changed.", event: "change" },
      { name: "accentReset", description: "Back to the default colour." },
      { name: "peerInfo", description: "A person's details.", arg: "their id" },
      { name: "togglePeer", description: "Receives / does not.", arg: "their id" },
      { name: "roomInfo", description: "The room's details." },
      { name: "toggleAuto", description: "Everyone / chosen people." },
      { name: "selectAll", description: "Choose everybody." },
      { name: "selectNone", description: "Choose nobody." },
    ],
    slots: [],
    refs: [],
  },
  "widget.fab": {
    description: "The minimised recipients widget: one button with a count.",
    vars: [
      { path: "$title", type: "text", description: "The title." },
      { path: "$count", type: "number", description: "People who can receive." },
      { path: "$pos", type: "object", description: "Its position (use as “CSS from data”)." },
      { path: "$locked", type: "yes/no", description: "Docked." },
      { path: "$room", type: "text", description: "The room." },
      { path: "$autoRoom", type: "yes/no", description: "Sending to everyone." },
    ],
    actions: [
      { name: "fabDrag", description: "Start moving it.", event: "pointerdown" },
      { name: "fabClick", description: "Open the widget (not after a drag)." },
    ],
    slots: [],
    refs: [],
  },
  "widget.handle": {
    description: "6.0: the tab a docked, auto-hidden recipients widget leaves on its edge — hover it or tap it and the panel slides out. The icon and the count are yours to change; the timing, Escape and the click outside stay with the app.",
    vars: [
      { path: "$edge", type: "text", description: "The edge it sits on: left, right or bottom." },
      { path: "$count", type: "number", description: "People who can receive." },
      { path: "$open", type: "yes/no", description: "The panel is slid out (use as aria-expanded)." },
      { path: "$label", type: "text", description: "Its accessible name: the title and the count." },
      { path: "$panelId", type: "text", description: "The panel's id (use as aria-controls)." },
      { path: "$title", type: "text", description: "The widget's title." },
      { path: "$room", type: "text", description: "The room." },
      { path: "$autoRoom", type: "yes/no", description: "Sending to everyone." },
    ],
    actions: [
      { name: "reveal", description: "Slide the panel out — or back in when it is out (keyboard focus moves into it)." },
    ],
    slots: [],
    refs: [],
  },
  // 4.13
  ...WINDOW_CONTRACTS,
  ...ROOM_CONTRACTS,
  "room.bar": ROOM_BAR_CONTRACT,
  "phone.bridge": PHONE_BRIDGE_CONTRACT,
  ...DIALOG_CONTRACTS,
  ...ACCOUNT_CONTRACTS,
  ...SETTINGS_CONTRACTS,
  ...TOOL_CONTRACTS,
  ...SHARE_CONTRACTS,
  ...PHONE_CONTRACTS,
  ...CONNECTION_CONTRACTS,
  ...AI_CONTRACTS,
};
