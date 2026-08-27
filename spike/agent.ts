/**
 * Day-1 spike — proves the four load-bearing assumptions in one run:
 *   1. ADK-TS workflow agents exist (SequentialAgent)
 *   2. Gemini works via Vertex AI from TS
 *   3. Grafana MCP server connects as an MCPToolset (stdio, docker)
 *   4. Read (query_prometheus) AND write (create_annotation) both work
 *
 * Run:  cd spike && npm install && npx adk run agent.ts
 * Then prompt it: "check grafana"
 *
 * Env required (see docs/day1-notes.md):
 *   GRAFANA_URL, GRAFANA_SERVICE_ACCOUNT_TOKEN
 *   GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION, GOOGLE_GENAI_USE_VERTEXAI=true
 *   (or GEMINI_API_KEY for a quick non-Vertex smoke test first)
 */

import { LlmAgent, MCPToolset, SequentialAgent } from '@google/adk';

const grafana = (toolFilter?: string[]) =>
  new MCPToolset(
    {
      type: 'StdioConnectionParams',
      serverParams: {
        command: 'docker',
        args: [
          'run', '--rm', '-i',
          '-e', `GRAFANA_URL=${process.env.GRAFANA_URL ?? ''}`,
          '-e', `GRAFANA_SERVICE_ACCOUNT_TOKEN=${process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN ?? ''}`,
          'mcp/grafana', '-t', 'stdio',
        ],
      },
    },
    toolFilter,
  );

const reader = new LlmAgent({
  name: 'read_proof',
  model: 'gemini-flash-latest',
  description: 'Proves Grafana MCP reads work',
  instruction:
    'Call query_prometheus against the default datasource with the query "up" (instant). ' +
    'Report exactly which tool you called and the raw result row count.',
  tools: [grafana(['query_prometheus', 'list_datasources'])],
});

const writer = new LlmAgent({
  name: 'write_proof',
  model: 'gemini-flash-latest',
  description: 'Proves Grafana MCP writes work',
  instruction:
    'Call create_annotation with the text "adbreak day-1 spike — hello from ADK-TS" and tag "adbreak-spike". ' +
    'Report the annotation id returned. If the tool is missing or errors, say FAILED and quote the error verbatim.',
  tools: [grafana(['create_annotation'])],
});

// The judged pattern in miniature: control flow is code, the LLM only fills in steps.
export const rootAgent = new SequentialAgent({
  name: 'adbreak_spike',
  description: 'read-then-write proof against Grafana Cloud via MCP',
  subAgents: [reader, writer],
});
