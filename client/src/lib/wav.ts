// Audio → 16 kHz mono WAV, decoded by the browser (5.1). WAV is what every
// transcription model reads — the server's built-in offline engine without
// ffmpeg included — and 16 kHz is what Whisper hears anyway.

export async function toWav16k(blob: Blob): Promise<Blob> {
  if (/wav/.test(blob.type || "")) return blob;
  const W = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const Ctx = W.AudioContext || W.webkitAudioContext;
  if (!Ctx || typeof OfflineAudioContext === "undefined") return blob;
  try {
    const ctx = new Ctx();
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    void ctx.close();
    const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * 16000)), 16000);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const pcm = (await off.startRendering()).getChannelData(0);
    return new Blob([encodeWav(pcm, 16000)], { type: "audio/wav" });
  } catch {
    return blob;
  }
}

export function encodeWav(pcm: Float32Array, rate: number): ArrayBuffer {
  const buf = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) buf.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); buf.setUint32(4, 36 + pcm.length * 2, true); w(8, "WAVE");
  w(12, "fmt "); buf.setUint32(16, 16, true); buf.setUint16(20, 1, true); buf.setUint16(22, 1, true);
  buf.setUint32(24, rate, true); buf.setUint32(28, rate * 2, true); buf.setUint16(32, 2, true); buf.setUint16(34, 16, true);
  w(36, "data"); buf.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) buf.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 32767, true);
  return buf.buffer;
}
