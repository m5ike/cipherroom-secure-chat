// Calls helper: thin wrapper around getUserMedia + WebRTC track management.
// The encryption layer is the same DTLS-SRTP that browsers always use for
// WebRTC; this module only manages the local capture pipeline and exposes
// device enumeration so the UI can switch microphone/camera.

export type CallKind = "audio" | "video";
export type CallState = "off" | "joining" | "live" | "muted";

export type DeviceList = {
  audioInputs: MediaDeviceInfo[];
  videoInputs: MediaDeviceInfo[];
  audioOutputs: MediaDeviceInfo[];
};

export async function listDevices(): Promise<DeviceList> {
  try {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return { audioInputs: [], videoInputs: [], audioOutputs: [] };
    }
    const all = await navigator.mediaDevices.enumerateDevices();
    return {
      audioInputs: all.filter((d) => d.kind === "audioinput"),
      videoInputs: all.filter((d) => d.kind === "videoinput"),
      audioOutputs: all.filter((d) => d.kind === "audiooutput"),
    };
  } catch {
    return { audioInputs: [], videoInputs: [], audioOutputs: [] };
  }
}

export async function getCallStream(opts: {
  kind: CallKind;
  audioDeviceId?: string;
  videoDeviceId?: string;
}): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("getUserMedia is not available in this browser.");
  }
  const constraints: MediaStreamConstraints = {
    audio: opts.audioDeviceId ? { deviceId: { exact: opts.audioDeviceId } } : true,
  };
  if (opts.kind === "video") {
    constraints.video = opts.videoDeviceId
      ? { deviceId: { exact: opts.videoDeviceId } }
      : { width: { ideal: 1280 }, height: { ideal: 720 } };
  }
  return await navigator.mediaDevices.getUserMedia(constraints);
}

export function stopStream(stream: MediaStream | null) {
  if (!stream) return;
  stream.getTracks().forEach((track) => {
    try { track.stop(); } catch { /* ignore */ }
  });
}

export function setTrackEnabled(stream: MediaStream | null, kind: "audio" | "video", enabled: boolean) {
  if (!stream) return;
  stream.getTracks().filter((t) => t.kind === kind).forEach((t) => { t.enabled = enabled; });
}
