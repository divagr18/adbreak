// chaos-injector: POST /inject {fault, params, duration_s} → drives fault
// hooks in other services; writes ground-truth.jsonl (agent never reads it,
// the eval harness does). Day 4: F07 first.
import { createService } from '@adbreak/shared';

const svc = createService('chaos-injector');
svc.start(Number(process.env.PORT ?? 3000));
