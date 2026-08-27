#!/bin/bash
# Live HLS encoder: loops Big Buck Bunny (CC-BY, Blender Foundation) into a
# rolling live playlist. One 720p rendition for Phase A; ladder is post-Gate-A.
set -euo pipefail

SOURCE_DIR=/source
HLS_DIR=/hls/content
SOURCE_FILE="$SOURCE_DIR/bbb.mp4"
SOURCE_URL="${SOURCE_URL:-https://download.blender.org/demo/movies/BBB/bbb_sunflower_1080p_30fps_normal.mp4.zip}"

mkdir -p "$SOURCE_DIR" "$HLS_DIR"

if [ ! -s "$SOURCE_FILE" ]; then
  echo "downloading source clip..."
  curl -fL --retry 5 -o "$SOURCE_DIR/src.zip" "$SOURCE_URL"
  unzip -o "$SOURCE_DIR/src.zip" -d "$SOURCE_DIR"
  mv "$(find "$SOURCE_DIR" -name '*.mp4' | head -n1)" "$SOURCE_FILE"
  rm -f "$SOURCE_DIR/src.zip"
fi

# Master playlist (SSAI will serve per-session masters later; this one is for
# direct origin playback and the packager's reference).
cat > /hls/content/master.m3u8 <<'EOF'
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"
live.m3u8
EOF

# 4s segments, GOP-aligned (30fps * 4s = 120), PROGRAM-DATE-TIME on for
# DATERANGE alignment in the packager.
exec ffmpeg -hide_banner -loglevel warning \
  -re -stream_loop -1 -i "$SOURCE_FILE" \
  -vf "scale=1280:720,fps=30" \
  -c:v libx264 -preset veryfast -profile:v high -level 3.1 \
  -b:v 2800k -maxrate 2996k -bufsize 4200k \
  -g 120 -keyint_min 120 -sc_threshold 0 \
  -c:a aac -b:a 128k -ar 48000 -ac 2 \
  -f hls -hls_time 4 -hls_list_size 10 \
  -hls_flags delete_segments+independent_segments+program_date_time \
  -hls_segment_filename "$HLS_DIR/seg_%06d.ts" \
  "$HLS_DIR/live.m3u8"
