# Owned generated media

These three seconds of 160x90 H.264 baseline video and AAC sine audio were
produced locally with FFmpeg 9.0.2. They contain no camera recording, external
media, NVR address, credentials or private session data. They are project-owned
test assets under the repository license.

Reproduce from the repository root (only overwrites these owned fixture files):

```sh
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i testsrc2=size=160x90:rate=10 \
  -f lavfi -i sine=frequency=440:sample_rate=48000 -t 3 \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -profile:v baseline -g 10 \
  -c:a aac -b:a 32k -f hls -hls_time 1 -hls_playlist_type vod \
  -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4 \
  -hls_segment_filename tests/fixtures/media/segment-%d.m4s \
  tests/fixtures/media/generated.m3u8
```

`node tests/unit/hls/browser-smoke.mjs` serves these assets only from an ephemeral
loopback fixture and requires installed Chromium (override `LIGHTNVR_CHROMIUM`).
The generated cookie is temporary, never written to a public fixture or logged.
This service models the protocol shapes; it does not run lightNVR or prove its
compatibility. Real integration remains T10.
