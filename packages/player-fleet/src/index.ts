// player-fleet: N synthetic sessions (device_class/region/cdn mix) that fetch
// personalized manifests through edge, "play" on a wall clock (no decode),
// and fire the six IAB beacon events. Day 3.
import { createService } from '@adbreak/shared';

const svc = createService('player-fleet');
svc.start(Number(process.env.PORT ?? 3000));
