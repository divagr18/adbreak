# Generates the ad creative HLS sets used by the SSAI stitcher.
# Profile MUST mirror plant/encoder/entrypoint.sh exactly (1280x720@30, x264
# high@3.1, AAC 48k stereo, 4s GOP-aligned segments) or stitched ads will not
# play cleanly across the discontinuity.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'creatives'
New-Item -ItemType Directory -Force $out | Out-Null

$font = '/usr/share/fonts/dejavu/DejaVuSans.ttf'

$ads = @(
  @{ id = 'ad-a'; advertiser = 'Northwind Beverages'; seconds = 12; color = '0x1a3d7c'; label = 'ADBREAK AD A' },
  @{ id = 'ad-b'; advertiser = 'Contoso Motors';      seconds = 16; color = '0x7c1a2f'; label = 'ADBREAK AD B' }
)

foreach ($ad in $ads) {
  $dir = Join-Path $out $ad.id
  New-Item -ItemType Directory -Force $dir | Out-Null
  Write-Host "encoding $($ad.id) ($($ad.seconds)s)..."
  docker run --rm -v "${out}:/out" --entrypoint ffmpeg adbreak-encoder `
    -hide_banner -loglevel error `
    -f lavfi -i "color=c=$($ad.color):s=1280x720:r=30:d=$($ad.seconds)" `
    -f lavfi -i "sine=frequency=440:duration=$($ad.seconds):sample_rate=48000" `
    -vf "drawtext=fontfile=${font}:text='$($ad.label)':fontcolor=white:fontsize=72:x=(w-text_w)/2:y=(h-text_h)/2,drawtext=fontfile=${font}:text='%{eif\:t\:d}s':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=h/2+80" `
    -c:v libx264 -preset veryfast -profile:v high -level 3.1 `
    -b:v 2800k -maxrate 2996k -bufsize 4200k `
    -g 120 -keyint_min 120 -sc_threshold 0 `
    -c:a aac -b:a 128k -ar 48000 -ac 2 `
    -f hls -hls_time 4 -hls_playlist_type vod `
    -hls_segment_filename "/out/$($ad.id)/seg_%03d.ts" `
    "/out/$($ad.id)/playlist.m3u8"
}

# Catalog consumed by the ad-decision-server.
$catalog = $ads | ForEach-Object {
  [pscustomobject]@{
    id         = $_.id
    advertiser = $_.advertiser
    durationS  = $_.seconds
    playlist   = "/hls/creatives/$($_.id)/playlist.m3u8"
  }
}
# UTF-8 *without* BOM — Out-File -Encoding utf8 emits a BOM that breaks JSON.parse.
[System.IO.File]::WriteAllText(
  (Join-Path $out 'index.json'),
  ($catalog | ConvertTo-Json -Depth 3),
  (New-Object System.Text.UTF8Encoding $false)
)
Write-Host "wrote $out\index.json"
