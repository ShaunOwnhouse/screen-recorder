#!/bin/bash
# Quality experiment: encodes the same lossless, scrolling screen-content clip (coloured code, small text, thin lines,
# UI) with different settings and scores every result against the source in RGB (PSNR per channel, SSIM).
# Run from the repo root:  bash scripts/quality/run.sh   (needs `npm ci` first; Chromium comes from playwright-core)
set -e
cd "$(dirname "$0")"
HERE=$(pwd)
REPO=$(cd ../.. && pwd)
FF=$(node -e 'console.log(require("'"$REPO"'/node_modules/ffmpeg-static"))')
WORK=${WORK:-/tmp/screen-snap-quality}
mkdir -p "$WORK" && cp "$HERE/content.html" "$WORK/" && cd "$WORK"

if [ ! -f src.mkv ]; then
  node -e '
    const { chromium } = require(process.argv[1] + "/node_modules/playwright-core");
    (async () => { const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
      await p.goto("file://" + process.cwd() + "/content.html"); await p.waitForTimeout(500);
      await p.screenshot({ path: "content.png", fullPage: true }); await b.close() })()' "$REPO"
  # 3 s at 60 fps, scrolling 5 px per frame: a lossless 1080p source
  $FF -hide_banner -v error -y -loop 1 -framerate 60 -i content.png -t 3 -vf "crop=1920:1080:0:'mod(t*300,4200)',format=bgr0" -c:v ffv1 src.mkv
fi

APP="scale=flags=lanczos+accurate_rnd+full_chroma_int+full_chroma_inp:out_color_matrix=bt709:out_range=tv,format=yuv420p"
DEF="scale=out_color_matrix=bt709:out_range=tv,format=yuv420p"
TAGS="-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv"
SS="scale=3840:2160:flags=neighbor,scale=flags=lanczos+accurate_rnd+full_chroma_int+full_chroma_inp:out_color_matrix=bt709:out_range=tv,format=yuv420p"
FPS="-fps_mode cfr -r 60 -g 120"

score() { # file, optional decode-filter
  local f=$1 pre=${2:-}
  local a="[0:v]trim=start_frame=5,setpts=N/60/TB,${pre}format=gbrp[a];[1:v]trim=start_frame=5,setpts=N/60/TB,format=gbrp[b]"
  local pl=$($FF -hide_banner -i "$f" -i src.mkv -lavfi "$a;[a][b]psnr" -f null - 2>&1 | grep "PSNR r:" | tail -1)
  local p=$(echo "$pl" | grep -o "average:[0-9.inf]*" | cut -d: -f2)
  local rb=$(echo "$pl" | sed -E 's/.*r:([0-9.]+) g:([0-9.]+) b:([0-9.]+).*/R \1 G \2 B \3/')
  local s=$($FF -hide_banner -i "$f" -i src.mkv -lavfi "$a;[a][b]ssim" -f null - 2>&1 | grep -o "All:[0-9.]*" | tail -1 | cut -d: -f2)
  echo "$p $s $rb"
}
run() { # name, description, pre-filter for scoring, then encode args
  local name=$1 desc=$2 pre=$3; shift 3
  local t0=$(date +%s.%N)
  $FF -hide_banner -v error -y -i src.mkv "$@" -an out_$name.mp4 || { echo "$name FAILED"; return; }
  local t1=$(date +%s.%N)
  local size=$(stat -c %s out_$name.mp4)
  read p s rb < <(score out_$name.mp4 "$pre")
  printf "%-20s %5.1f MB  PSNR %5.2f dB (%s)  SSIM %s  %4.1fs  %s\n" "$name" "$(echo "$size/1048576" | bc -l)" "$p" "$rb" "$s" "$(echo "$t1-$t0" | bc -l)" "$desc"
}

run A_app_veryfast10  "what the CPU path records today (x264 veryfast, CRF 10)"        "" -vf "$APP" -c:v libx264 -preset veryfast -crf 10 -profile:v high $TAGS $FPS
run B_slow10          "same, slower preset (what an export could use)"                 "" -vf "$APP" -c:v libx264 -preset slow -crf 10 -profile:v high $TAGS $FPS
run C_slow8           "slow preset, lower CRF 8"                                       "" -vf "$APP" -c:v libx264 -preset slow -crf 8 -profile:v high $TAGS $FPS
run D_default_scale   "veryfast CRF 10 but plain colour conversion (no accurate flags)" "" -vf "$DEF" -c:v libx264 -preset veryfast -crf 10 -profile:v high $TAGS $FPS
run E_veryfast14      "veryfast CRF 14 (smaller)"                                      "" -vf "$APP" -c:v libx264 -preset veryfast -crf 14 -profile:v high $TAGS $FPS
run F_slow_tuned      "slow CRF 10, deblock -1:-1, aq-mode 3"                          "" -vf "$APP" -c:v libx264 -preset slow -crf 10 -profile:v high -x264-params deblock=-1,-1:aq-mode=3 $TAGS $FPS
run G_supersample2x   "2× pixels before encoding (chroma at full source resolution)"  "scale=1920:1080:flags=area," -vf "$SS" -c:v libx264 -preset veryfast -crf 10 -profile:v high $TAGS $FPS
run H_studio444       "Studio 4:4:4 (VLC / editors only)"                              "" -vf "scale=flags=lanczos+accurate_rnd+full_chroma_int+full_chroma_inp:out_color_matrix=bt709:out_range=tv,format=yuv444p" -c:v libx264 -preset veryfast -crf 10 -profile:v high444 $TAGS $FPS
run I_hevc_medium15   "H.265 (the new save format) medium CRF 15"                      "" -vf "$APP" -c:v libx265 -preset medium -crf 15 -tag:v hvc1 -x265-params log-level=error $TAGS $FPS
