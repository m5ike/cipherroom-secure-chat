// The Layout builder's preview shows each layout in a few situations
// ("variants") with made-up people and messages. PURE data.

import type { LayoutId } from "./index";

export const PREVIEW_VARIANTS: Readonly<Record<LayoutId, ReadonlyArray<{ id: string; label: string }>>> = {
  header: [
    { id: "joined", label: "Connected" },
    { id: "idle", label: "Not connected" },
    { id: "offline", label: "Offline, reconnecting" },
    { id: "full", label: "Signed in, switcher, fullscreen" },
  ],
  chat: [
    { id: "messages", label: "A conversation" },
    { id: "empty", label: "Empty" },
    { id: "transfers", label: "With file transfers" },
    { id: "earlier", label: "Earlier messages hidden" },
  ],
  "message.in": [{ id: "all", label: "Every kind of message" }, { id: "text", label: "Text only" }],
  "message.out": [{ id: "all", label: "Every kind of message" }, { id: "text", label: "Text only" }],
  "message.sys": [{ id: "all", label: "Notices" }],
  composer: [
    { id: "plain", label: "Writing" },
    { id: "reply", label: "Replying" },
    { id: "emoji", label: "Emoji open" },
    { id: "private", label: "To chosen people" },
    { id: "alone", label: "Nobody connected" },
  ],
  widget: [
    { id: "people", label: "People" },
    { id: "config", label: "Settings open" },
    { id: "manual", label: "Chosen recipients" },
    { id: "empty", label: "Nobody here" },
  ],
  "widget.fab": [{ id: "floating", label: "Floating" }, { id: "docked", label: "Docked" }],
};

/** A 48 × 32 image for attachment previews (a small gradient PNG). */
export const SAMPLE_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAgCAYAAABU1PscAAAHP0lEQVR4nBXPwQYDBwIA0P2cHvaQwxxyyGEOOeSQQw5ziBUVFRU11qioUVGjoqKioqJGRUXFioo11qioqKioUVGjYuWQwxzyH7svh/cB728f/KP6399pEdCmQ0iXHn0GRAwZMWbClJiEGSlzMhYsWbFmQ86WHXsOHCkoOXHmwpWKGzV3HjxpePG3Dz4UoEVAmw4hXXr0GRAxZMSYCVNiEmakzMlYsGTFmg05W3bsOXCkoOTEmQtXKm7U3HnwpOH14TvwkQAtAtp0COnSo8+AiCEjxkyYEpMwI2VOxoIlK9ZsyNmyY8+BIwUlJ85cuFJxo+bOgycNr4/egY8FaBHQpkNIlx59BkQMGTFmwpSYhBkpczIWLFmxZkPOlh17DhwpKDlx5sKVihs1dx48aXh9/A58IkCLgDYdQrr06DMgYsiIMROmxCTMSJmTsWDJijUbcrbs2HPgSEHJiTMXrlTcqLnz4EnD65N34J8CtAho0yGkS48+AyKGjBgzYUpMwoyUORkLlqxYsyFny449B44UlJw4c+FKxY2aOw+eNLz++Q58KkCLgDYdQrr06DMgYsiIMROmxCTMSJmTsWDJijUbcrbs2HPgSEHJiTMXrlTcqLnz4EnD69N34DMBWgS06RDSpUefARFDRoyZMCUmYUbKnIwFS1as2ZCzZceeA0cKSk6cuXCl4kbNnQdPGl6fvQOfC9AioE2HkC49+gyIGDJizIQpMQkzUuZkLFiyYs2GnC079hw4UlBy4syFKxU3au48eNLw+vwd+EKAFgFtOoR06dFnQMSQEWMmTIlJmJEyJ2PBkhVrNuRs2bHnwJGCkhNnLlypuFFz58GThtcX78CXArQIaNMhpEuPPgMihowYM2FKTMKMlDkZC5asWLMhZ8uOPQeOFJScOHPhSsWNmjsPnjS8vnwHvhKgRUCbDiFdevQZEDFkxJgJU2ISZqTMyViwZMWaDTlbduw5cKSg5MSZC1cqbtTcefCk4fXVO/C1AC0C2nQI6dKjz4CIISPGTJgSkzAjZU7GgiUr1mzI2bJjz4EjBSUnzly4UnGj5s6DJw2vr9+BbwRoEdCmQ0iXHn0GRAwZMWbClJiEGSlzMhYsWbFmQ86WHXsOHCkoOXHmwpWKGzV3HjxpeH3zDnwrQIuANh1CuvToMyBiyIgxE6bEJMxImZOxYMmKNRtytuzYc+BIQcmJMxeuVNyoufPgScPr23fgOwFaBLTpENKlR58BEUNGjJkwJSZhRsqcjAVLVqzZkLNlx54DRwpKTpy5cKXiRs2dB08aXt+9A98L0CKgTYeQLj36DIgYMmLMhCkxCTNS5mQsWLJizYacLTv2HDhSUHLizIUrFTdq7jx40vD6/h34QYAWAW06hHTp0WdAxJARYyZMiUmYkTInY8GSFWs25GzZsefAkYKSE2cuXKm4UXPnwZOG1w/vwI8CtAho0yGkS48+AyKGjBgzYUpMwoyUORkLlqxYsyFny449B44UlJw4c+FKxY2aOw+eNLx+fAf+JUCLgDYdQrr06DMgYsiIMROmxCTMSJmTsWDJijUbcrbs2HPgSEHJiTMXrlTcqLnz4EnD61/vwE8CtAho0yGkS48+AyKGjBgzYUpMwoyUORkLlqxYsyFny449B44UlJw4c+FKxY2aOw+eNLx+egf+LUCLgDYdQrr06DMgYsiIMROmxCTMSJmTsWDJijUbcrbs2HPgSEHJiTMXrlTcqLnz4EnD69/vwH8EaBHQpkNIlx59BkQMGTFmwpSYhBkpczIWLFmxZkPOlh17DhwpKDlx5sKVihs1dx48aXj95x34WYAWAW06hHTp0WdAxJARYyZMiUmYkTInY8GSFWs25GzZsefAkYKSE2cuXKm4UXPnwZOG18/vwC8CtAho0yGkS48+AyKGjBgzYUpMwoyUORkLlqxYsyFny449B44UlJw4c+FKxY2aOw+eNLx+eQd+FaBFQJsOIV169BkQMWTEmAlTYhJmpMzJWLBkxZoNOVt27DlwpKDkxJkLVypu1Nx58KTh9es78JsALQLadAjp0qPPgIghI8ZMmBKTMCNlTsaCJSvWbMjZsmPPgSMFJSfOXLhScaPmzoMnDa/f3oHfBWgR0KZDSJcefQZEDBkxZsKUmIQZKXMyFixZsWZDzpYdew4cKSg5cebClYobNXcePGl4/f4O/CFAi4A2HUK69OgzIGLIiDETpsQkzEiZk7FgyYo1G3K27Nhz4EhByYkzF65U3Ki58+BJw+uPd+BPAVoEtOkQ0qVHnwERQ0aMmTAlJmFGypyMBUtWrNmQs2XHngNHCkpOnLlwpeJGzZ0HTxpef74DfwnQIqBNh5AuPfoMiBgyYsyEKTEJM1LmZCxYsmLNhpwtO/YcOFJQcuLMhSsVN2ruPHjS8PrrHfivAC0C2nQI6dKjz4CIISPGTJgSkzAjZU7GgiUr1mzI2bJjz4EjBSUnzly4UnGj5s6DJw0v/g+ZSl8Aroi3FQAAAABJRU5ErkJggg==";

