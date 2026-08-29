import { describe, expect, it } from 'vitest';
import { createService } from './service.js';

/**
 * Guards a bug that returned HTTP 500 from the ad server for every traced
 * session: prom-client only accepts the {labels, value, exemplarLabels} form
 * when the metric was created with enableExemplars. Without it, that object is
 * read as a labels object and throws — so the instrumentation broke the very
 * requests it was measuring.
 */
describe('metrics with exemplars', () => {
  const svc = createService('test-exemplars');
  const exemplar = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) };

  it('accepts the exemplar form on a counter when enabled', () => {
    const c = svc.counter({
      name: 'test_counter_total',
      help: 'test',
      labels: ['kind'] as const,
      enableExemplars: true,
    });
    expect(() =>
      c.inc({ labels: { kind: 'x' }, value: 1, exemplarLabels: exemplar }),
    ).not.toThrow();
  });

  it('accepts the exemplar form on a histogram when enabled', () => {
    const h = svc.histogram({
      name: 'test_histogram_seconds',
      help: 'test',
      labels: ['kind'] as const,
      buckets: [0.1, 1],
      enableExemplars: true,
    });
    expect(() =>
      h.observe({ labels: { kind: 'x' }, value: 0.5, exemplarLabels: exemplar }),
    ).not.toThrow();
  });

  it('rejects the exemplar form when NOT enabled — the trap this guards', () => {
    const c = svc.counter({ name: 'test_noexemplar_total', help: 'test', labels: ['kind'] as const });
    expect(() =>
      c.inc({ labels: { kind: 'x' }, value: 1, exemplarLabels: exemplar } as never),
    ).toThrow();
  });

  it('still accepts the plain form', () => {
    const c = svc.counter({ name: 'test_plain_total', help: 'test', labels: ['kind'] as const });
    expect(() => c.inc({ kind: 'x' })).not.toThrow();
  });
});
