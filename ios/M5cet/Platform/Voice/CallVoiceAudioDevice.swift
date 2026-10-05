// The call's audio device for WebRTC (RTCAudioDevice of Google's ObjC SDK, the
// stasel M150 build Platform/Calls uses) — the iOS counterpart of Android's
// JavaAudioDeviceModule callbacks that CallAudio and MicFx use:
//
//   microphone ─▶ VoiceProcessingIO (echo cancellation) ─▶ CallVoiceTaps.processCapture
//                 (voice changer, or the spoken text in voice ↔ text mode) ─▶ WebRTC (Opus, SRTP)
//   WebRTC (the peers' audio, mixed) ─▶ CallVoiceTaps.processPlayout (utterances for the
//                 transcription in voice ↔ text mode) ─▶ VoiceProcessingIO ─▶ speaker
//
// 16-bit mono at 48 kHz both ways (WebRTC resamples as it needs). The unit runs
// only while WebRTC wants playout or recording AND the audio session may play
// or record — with manual audio (CallAudioSession) that is after CallKit
// activated the session (RTCAudioSession isAudioEnabled → canPlayOrRecord), so
// CallKit keeps owning the session as with WebRTC's own device.
//
// WIRING (Platform/Calls, RtcEngine.factory — not done here, the file is theirs):
//     RTCPeerConnectionFactory(encoderFactory: …, decoderFactory: …, audioDevice: CallVoiceAudioDevice.shared)
// Without it WebRTC uses its built-in device and calls work as before, minus the
// voice changer and voice ↔ text (CallVoiceBridge.available is false).
//
// `synthetic` mode (tests): a 10 ms timer instead of the hardware — a generator
// fills the "microphone" and a sink receives what the "speaker" would play; the
// whole WebRTC path (encode, SRTP, ICE, decode, mix) runs for real.

import AudioToolbox
import AVFoundation
import Foundation
import M5Core
@preconcurrency import WebRTC

final class CallVoiceAudioDevice: NSObject, RTCAudioDevice, RTCAudioSessionDelegate, @unchecked Sendable {
    /// The app's device (hardware), for RtcEngine's factory.
    static let shared = CallVoiceAudioDevice(taps: .shared)

    /// A test's stand-in for the microphone and the speaker (called on the device's I/O queue).
    struct Synthetic: Sendable {
        /// Fills `count` mono samples of "microphone".
        var capture: @Sendable (UnsafeMutablePointer<Int16>, Int) -> Void
        /// Receives `count` mono samples the "speaker" plays.
        var playout: @Sendable (UnsafePointer<Int16>, Int) -> Void
    }

    static let sampleRate = 48_000.0
    private static let maxFrames = 4096

    let taps: CallVoiceTaps
    private let synthetic: Synthetic?
    private let lock = NSLock()

    // State (under `lock`).
    private var delegate: (any RTCAudioDeviceDelegate)?
    private var initialized = false
    private var playoutInitialized = false, recordingInitialized = false
    private var wantPlayout = false, wantRecording = false
    private var sessionAllows = false
    private var running = false
    private var unit: AudioUnit?
    private var timer: DispatchSourceTimer?

    // The I/O thread's (set before the I/O starts, cleared after it stopped).
    nonisolated(unsafe) private var deliver: RTCAudioDeviceDeliverRecordedDataBlock?
    nonisolated(unsafe) private var getPlayout: RTCAudioDeviceGetPlayoutDataBlock?
    nonisolated(unsafe) private var recordingNow = false
    nonisolated(unsafe) private var playingNow = false
    nonisolated(unsafe) private var sampleTime: Float64 = 0
    private let captureBuffer = UnsafeMutablePointer<Int16>.allocate(capacity: CallVoiceAudioDevice.maxFrames)
    private let playBuffer = UnsafeMutablePointer<Int16>.allocate(capacity: CallVoiceAudioDevice.maxFrames)
    private let queue = DispatchQueue(label: "cz.m5cet.call-audio", qos: .userInteractive)

    init(taps: CallVoiceTaps, synthetic: Synthetic? = nil) {
        self.taps = taps
        self.synthetic = synthetic
        super.init()
        captureBuffer.initialize(repeating: 0, count: Self.maxFrames)
        playBuffer.initialize(repeating: 0, count: Self.maxFrames)
        if synthetic == nil {
            let s = RTCAudioSession.sharedInstance()
            s.add(self)
            sessionAllows = !s.useManualAudio || s.isAudioEnabled
        } else {
            sessionAllows = true
        }
    }

    deinit {
        captureBuffer.deallocate()
        playBuffer.deallocate()
    }

    // MARK: RTCAudioDevice — formats

    var deviceInputSampleRate: Double { Self.sampleRate }
    var inputIOBufferDuration: TimeInterval { 0.01 }
    var inputNumberOfChannels: Int { 1 }
    var inputLatency: TimeInterval { 0 }
    var deviceOutputSampleRate: Double { Self.sampleRate }
    var outputIOBufferDuration: TimeInterval { 0.01 }
    var outputNumberOfChannels: Int { 1 }
    var outputLatency: TimeInterval { 0 }