export type SampleMessage = {
  id: string;
  kind: "in" | "out" | "sys";
  senderId: string;
  senderName: string;
  text: string;
  minutesAgo: number;
  extra?: Record<string, unknown>;
};

export const SAMPLE_MESSAGES: readonly SampleMessage[] = [
  { id: "s1", kind: "sys", senderId: "system", senderName: "M5cet", text: "Bob joined the room.", minutesAgo: 14 },
  { id: "i1", kind: "in", senderId: "p-bob", senderName: "Bob", text: "Hi! The plan is at https://example.org/plan — take a look.", minutesAgo: 12, extra: { secure: true } },
  { id: "o1", kind: "out", senderId: "me", senderName: "Alice", text: "Thanks, reading it now.", minutesAgo: 11, extra: { secure: true, deliveryState: "read" } },
  { id: "i2", kind: "in", senderId: "p-carol", senderName: "Carol", text: "Only for you two.", minutesAgo: 10, extra: { to: ["Alice", "Bob"] } },
  { id: "o2", kind: "out", senderId: "me", senderName: "Alice", text: "Agreed.", minutesAgo: 9, extra: { replyTo: { id: "i2", senderName: "Carol", text: "Only for you two." }, deliveryState: "delivered" } },
  { id: "i3", kind: "in", senderId: "p-bob", senderName: "Bob", text: "", minutesAgo: 8, extra: { attachment: { kind: "image", name: "whiteboard.png", mime: "image/png", size: 1843, dataUrl: SAMPLE_IMAGE } } },
  { id: "o3", kind: "out", senderId: "me", senderName: "Alice", text: "Minutes attached.", minutesAgo: 7, extra: { attachment: { kind: "file", name: "minutes.pdf", mime: "application/pdf", size: 48213, dataUrl: "data:application/pdf;base64,JVBERi0xLjQK" }, deliveryState: "stored" } },
  { id: "i4", kind: "in", senderId: "p-bob", senderName: "Bob", text: "Forwarding what Dan said.", minutesAgo: 6, extra: { forwardedFrom: "Dan" } },
  { id: "i5", kind: "in", senderId: "p-carol", senderName: "Carol", text: "Hold me to read.", minutesAgo: 5, extra: { flags: { tap: true } } },
  { id: "o4", kind: "out", senderId: "me", senderName: "Alice", text: "This disappears once read.", minutesAgo: 4, extra: { flags: { vanishSeconds: 60 }, deliveryState: "queued" } },
  { id: "i6", kind: "in", senderId: "p-bob", senderName: "Bob", text: "SEALED", minutesAgo: 3, extra: { flags: { sealed: { iv: "x", salt: "y" } } } },
  { id: "o5", kind: "out", senderId: "me", senderName: "Alice", text: "SEALED", minutesAgo: 2, extra: { flags: { sealed: { iv: "x", salt: "y" } }, ownPlaintext: "The door code is 4711.", sealCode: "714-203" } },
  { id: "i7", kind: "in", senderId: "p-dan", senderName: "Dan", text: "", minutesAgo: 1, extra: { vanished: true, vanishedAt: Date.UTC(2026, 8, 24, 9, 30) } },
  { id: "s2", kind: "sys", senderId: "system", senderName: "M5cet", text: "Keys renewed — Carol left the room.", minutesAgo: 0 },
];
