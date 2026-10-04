// Notifications (6.7): the notifier as the server runs it — the stores, the
// three channels with their real transports, and the notifier over them.
// routes.ts (the main service) creates it once and hands it to the
// signaling hub (the away relay wakes members through it) and to the HTTP
// routes; anything else that wants to notify a signed-in user (a function's
// result, a call) uses notifierService().

import type { AccountStore } from "../accounts/store";
import { androidChannel, defaultAndroidDeps, defaultEmailDeps, defaultWebPushDeps, emailChannel, webPushChannel, type Channel } from "./channels";
import { notifyConfigStore, type NotifyConfigStore } from "./config";
import { Notifier } from "./dispatch";
import { notifyStore, type NotifyStore } from "./store";

export type NotifierService = { notifier: Notifier; channels: Channel[]; store: NotifyStore; config: NotifyConfigStore };

let current: NotifierService | null = null;

export function createNotifierService(accounts: AccountStore, present?: (accountId: string, room: string) => boolean): NotifierService {
  const store = notifyStore;
  const channels = [androidChannel(defaultAndroidDeps(store)), webPushChannel(defaultWebPushDeps(accounts)), emailChannel(defaultEmailDeps(store))];
  const notifier = new Notifier({ accounts, store, config: () => notifyConfigStore.get(), channels, present });
  current = { notifier, channels, store, config: notifyConfigStore };
  return current;
}

/** The running notifier (null before the main service set it up). */
export function notifierService(): NotifierService | null {
  return current;
}
