// playout: owns the avail schedule; emits SCTE-35 cues on the Redis cue bus.
// Day 2: schedule loader + cue emission + avail_signaled_total + F01 suppress hook.
import { createService } from '@adbreak/shared';

const svc = createService('playout');
svc.start(Number(process.env.PORT ?? 3000));