    // MARK: RTCAudioDevice — life cycle

    var isInitialized: Bool { lock.withLock { initialized } }

    func initialize(with delegate: any RTCAudioDeviceDelegate) -> Bool {
        lock.withLock {
            self.delegate = delegate
            initialized = true
        }
        return true
    }

    func terminateDevice() -> Bool {
        stopIO()
        lock.withLock {
            wantPlayout = false; wantRecording = false
            playoutInitialized = false; recordingInitialized = false
            initialized = false
            delegate = nil
        }
        return true
    }

    var isPlayoutInitialized: Bool { lock.withLock { playoutInitialized } }
    func initializePlayout() -> Bool { lock.withLock { playoutInitialized = true }; return true }
    var isPlaying: Bool { lock.withLock { wantPlayout } }

    func startPlayout() -> Bool {
        lock.withLock { wantPlayout = true }
        update()
        return true
    }

    func stopPlayout() -> Bool {
        lock.withLock { wantPlayout = false }
        update()
        return true
    }

    var isRecordingInitialized: Bool { lock.withLock { recordingInitialized } }
    func initializeRecording() -> Bool { lock.withLock { recordingInitialized = true }; return true }
    var isRecording: Bool { lock.withLock { wantRecording } }

    func startRecording() -> Bool {
        lock.withLock { wantRecording = true }
        update()
        return true
    }

    func stopRecording() -> Bool {
        lock.withLock { wantRecording = false }
        update()
        return true
    }

    // MARK: RTCAudioSessionDelegate — CallKit activated / deactivated the session

    func audioSession(_ session: RTCAudioSession, didChangeCanPlayOrRecord canPlayOrRecord: Bool) {
        lock.withLock { sessionAllows = canPlayOrRecord }
        update()
    }

    func audioSessionDidEndInterruption(_ session: RTCAudioSession, shouldResumeSession: Bool) {
        // The unit stopped with the interruption: start it again when it should run.
        stopIO()
        update()
    }

    // MARK: running

    /// Starts or stops the I/O to match what WebRTC wants and what the session allows.
    private func update() {
        let (should, rec, play) = lock.withLock { ((wantPlayout || wantRecording) && sessionAllows && initialized, wantRecording, wantPlayout) }
        queue.async { [self] in
            recordingNow = rec
            playingNow = play
            if should { startIO() } else { stopIO() }
        }
    }

    private func startIO() {
        let (delegate, already) = lock.withLock { (self.delegate, running) }
        guard !already, let delegate else { return }
        deliver = delegate.deliverRecordedData
        getPlayout = delegate.getPlayoutData
        if synthetic != nil {
            let t = DispatchSource.makeTimerSource(queue: queue)
            t.schedule(deadline: .now(), repeating: .milliseconds(10), leeway: .milliseconds(1))
            t.setEventHandler { [weak self] in self?.syntheticTick() }
            lock.withLock { timer = t; running = true }
            t.resume()
            return
        }
        guard let u = makeUnit() else { M5Log.shared.warn("call", "voice processing unit not available"); return }
        lock.withLock { unit = u; running = true }
        let status = AudioOutputUnitStart(u)
        if status != noErr {
            M5Log.shared.warn("call", "voice processing unit did not start (\(status))")
            stopIO()
        }
    }

    private func stopIO() {
        let (t, u) = lock.withLock { () -> (DispatchSourceTimer?, AudioUnit?) in
            let r = (timer, unit)
            timer = nil; unit = nil; running = false
            return r
        }
        t?.cancel()
        if let u {
            AudioOutputUnitStop(u)
            AudioUnitUninitialize(u)
            AudioComponentInstanceDispose(u)
        }
    }

    // MARK: the I/O (the device's thread)

