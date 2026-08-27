/**
 * OpenTelemetry bootstrap and the avail-lifecycle trace helpers.
 *
 * One trace per avail, spanning every service the ad signal touches. Trace
 * context is created at the true origin (playout) and handed down the chain
 * the same way the SCTE-35 signal is: on the cue bus, then inside the manifest
 * as an X-ADBREAK-TRACE daterange attribute, then over HTTP, then on the
 * beacon URL. That is what lets a metric spike in Grafana be followed to the
 * exact avail that caused it.
 *
 * Import this module FIRST in a service entrypoint, before anything that
 * issues HTTP, or auto-instrumentation will miss those clients.
 */
import {
  SpanStatusCode,
  context,
  trace,
  type Context,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

let started = false;

export function startTracing(serviceName: string): void {
  if (started) return;
  const endpoint = process.env.GC_OTLP_URL;
  const user = process.env.GC_OTLP_USER;
  const token = process.env.GC_TOKEN;
  if (!endpoint || !user || !token) {
    // Tracing is additive: the plant must still run without cloud credentials.
    return;
  }
  const auth = Buffer.from(`${user}:${token}`).toString('base64');
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    traceExporter: new OTLPTraceExporter({
      url: `${endpoint.replace(/\/$/, '')}/v1/traces`,
      headers: { Authorization: `Basic ${auth}` },
    }),
    // Per-avail spans are cheap; per-session ones are not. 200 sessions x 12
    // beacons per break would bury Tempo, so sample the high-cardinality ones.
    sampler: new TraceIdRatioBasedSampler(Number(process.env.TRACE_SAMPLE_RATIO ?? 1)),
    instrumentations: [new HttpInstrumentation()],
  });
  sdk.start();
  started = true;
  process.on('SIGTERM', () => void sdk.shutdown());
}

export const tracer = (name = 'adbreak'): Tracer => trace.getTracer(name);

/** W3C traceparent for a span, so context can ride a cue, manifest or URL. */
export function traceparentOf(span: Span): string {
  const c = span.spanContext();
  return `00-${c.traceId}-${c.spanId}-${c.traceFlags.toString(16).padStart(2, '0')}`;
}

/** Rebuild a parent Context from a traceparent carried in our own payloads. */
export function contextFromTraceparent(traceparent: string | undefined): Context {
  const active = context.active();
  if (!traceparent) return active;
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(traceparent.trim());
  if (!m) return active;
  return trace.setSpanContext(active, {
    traceId: m[1],
    spanId: m[2],
    traceFlags: parseInt(m[3], 16),
    isRemote: true,
  });
}

/** Run fn inside a span, recording failures, and always ending the span. */
export async function inSpan<T>(
  name: string,
  attrs: Record<string, string | number | boolean>,
  parent: Context | undefined,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  const span = tracer().startSpan(name, { attributes: attrs }, parent ?? context.active());
  try {
    return await context.with(trace.setSpan(parent ?? context.active(), span), () => fn(span));
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
    throw err;
  } finally {
    span.end();
  }
}

/**
 * Exemplar labels for the currently-active span, or undefined when nothing is
 * being traced. Attaching these to a counter or histogram is what lets a spike
 * on a Grafana panel jump straight to the trace of the avail behind it — the
 * metric -> exemplar -> trace -> log path the RCA depends on.
 */
export function exemplarLabels(span?: Span): { traceId: string; spanId: string } | undefined {
  const active = span ?? trace.getSpan(context.active());
  if (!active) return undefined;
  const c = active.spanContext();
  if (!c.traceId || c.traceId === '0'.repeat(32)) return undefined;
  return { traceId: c.traceId, spanId: c.spanId };
}

export { SpanStatusCode, context, trace, type Span };
