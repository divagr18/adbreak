/**
 * The agent's only route to Grafana. Every read and every write-back goes
 * through the Grafana MCP server — remove it and the agent is blind.
 *
 * Uses the MCP TypeScript SDK directly rather than ADK's MCPToolset, because
 * the deterministic steps (detect, verify) need to issue exact PromQL and get
 * typed numbers back, not hand a tool to a model and hope.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const MCP_URL = process.env.MCP_GRAFANA_URL ?? 'http://mcp-grafana:8000/sse';
export const PROM_UID = process.env.PROM_UID ?? 'grafanacloud-prom';

let client: Client | null = null;

export async function mcp(): Promise<Client> {
  if (client) return client;
  const c = new Client({ name: 'adbreak-agent', version: '1.0.0' }, { capabilities: {} });
  await c.connect(new SSEClientTransport(new URL(MCP_URL)));
  client = c;
  return c;
}

function textOf(result: unknown): string {
  const content = (result as { content?: { text?: string }[] }).content ?? [];
  return content.map((c) => c.text ?? '').join('');
}

export interface PromSeries {
  metric: Record<string, string>;
  value: number;
}

/** Instant PromQL through MCP. Returns every series, not just the first. */
export async function queryPrometheus(expr: string): Promise<PromSeries[]> {
  const c = await mcp();
  const res = await c.callTool({
    name: 'query_prometheus',
    arguments: {
      datasourceUid: PROM_UID,
      expr,
      queryType: 'instant',
      startTime: 'now',
      endTime: 'now',
    },
  });
  const parsed = JSON.parse(textOf(res)) as {
    data?: { metric?: Record<string, string>; value?: [number, string] }[];
  };
  return (parsed.data ?? [])
    .filter((d) => d.value)
    .map((d) => ({ metric: d.metric ?? {}, value: Number(d.value![1]) }));
}

/** Convenience for the many single-number queries the deterministic steps make. */
export async function scalar(expr: string): Promise<number | null> {
  const rows = await queryPrometheus(expr);
  return rows.length ? rows[0].value : null;
}

export async function queryLoki(logql: string, limit = 20): Promise<string[]> {
  const c = await mcp();
  const res = await c.callTool({
    name: 'query_loki_logs',
    arguments: { datasourceUid: process.env.LOKI_UID ?? 'grafanacloud-logs', logql, limit },
  });
  const parsed = JSON.parse(textOf(res)) as { data?: { line?: string }[] };
  return (parsed.data ?? []).map((d) => d.line ?? '');
}

/** Write-back: the audit trail the agent leaves in the operator's own tool. */
export async function createAnnotation(text: string, tags: string[]): Promise<void> {
  const c = await mcp();
  await c.callTool({ name: 'create_annotation', arguments: { text, tags } });
}

export async function createIncident(
  title: string,
  severity: string,
  summary: string,
): Promise<string | null> {
  try {
    const c = await mcp();
    const res = await c.callTool({
      name: 'create_incident',
      arguments: { title, severity, roomPrefix: 'adbreak', status: 'active', summary },
    });
    return textOf(res).slice(0, 400);
  } catch {
    // Grafana IRM may not be enabled on every stack; the annotation and the
    // written postmortem are the durable record either way.
    return null;
  }
}

export async function listTools(): Promise<string[]> {
  const c = await mcp();
  const res = await c.listTools();
  return res.tools.map((t) => t.name);
}
