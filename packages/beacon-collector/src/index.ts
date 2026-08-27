// beacon-collector: the billing record. Dedupes tracking pings, appends
// confirmed impressions to JSONL, computes impression_gap_ratio. Day 3.
import { createService } from '@adbreak/shared';

const svc = createService('beacon-collector');
svc.start(Number(process.env.PORT ?? 3000));
