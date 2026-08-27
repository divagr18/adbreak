/**
 * Structured JSON lines to stdout — Loki-ready.
 * Every line carries `component`; pass avail_id/session_id in fields.
 */

type Fields = Record<string, unknown>;

export interface Logger {
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
}

export function logger(component: string): Logger {
  const emit = (severity: string, msg: string, fields?: Fields) => {
    process.stdout.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        component,
        severity,
        msg,
        ...fields,
      }) + '\n',
    );
  };
  return {
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  };
}
