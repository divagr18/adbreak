/**
 * Provisions the Grafana Cloud side as code: both dashboards and the RRR
 * burn-rate alert. Idempotent — re-run after editing dashboards/*.json.
 *
 *   npx tsx scripts/provision-grafana.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function env(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const E = env();
const GRAFANA = (E.GRAFANA_URL ?? '').replace(/\/$/, '');
const TOKEN = E.GRAFANA_SERVICE_ACCOUNT_TOKEN;
const PROM_UID = process.env.PROM_UID ?? 'grafanacloud-prom';

if (!GRAFANA || !TOKEN) throw new Error('GRAFANA_URL / GRAFANA_SERVICE_ACCOUNT_TOKEN missing from .env');

async function api(path: string, method: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${GRAFANA}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

/** Point every panel target at the Grafana Cloud Prometheus datasource. */
function withDatasource(dash: Record<string, unknown>): Record<string, unknown> {
  const ds = { type: 'prometheus', uid: PROM_UID };
  for (const panel of (dash.panels ?? []) as Record<string, unknown>[]) {
    panel.datasource = ds;
    for (const t of (panel.targets ?? []) as Record<string, unknown>[]) t.datasource = ds;
  }
  return dash;
}

async function provisionDashboards(): Promise<void> {
  const dir = join(ROOT, 'dashboards');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const dash = withDatasource(JSON.parse(readFileSync(join(dir, file), 'utf8')));
    const res = (await api('/api/dashboards/db', 'POST', {
      dashboard: { ...dash, id: null },
      overwrite: true,
      message: 'provisioned from dashboards/ as code',
    })) as { url?: string };
    console.log(`dashboard  ${file}  ->  ${GRAFANA}${res.url ?? ''}`);
  }
}

/**
 * The burn-rate alert. This is the trigger the agent runs on: RRR below the
 * SLO for two minutes means money is being lost right now, whatever the
 * delivery dashboards say.
 */
async function provisionAlert(): Promise<void> {
  const folderUid = 'adbreak';
  const folders = (await api('/api/folders', 'GET')) as { uid: string }[];
  if (!folders.some((f) => f.uid === folderUid)) {
    await api('/api/folders', 'POST', { uid: folderUid, title: 'AdBreak' });
  }

  const rule = {
    title: 'RRR burn rate — revenue below SLO',
    ruleGroup: 'adbreak-slo',
    folderUID: folderUid,
    noDataState: 'OK',
    execErrState: 'Error',
    for: '2m',
    labels: { severity: 'critical', slo: 'rrr', team: 'adbreak' },
    annotations: {
      summary: 'Revenue realization below 0.98 — ad inventory is being served but not earning.',
      description:
        'RRR = realized/expected over 15m, per channel/region/device class. Delivery health can be perfectly green while this fires; that is the point.',
    },
    condition: 'C',
    data: [
      {
        // 15m, per the stated SLO. A shorter window makes the ratio flap:
        // expected revenue is booked when the pod is decided, but the matching
        // impressions only land over the following ~45s, so a window holding a
        // partial break reads artificially low.
        refId: 'A',
        relativeTimeRange: { from: 1800, to: 0 },
        datasourceUid: PROM_UID,
        model: {
          refId: 'A',
          editorMode: 'code',
          instant: false,
          range: true,
          expr: 'sum by (channel, region, device_class) (increase(adbreak_revenue_realized_usd_total[15m])) / (sum by (channel, region, device_class) (increase(adbreak_revenue_expected_usd_total[15m])) > 0)',
        },
      },
      {
        refId: 'B',
        datasourceUid: '__expr__',
        model: {
          refId: 'B',
          type: 'reduce',
          datasource: { type: '__expr__', uid: '__expr__' },
          expression: 'A',
          reducer: 'last',
          settings: { mode: 'dropNN' },
        },
      },
      {
        refId: 'C',
        datasourceUid: '__expr__',
        model: {
          refId: 'C',
          type: 'threshold',
          datasource: { type: '__expr__', uid: '__expr__' },
          expression: 'B',
          conditions: [
            {
              type: 'query',
              evaluator: { type: 'lt', params: [0.98] },
              operator: { type: 'and' },
              query: { params: ['B'] },
              reducer: { type: 'last', params: [] },
            },
          ],
        },
      },
    ],
  };

  const existing = (await api('/api/v1/provisioning/alert-rules', 'GET')) as { uid: string; title: string }[];
  const prior = existing.find((r) => r.title === rule.title);
  if (prior) {
    await api(`/api/v1/provisioning/alert-rules/${prior.uid}`, 'PUT', { ...rule, uid: prior.uid });
    console.log(`alert      updated  ${rule.title}`);
  } else {
    await api('/api/v1/provisioning/alert-rules', 'POST', rule);
    console.log(`alert      created  ${rule.title}`);
  }
}

async function main(): Promise<void> {
  await provisionDashboards();
  await provisionAlert();
  console.log('\nprovisioned.');
}

void main();
