# Quality: what was measured, and what limits sharpness

The experiment lives in `scripts/quality/` (`bash scripts/quality/run.sh`). It renders realistic screen content (syntax-coloured
code, small text, thin lines, red/green/blue UI text), makes a lossless 1080p 60 fps clip scrolling at 5 px per frame, encodes it
many ways, and scores each result against the source **in RGB** (PSNR per colour channel, and SSIM).

## Video (1080p60, 3 s, CPU encoders so it runs anywhere)

| Setting | Size | PSNR (R / G / B) | SSIM |
| --- | --- | --- | --- |
| x264 `veryfast` CRF 10, 4:2:0 — what the CPU path records | 1.6 MB | 36.3 / 40.3 / 35.0 dB (avg 36.7) | 0.9932 |
| same, `slow` preset | 1.3 MB | 36.6 / 40.5 / 35.4 (37.0) | 0.9945 |
| `slow`, CRF 8 | 1.5 MB | 36.7 / 40.6 / 35.5 (37.1) | 0.9946 |
| `veryfast` CRF 10 with plain colour conversion | 1.6 MB | 36.3 / 40.3 / 35.0 (36.7) | 0.9933 |
| `veryfast` CRF 14 | 1.1 MB | 35.9 / 39.9 / 34.6 (36.3) | 0.9921 |
| `slow` CRF 10 + deblock −1:−1, aq-mode 3 | 1.4 MB | 36.6 / 40.6 / 35.4 (37.1) | 0.9945 |
| H.265 (the new save format) medium CRF 15 | 0.8 MB | 36.5 / 40.4 / 35.2 (36.9) | 0.9939 |
| **Studio 4:4:4** (VLC / editors only) | 1.0 MB | **40.5 / 41.2 / 40.0 (40.5)** | 0.9971 |
| **2× pixels before encoding** (4:2:0, plays in modern players) | 1.5 MB | **40.7 / 41.4 / 40.3 (40.8)** | 0.9979 |

**What this says**

- Every ordinary 4:2:0 setting lands within about 0.8 dB of the others. Lowering CRF (8 vs 10), a slower preset, deblock/AQ tuning and the
  colour-conversion flags change the score by tenths of a dB — the encoder's bit budget is not what limits sharpness.
- The limit is **chroma resolution**. In 4:2:0 the colour information has half the resolution of the picture in both directions, so
  coloured text edges soften. The signature is in the numbers: green (mostly brightness) scores ~40 dB while red and blue score ~35–36 dB.
- The two ways to remove that limit both gain about **+4 dB** on red and blue: full 4:4:4 colour (the *Studio* quality — but Windows Media Player,
  phones and most browsers can't play it) or encoding at twice the pixel size (colour then matches the screen's resolution and players scale it
  back down). The 2× route plays in modern players but pushes H.264 past what many decoders handle at 60 fps (4K60) and past the encoder limit for
  1440p and 4K screens (5120 / 7680 px), so it is not enabled by default.

Not measurable here: NVIDIA / Intel / AMD / Apple hardware encoders (no GPU in the test environment). Their settings follow the vendors'
documented quality options (NVENC `p7` + `hq` tune + adaptive quantisation + look-ahead + multipass at a constant-quality target).

## Screenshots (1080p app-style capture)

| Format | Size | Exact? |
| --- | --- | --- |
| PNG | 383 KB | yes — every pixel |
| WebP lossless | 52 KB | yes — decodes to the identical pixels (checked byte for byte) |
| JPEG, maximum quality, 4:4:4 | 443 KB | no — 43 dB (red 42.7, blue 42.0) |

For screenshots of text and apps, PNG or lossless WebP are both exact **and** usually smaller than JPEG. PNG stays the default because
it opens everywhere; WebP lossless is the same picture in a much smaller file for places that accept it.

## Where sharpness can still be lost

- **Colour edges in 4:2:0 video** (above). Use *Studio* for VLC/editors, or take a screenshot.
- **Scaling.** Output resolution defaults to *Native*; any scaling softens text. Upscaling adds pixels, not detail.
- **Re-encoding edits.** Trim/crop/convert re-encodes at a very high quality target; an unedited recording is moved untouched (or re-wrapped
  into MKV/MOV without re-encoding).
- **HDR displays.** Desktop capture of an HDR desktop can look washed out in SDR video; keep Windows HDR off while recording if colours look flat.
