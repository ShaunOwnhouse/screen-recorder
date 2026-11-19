// Collects the mixed audio into ~100 ms interleaved stereo chunks and hands them to the page.
const CHUNK_FRAMES = 4800

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Float32Array(CHUNK_FRAMES * 2)
    this.n = 0
  }

  process(inputs) {
    const input = inputs[0] || []
    const left = input[0]
    const right = input[1] || left
    const frames = left ? left.length : 128
    for (let i = 0; i < frames; i++) {
      this.buf[this.n++] = left ? left[i] : 0
      this.buf[this.n++] = right ? right[i] : 0
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf, [this.buf.buffer])
        this.buf = new Float32Array(CHUNK_FRAMES * 2)
        this.n = 0
      }
    }
    return true
  }
}

registerProcessor('pcm-capture', PcmCapture)
