// macOS helper for Screen Recorder.
//   mac-helper displays  -> JSON array of display IDs in the order FFmpeg's avfoundation numbers screens
//   mac-helper audio     -> streams computer sound (ScreenCaptureKit) to stdout as 48 kHz stereo float32 PCM
// Exits when stdin is closed by the parent process.

import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

setvbuf(stdout, nil, _IONBF, 0)
signal(SIGPIPE, SIG_IGN)

func fail(_ message: String, code: Int32) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(code)
}

func listDisplays() {
  var count: UInt32 = 0
  CGGetActiveDisplayList(0, nil, &count)
  var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
  CGGetActiveDisplayList(count, &ids, &count)
  print("[" + ids.prefix(Int(count)).map { String($0) }.joined(separator: ",") + "]")
}

@available(macOS 13.0, *)
final class SystemAudio: NSObject, SCStreamOutput, SCStreamDelegate {
  private let rate = 48000.0
  private let queue = DispatchQueue(label: "audio")
  private var stream: SCStream?
  private var timer: DispatchSourceTimer?
  private var start: Date?
  private var written: Int64 = 0

  func run() async throws {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let display = content.displays.first else { fail("No display available for audio capture", code: 5) }

    let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
    let config = SCStreamConfiguration()
    config.capturesAudio = true
    config.sampleRate = 48000
    config.channelCount = 2
    config.excludesCurrentProcessAudio = true
    // Video is required by ScreenCaptureKit but unused here, so keep it tiny and slow.
    config.width = 2
    config.height = 2
    config.minimumFrameInterval = CMTime(value: 1, timescale: 2)

    let stream = SCStream(filter: filter, configuration: config, delegate: self)
    try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
    try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: DispatchQueue(label: "video"))
    try await stream.startCapture()
    self.stream = stream

    // ScreenCaptureKit can pause delivery when nothing is playing; fill those gaps with
    // silence so the audio timeline keeps pace with the video.
    let t = DispatchSource.makeTimerSource(queue: queue)
    t.schedule(deadline: .now(), repeating: .milliseconds(50))
    t.setEventHandler { [weak self] in self?.padSilence() }
    t.resume()
    timer = t
  }

  private func emit(_ samples: UnsafeBufferPointer<Float>) {
    let bytes = UnsafeRawBufferPointer(samples)
    guard let base = bytes.baseAddress else { return }
    var offset = 0
    while offset < bytes.count {
      let n = Darwin.write(1, base + offset, bytes.count - offset)
      if n <= 0 { exit(0) }
      offset += n
    }
  }

  private func expectedFrames() -> Int64 {
    if start == nil { start = Date() }
    return Int64(Date().timeIntervalSince(start!) * rate)
  }

  private func padSilence() {
    let missing = expectedFrames() - written - Int64(0.1 * rate)
    guard missing > 0 else { return }
    let zeros = [Float](repeating: 0, count: Int(missing) * 2)
    zeros.withUnsafeBufferPointer { emit($0) }
    written += missing
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .audio, sampleBuffer.isValid,
          let format = sampleBuffer.formatDescription,
          let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee,
          asbd.mFormatID == kAudioFormatLinearPCM,
          asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0,
          asbd.mBitsPerChannel == 32
    else { return }

    // Drop audio that would run ahead of the wall clock (e.g. a burst after padding).
    if written - expectedFrames() > Int64(0.25 * rate) { return }

    let frames = sampleBuffer.numSamples
    let channels = max(1, Int(asbd.mChannelsPerFrame))
    let planar = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
    try? sampleBuffer.withAudioBufferList { list, _ in
      var out = [Float](repeating: 0, count: frames * 2)
      if planar {
        guard let l = list[0].mData?.assumingMemoryBound(to: Float.self) else { return }
        let r = list.count > 1 ? list[1].mData?.assumingMemoryBound(to: Float.self) ?? l : l
        for i in 0..<frames {
          out[2 * i] = l[i]
          out[2 * i + 1] = r[i]
        }
      } else {
        guard let p = list[0].mData?.assumingMemoryBound(to: Float.self) else { return }
        for i in 0..<frames {
          out[2 * i] = p[i * channels]
          out[2 * i + 1] = channels > 1 ? p[i * channels + 1] : p[i * channels]
        }
      }
      out.withUnsafeBufferPointer { emit($0) }
      written += Int64(frames)
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    fail("Audio capture stopped: \(error.localizedDescription)", code: 6)
  }
}

let command = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
switch command {
case "displays":
  listDisplays()
  exit(0)
case "audio":
  guard #available(macOS 13.0, *) else { fail("Recording computer sound needs macOS 13 or later", code: 3) }
  let audio = SystemAudio()
  Task {
    do {
      try await audio.run()
    } catch {
      fail(error.localizedDescription, code: 4)
    }
  }
  DispatchQueue.global().async {
    while getchar() != EOF {}
    exit(0)
  }
  withExtendedLifetime(audio) { dispatchMain() }
default:
  fail("usage: mac-helper displays|audio", code: 64)
}
