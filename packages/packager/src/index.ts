// packager: consumes the cue bus, owns the content manifest, injects
// EXT-X-DATERANGE (SCTE35-OUT/IN) + CUE-OUT/CUE-IN at segment boundaries.
// Day 2: manifest rewrite engine (unit-tested against captured playlists).
import { createService } from '@adbreak/shared';

const svc = createService('packager');
svc.start(Number(process.env.PORT ?? 3000));
