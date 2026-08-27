// ssai: per-session personalized manifests — splices ad segments at cue
// boundaries with EXT-X-DISCONTINUITY + correct media-sequence handling.
// Day 3: session registry, ADS call, stitcher, beacon sidecar endpoint.
import { createService } from '@adbreak/shared';

const svc = createService('ssai');
svc.start(Number(process.env.PORT ?? 3000));
