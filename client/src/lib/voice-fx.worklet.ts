// The voice changer's AudioWorklet (6.7): runs voice-fx.ts on the
// microphone in the browser's audio thread. mic.ts loads it (Vite bundles it
// as its own file, "?worker&url" — same origin, so script-src 'self' holds),
// sends the parameters through the port ({ params }), and { close: true }
// when the stream ends. Mono out; several input channels are mixed down.

import { sanitizeFxParams, VoiceFx } from "./voice-fx";

// The AudioWorkletGlobalScope (not in lib.dom).
declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

type Options = { processorOptions?: { params?: unknown; seed?: number } };

class VoiceFxProcessor extends AudioWorkletProcessor {
  private readonly fx: VoiceFx;
  private mono = new Float32Array(128);
  private alive = true;

  constructor(options?: Options) {
    super(options);
    this.fx = new VoiceFx(sampleRate, sanitizeFxParams(options?.processorOptions?.params), options?.processorOptions?.seed ?? 1);
    this.port.onmessage = (e: MessageEvent) => {
      const d = (e.data ?? {}) as { params?: unknown; close?: boolean };
      if (d.params) this.fx.setParams(sanitizeFxParams(d.params));
      if (d.close) this.alive = false;
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0] ?? [];
    const output = outputs[0] ?? [];
    const frames = output[0]?.length ?? 128;
    if (this.mono.length !== frames) this.mono = new Float32Array(frames);
    const mono = this.mono;
    if (input.length === 0) mono.fill(0);
    else if (input.length === 1) mono.set(input[0]);
    else {
      for (let i = 0; i < frames; i++) {
        let s = 0;
        for (let c = 0; c < input.length; c++) s += input[c][i];
        mono[i] = s / input.length;
      }
    }
    this.fx.process(mono, mono);
    for (const ch of output) ch.set(mono);
    return this.alive;
  }
}

registerProcessor("m5-voice-fx", VoiceFxProcessor);
