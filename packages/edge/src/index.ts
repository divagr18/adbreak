// edge: CDN simulator — reverse proxy in front of origin/ssai/beacon-collector
// with per-PoP / per-device-class fault rules (F07 blackhole, F08 5xx).
// Day 3: proxy + fault-rule table + cdn_requests_total.
import { createService } from '@adbreak/shared';

const svc = createService('edge');
svc.start(Number(process.env.PORT ?? 3000));
