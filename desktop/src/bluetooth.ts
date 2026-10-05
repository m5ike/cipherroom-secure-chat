// Web Bluetooth in the app (6.13.1) — pure. Electron cancels every
// navigator.bluetooth.requestDevice() unless the app answers the page's
// 'select-bluetooth-device' events, and those arrive repeatedly while the scan
// finds devices (each with the whole list so far). The picker collects them
// for a moment, then shows the native chooser with what it found (a BLE
// PN532: Nordic UART / HM-10 modules — the page's filters already applied);
// nothing found within the timeout cancels the request.

export type BtDevice = { deviceId: string; deviceName: string };

export type BluetoothPickerOptions = {
  /** How long to scan before the chooser opens (when something was found). */
  collectMs: number;
  /** Give up when nothing turns up. */
  timeoutMs: number;
  /** How often to look again while nothing was found. */
  pollMs: number;
};

export const BLUETOOTH_PICKER_DEFAULTS: BluetoothPickerOptions = { collectMs: 2500, timeoutMs: 15_000, pollMs: 500 };

type Active = {
  callback: (deviceId: string) => void;
  devices: Map<string, BtDevice>;
  started: number;
  timer: ReturnType<typeof setTimeout> | null;
  shown: boolean;
  done: boolean;
};

export class BluetoothPicker {
  private active: Active | null = null;
  /** Names of the devices seen last (the pairing prompt names the device). */
  readonly names = new Map<string, string>();
  private readonly opts: BluetoothPickerOptions;

  constructor(
    private readonly choose: (devices: BtDevice[]) => Promise<string | null>,
    private readonly nothingFound: () => void,
    opts: Partial<BluetoothPickerOptions> = {},
    private readonly now: () => number = () => Date.now(),
  ) {
    this.opts = { ...BLUETOOTH_PICKER_DEFAULTS, ...opts };
  }

  /** One 'select-bluetooth-device' event (the page's request; Electron repeats it as the scan goes on). */
  onEvent(devices: readonly BtDevice[], callback: (deviceId: string) => void): void {
    if (!this.active || this.active.done) {
      this.active = { callback, devices: new Map(), started: this.now(), timer: null, shown: false, done: false };
      this.schedule(this.opts.collectMs);
    } else {
      this.active.callback = callback;
    }
    for (const d of devices ?? []) {
      if (!d || typeof d.deviceId !== "string" || !d.deviceId) continue;
      const dev = { deviceId: d.deviceId.slice(0, 128), deviceName: String(d.deviceName ?? "").slice(0, 80) };
      this.active.devices.set(dev.deviceId, dev);
      if (dev.deviceName) this.names.set(dev.deviceId, dev.deviceName);
    }
  }

  /** The page navigated or closed: the request ends without a device. */
  cancel(): void {
    this.finish("");
  }

  /** A request is waiting for the user (tests). */
  get pending(): boolean {
    return Boolean(this.active && !this.active.done);
  }

  private schedule(ms: number): void {
    const a = this.active;
    if (!a) return;
    if (a.timer) clearTimeout(a.timer);
    a.timer = setTimeout(() => this.check(a), ms);
  }

  private check(a: Active): void {
    if (a.done || this.active !== a) return;
    a.timer = null;
    if (a.devices.size > 0) {
      a.shown = true;
      const list = [...a.devices.values()];
      void this.choose(list).then((id) => {
        if (this.active === a) this.finish(id && a.devices.has(id) ? id : "");
      }, () => { if (this.active === a) this.finish(""); });
      return;
    }
    if (this.now() - a.started >= this.opts.timeoutMs) {
      this.finish("");
      this.nothingFound();
      return;
    }
    this.schedule(this.opts.pollMs);
  }

  private finish(deviceId: string): void {
    const a = this.active;
    if (!a || a.done) return;
    a.done = true;
    if (a.timer) clearTimeout(a.timer);
    a.timer = null;
    this.active = null;
    try { a.callback(deviceId); } catch { /* the request is gone */ }
  }
}

/** A device's label in the chooser: its name, or its id when it has none. */
export function bluetoothLabel(d: BtDevice, unnamed: string): string {
  return d.deviceName ? d.deviceName : `${unnamed} (${d.deviceId.slice(0, 17)})`;
}
