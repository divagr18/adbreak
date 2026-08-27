// ads: mock VAST 4.x ad decision server. Knobs: latency_ms, fill_rate.
// Day 2: VAST XML pods + tracking URLs + admin knobs (F03/F04 hooks).
import { createService } from '@adbreak/shared';

const svc = createService('ads');
svc.start(Number(process.env.PORT ?? 3000));
