import type { AudioConfigPayload } from '../shared/api.ts'

const bridge = window.audioBridge

let ctx: AudioContext | null = null
let streams: MediaStream[] = []
let meterTimer: ReturnType<typeof setInterval> | null = null

function errorText(err: unknown): string {
  const e = err as DOMException
  if (e?.name === 'NotAllowedError') return 'access was blocked — check Windows Settings › Privacy › Microphone'
  if (e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError') return 'device not found (unplugged?)'
  return e?.message ?? String(err)
}

function peak(analyser: AnalyserNode, buf: Float32Array): number {
  analyser.getFloatTimeDomainData(buf)
  let max = 0
  for (const v of buf) max = Math.max(max, Math.abs(v))
  return Math.min(1, max)
}

async function stop(): Promise<void> {
  if (meterTimer) clearInterval(meterTimer)
  meterTimer = null
  streams.forEach((s) => s.getTracks().forEach((t) => t.stop()))
  streams = []
  if (ctx) await ctx.close().catch(() => undefined)
  ctx = null
}

async function start(cfg: AudioConfigPayload): Promise<{ started: string[]; errors: string[] }> {
  await stop()
  const started: string[] = []
  const errors: string[] = []

  ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'playback' })
  await ctx.audioWorklet.addModule('./pcm-worklet.js')
  const capture = new AudioWorkletNode(ctx, 'pcm-capture', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit'
  })
  capture.port.onmessage = (e: MessageEvent<Float32Array>) => bridge.pcm(e.data)

  // Limiter on the mix bus so loud system audio + voice never clips.
  const limiter = new DynamicsCompressorNode(ctx, { threshold: -1, knee: 0, ratio: 20, attack: 0.002, release: 0.1 })
  limiter.connect(capture)
  // The worklet only runs while something pulls on it, so route it to a silent output.
  const silent = new GainNode(ctx, { gain: 0 })
  capture.connect(silent).connect(ctx.destination)

  const meters: Record<'system' | 'mic', AnalyserNode | null> = { system: null, mic: null }
  const attach = (stream: MediaStream, volume: number, name: 'system' | 'mic'): void => {
    const source = ctx!.createMediaStreamSource(stream)
    const gain = new GainNode(ctx!, { gain: volume })
    const analyser = new AnalyserNode(ctx!, { fftSize: 1024 })
    source.connect(gain)
    gain.connect(limiter)
    gain.connect(analyser)
    streams.push(stream)
    meters[name] = analyser
    started.push(name)
  }

  if (cfg.system) {
    try {
      // Chromium's desktop source with audio = WASAPI loopback of everything the PC is playing.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'desktop' } },
        video: { mandatory: { chromeMediaSource: 'desktop', maxWidth: 16, maxHeight: 16, maxFrameRate: 1 } }
      } as unknown as MediaStreamConstraints)
      stream.getVideoTracks().forEach((t) => {
        t.stop()
        stream.removeTrack(t)
      })
      attach(stream, cfg.systemVolume, 'system')
    } catch (err) {
      errors.push(`Computer sound: ${errorText(err)}`)
    }
  }

  if (cfg.mic) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: cfg.mic === 'default' ? undefined : { exact: cfg.mic },
          echoCancellation: false,
          autoGainControl: false,
          noiseSuppression: cfg.noiseSuppression
        }
      })
      attach(stream, cfg.micVolume, 'mic')
    } catch (err) {
      errors.push(`Microphone: ${errorText(err)}`)
    }
  }

  const buf = new Float32Array(1024)
  meterTimer = setInterval(() => {
    bridge.levels({
      system: meters.system ? peak(meters.system, buf) : null,
      mic: meters.mic ? peak(meters.mic, buf) : null
    })
  }, 100)

  return { started, errors }
}

async function listDevices(): Promise<{ id: string; label: string }[]> {
  // Device labels are only exposed after microphone access has been granted once.
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true })
    s.getTracks().forEach((t) => t.stop())
  } catch {
    // Still list devices; labels may be generic.
  }
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices
    .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
    .map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }))
}

bridge.onStart((cfg) => start(cfg))
bridge.onStop(() => stop())
bridge.onListDevices(() => listDevices())