    private func syntheticTick() {
        guard let synthetic else { return }
        let n = Int(Self.sampleRate / 100)
        var flags = AudioUnitRenderActionFlags()
        var ts = AudioTimeStamp()
        ts.mSampleTime = sampleTime
        ts.mHostTime = mach_absolute_time()
        ts.mFlags = [.sampleTimeValid, .hostTimeValid]
        sampleTime += Float64(n)
        if recordingNow {
            synthetic.capture(captureBuffer, n)
            capture(&flags, &ts, frames: n)
        }
        if playingNow {
            var abl = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(n * 2), mData: playBuffer))
            render(&flags, &ts, frames: n, into: &abl)
            synthetic.playout(UnsafePointer(playBuffer), n)
        }
    }

    /// The microphone's samples (in `captureBuffer`) through the taps to WebRTC.
    fileprivate func capture(_ flags: UnsafeMutablePointer<AudioUnitRenderActionFlags>, _ ts: UnsafePointer<AudioTimeStamp>, frames n: Int) {
        taps.processCapture(captureBuffer, frames: n, channels: 1, rate: Int(Self.sampleRate))
        guard let deliver else { return }
        var abl = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(n * 2), mData: captureBuffer))
        _ = deliver(flags, ts, 1, UInt32(n), &abl, nil, nil)
    }

    /// WebRTC's playout into `abl`, then the taps.
    fileprivate func render(_ flags: UnsafeMutablePointer<AudioUnitRenderActionFlags>, _ ts: UnsafePointer<AudioTimeStamp>, frames n: Int,
                            into abl: UnsafeMutablePointer<AudioBufferList>) {
        guard let data = abl.pointee.mBuffers.mData?.assumingMemoryBound(to: Int16.self) else { return }
        if playingNow, let getPlayout {
            if getPlayout(flags, ts, 0, UInt32(n), abl) != noErr { data.update(repeating: 0, count: n) }
            taps.processPlayout(UnsafePointer(data), frames: n, channels: 1, rate: Int(Self.sampleRate))
        } else {
            data.update(repeating: 0, count: n)
        }
    }

    // MARK: VoiceProcessingIO

    private func makeUnit() -> AudioUnit? {
        var desc = AudioComponentDescription(componentType: kAudioUnitType_Output, componentSubType: kAudioUnitSubType_VoiceProcessingIO,
                                             componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0)
        guard let comp = AudioComponentFindNext(nil, &desc) else { return nil }
        var made: AudioUnit?
        guard AudioComponentInstanceNew(comp, &made) == noErr, let u = made else { return nil }
        var one: UInt32 = 1
        let u32 = UInt32(MemoryLayout<UInt32>.size)
        var ok = AudioUnitSetProperty(u, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &one, u32) == noErr
        ok = ok && AudioUnitSetProperty(u, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &one, u32) == noErr
        var fmt = AudioStreamBasicDescription(mSampleRate: Self.sampleRate, mFormatID: kAudioFormatLinearPCM,
                                              mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
                                              mBytesPerPacket: 2, mFramesPerPacket: 1, mBytesPerFrame: 2, mChannelsPerFrame: 1,
                                              mBitsPerChannel: 16, mReserved: 0)
        let fsize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        ok = ok && AudioUnitSetProperty(u, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, &fmt, fsize) == noErr // from the mic
        ok = ok && AudioUnitSetProperty(u, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 0, &fmt, fsize) == noErr  // to the speaker
        let me = Unmanaged.passUnretained(self).toOpaque()
        var input = AURenderCallbackStruct(inputProc: callVoiceInput, inputProcRefCon: me)
        var output = AURenderCallbackStruct(inputProc: callVoiceRender, inputProcRefCon: me)
        let csize = UInt32(MemoryLayout<AURenderCallbackStruct>.size)
        ok = ok && AudioUnitSetProperty(u, kAudioOutputUnitProperty_SetInputCallback, kAudioUnitScope_Global, 1, &input, csize) == noErr
        ok = ok && AudioUnitSetProperty(u, kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input, 0, &output, csize) == noErr
        ok = ok && AudioUnitInitialize(u) == noErr
        if !ok { AudioComponentInstanceDispose(u); return nil }
        return u
    }

    /// The input callback: render the microphone into `captureBuffer`, then on to WebRTC.
    fileprivate func input(_ flags: UnsafeMutablePointer<AudioUnitRenderActionFlags>, _ ts: UnsafePointer<AudioTimeStamp>, _ frames: UInt32) -> OSStatus {
        let n = Int(frames)
        guard n <= Self.maxFrames, let u = lock.withLock({ unit }) else { return noErr }
        var abl = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(n * 2), mData: captureBuffer))
        let status = AudioUnitRender(u, flags, ts, 1, frames, &abl)
        if status != noErr { return status }
        if recordingNow { capture(flags, ts, frames: n) }
        return noErr
    }
}

private func callVoiceInput(_ refCon: UnsafeMutableRawPointer, _ flags: UnsafeMutablePointer<AudioUnitRenderActionFlags>,
                            _ ts: UnsafePointer<AudioTimeStamp>, _ bus: UInt32, _ frames: UInt32,
                            _ data: UnsafeMutablePointer<AudioBufferList>?) -> OSStatus {
    Unmanaged<CallVoiceAudioDevice>.fromOpaque(refCon).takeUnretainedValue().input(flags, ts, frames)
}

private func callVoiceRender(_ refCon: UnsafeMutableRawPointer, _ flags: UnsafeMutablePointer<AudioUnitRenderActionFlags>,
                             _ ts: UnsafePointer<AudioTimeStamp>, _ bus: UInt32, _ frames: UInt32,
                             _ data: UnsafeMutablePointer<AudioBufferList>?) -> OSStatus {
    guard let data else { return noErr }
    Unmanaged<CallVoiceAudioDevice>.fromOpaque(refCon).takeUnretainedValue().render(flags, ts, frames: Int(frames), into: data)
    return noErr
}
