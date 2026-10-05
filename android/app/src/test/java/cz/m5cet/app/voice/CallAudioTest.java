package cz.m5cet.app.voice;

import static org.junit.Assert.assertEquals;

import android.media.AudioFormat;

import org.junit.Test;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * 6.14: voice ↔ text in calls — what I write is spoken into the call through
 * the capture callback. The phone's voice (24 kHz) said into a 48 kHz call
 * was cut at half (the device's frame counter was compared with the speech's
 * length); now every sample is said, the next utterance right after it.
 */
public class CallAudioTest {
    /** The capture callback over `buffers` buffers of `frames` frames (16-bit, `channels`); what went to WebRTC. */
    static short[] capture(CallAudio a, int rate, int channels, int frames, int buffers) {
        short[] said = new short[buffers * frames * channels];
        int bytes = frames * channels * 2;
        for (int n = 0; n < buffers; n++) {
            ByteBuffer b = ByteBuffer.allocateDirect(bytes).order(ByteOrder.LITTLE_ENDIAN);
            for (int i = 0; i < frames * channels; i++) b.putShort(i * 2, (short) 12_345); // the microphone: replaced
            a.onCapture(b, AudioFormat.ENCODING_PCM_16BIT, channels, rate, bytes, 0);
            for (int i = 0; i < frames * channels; i++) said[n * frames * channels + i] = b.getShort(i * 2);
        }
        return said;
    }

    static short[] ramp(int n, int from) {
        short[] s = new short[n];
        for (int k = 0; k < n; k++) s[k] = (short) (from + k);
        return s;
    }

    @Test public void a24kHzVoiceIsSaidWholeIntoA48kHzCall() {
        CallAudio a = new CallAudio();
        a.start((peer, text, source) -> { });
        short[] first = ramp(2400, 1); // 100 ms at 24 kHz
        short[] second = ramp(1200, 5000); // 50 ms
        a.enqueue(first, 24_000);
        a.enqueue(second, 24_000);
        short[] said = capture(a, 48_000, 1, 480, 20); // 200 ms in 10 ms buffers
        // 150 ms of speech = 7200 frames at 48 kHz: each sample twice, the second right after the first.
        for (int f = 0; f < 4800; f++) assertEquals("frame " + f, first[f / 2], said[f]);
        for (int f = 0; f < 2400; f++) assertEquals("frame " + (4800 + f), second[f / 2], said[4800 + f]);
        for (int f = 7200; f < said.length; f++) assertEquals("frame " + f, 0, said[f]); // then silence
    }

    @Test public void everyChannelSaysIt() {
        CallAudio a = new CallAudio();
        a.start((peer, text, source) -> { });
        short[] voice = ramp(240, 1); // 10 ms at 24 kHz
        a.enqueue(voice, 24_000);
        short[] said = capture(a, 48_000, 2, 480, 2);
        for (int f = 0; f < 480; f++) {
            assertEquals(voice[f / 2], said[f * 2]);
            assertEquals(voice[f / 2], said[f * 2 + 1]);
        }
        for (int i = 960; i < said.length; i++) assertEquals(0, said[i]);
    }

    @Test public void aFasterVoiceIntoASlowerDeviceIsUnchanged() {
        // 24 kHz into 16 kHz: nearest sample, the utterance over after its last sample (as before).
        CallAudio a = new CallAudio();
        a.start((peer, text, source) -> { });
        short[] voice = ramp(2400, 1); // 100 ms = 1600 frames at 16 kHz
        a.enqueue(voice, 24_000);
        short[] said = capture(a, 16_000, 1, 160, 12);
        for (int f = 0; f < 1600; f++) assertEquals("frame " + f, voice[f * 3 / 2], said[f]);
        for (int f = 1600; f < said.length; f++) assertEquals("frame " + f, 0, said[f]);
    }
}
