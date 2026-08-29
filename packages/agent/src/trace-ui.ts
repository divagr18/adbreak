/**
 * The /trace view. Its whole job is to make "deterministic" legible in ten
 * seconds: every step the agent took, in order, with the actual PromQL it
 * issued, what came back, how long it took and what it cost.
 *
 * Server-rendered strings on purpose — no build step, no framework, nothing
 * between the run record and what you see.
 */
import type { AgentRun, StepRecord } from './run.js';

const esc = (s: unknown): string =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const CSS = `
:root { color-scheme: dark; }
body { background:#0e1117; color:#d5dae2; font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace; margin:0; padding:28px; }
h1 { font-size:17px; letter-spacing:.02em; margin:0 0 4px; }
h2 { font-size:14px; margin:26px 0 8px; color:#9aa4b2; font-weight:600; }
a { color:#6ea8fe; text-decoration:none; } a:hover { text-decoration:underline; }
.sub { color:#7d8694; margin-bottom:22px; }
table { border-collapse:collapse; width:100%; }
th,td { text-align:left; padding:7px 10px; border-bottom:1px solid #1e242e; vertical-align:top; }
th { color:#7d8694; font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.05em; }
code,pre { font-family:inherit; }
pre { background:#141922; border:1px solid #1e242e; border-radius:6px; padding:10px 12px; overflow-x:auto; margin:6px 0 0; white-space:pre-wrap; word-break:break-word; }
.q { color:#8fd18f; }
.pill { display:inline-block; padding:1px 8px; border-radius:999px; font-size:12px; border:1px solid; }
.ok { color:#6ee7a8; border-color:#245c40; background:#10251b; }
.bad { color:#ff8f8f; border-color:#5c2424; background:#251010; }
.warn { color:#ffd479; border-color:#5c4a24; background:#251f10; }
.code { color:#9aa4b2; border-color:#2b323d; background:#161b23; }
.llm { color:#c9a8ff; border-color:#3d2b5c; background:#1a1425; }
.kv { display:flex; gap:26px; flex-wrap:wrap; margin-bottom:18px; }
.kv div { min-width:110px; } .kv .l { color:#7d8694; font-size:12px; } .kv .v { font-size:16px; }
`;

const page = (title: string, body: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style>${body}`;

const outcomePill = (outcome: string): string => {
  const cls = outcome === 'remediated' ? 'ok' : outcome === 'failed' || outcome === 'blocked' ? 'bad' : 'warn';
  return `<span class="pill ${cls}">${esc(outcome)}</span>`;
};

const secs = (a?: string, b?: string): string =>
  a && b ? `${((Date.parse(b) - Date.parse(a)) / 1000).toFixed(1)}s` : '—';

export function renderRunList(runs: AgentRun[]): string {
  const rows = runs
    .map(
      (r) => `<tr>
      <td><a href="/trace/${esc(r.runId)}">${esc(r.runId)}</a></td>
      <td>${esc(r.detectedAt.replace('T', ' ').slice(0, 19))}</td>
      <td>${esc(r.incident.deviceClass)}</td>
      <td>${esc(r.failureClass ?? '—')}</td>
      <td>${esc(r.runbookId ?? '—')}</td>
      <td>${outcomePill(r.outcome)}</td>
      <td>${secs(r.detectedAt, r.verifiedAt ?? r.remediatedAt)}</td>
      <td>$${r.costUsd.toFixed(4)}</td>
    </tr>`,
    )
    .join('');
  return page(
    'AdBreak — agent runs',
    `<h1>AdBreak — agent runs</h1>
     <div class="sub">Every incident the agent handled, newest first.</div>
     <table><tr><th>run</th><th>detected</th><th>device</th><th>class</th><th>runbook</th>
     <th>outcome</th><th>detect→verified</th><th>cost</th></tr>${rows ||
       '<tr><td colspan="8">no runs yet</td></tr>'}</table>`,
  );
}

function renderStep(s: StepRecord, i: number): string {
  const kind = `<span class="pill ${s.kind === 'llm' ? 'llm' : 'code'}">${esc(s.kind)}</span>`;
  const model = s.model ? ` ${esc(s.model)}` : '';
  const tokens = s.tokens ? `${s.tokens.input}in / ${s.tokens.output}out` : '—';
  const cost = s.costUsd ? `$${s.costUsd.toFixed(4)}` : '—';
  const queries = s.queries?.length
    ? `<pre class="q">${s.queries.map(esc).join('\n')}</pre>`
    : '';
  return `<tr>
    <td>${i + 1}</td>
    <td><strong>${esc(s.step)}</strong><br>${kind}${model}</td>
    <td>${(s.durationMs / 1000).toFixed(1)}s</td>
    <td>${esc(tokens)}<br>${esc(cost)}</td>
    <td>${queries}<pre>${esc(JSON.stringify(s.output, null, 2)).slice(0, 4000)}</pre></td>
  </tr>`;
}

export function renderRun(r: AgentRun): string {
  const steps = r.steps.map(renderStep).join('');
  const doc = [
    r.postmortem ? `<h2>Postmortem</h2><pre>${esc(r.postmortem)}</pre>` : '',
    r.cfoBrief ? `<h2>CFO brief</h2><pre>${esc(r.cfoBrief)}</pre>` : '',
    r.error ? `<h2>Error</h2><pre class="bad">${esc(r.error)}</pre>` : '',
  ].join('');
  return page(
    `AdBreak run ${r.runId}`,
    `<h1><a href="/trace">← runs</a> &nbsp; ${esc(r.runId)}</h1>
     <div class="sub">${esc(r.incident.deviceClass)} / ${esc(r.incident.region)} · detected ${esc(
       r.detectedAt.replace('T', ' ').slice(0, 19),
     )}</div>
     <div class="kv">
       <div><div class="l">outcome</div><div class="v">${outcomePill(r.outcome)}</div></div>
       <div><div class="l">failure class</div><div class="v">${esc(r.failureClass ?? '—')}</div></div>
       <div><div class="l">runbook</div><div class="v">${esc(r.runbookId ?? '—')}</div></div>
       <div><div class="l">blast radius</div><div class="v">${esc(r.tier ?? '—')} / ${esc(
         r.verdict ?? '—',
       )}</div></div>
       <div><div class="l">detect→remediate</div><div class="v">${secs(
         r.detectedAt,
         r.remediatedAt,
       )}</div></div>
       <div><div class="l">detect→verified</div><div class="v">${secs(
         r.detectedAt,
         r.verifiedAt,
       )}</div></div>
       <div><div class="l">cost</div><div class="v">$${r.costUsd.toFixed(4)}</div></div>
     </div>
     <table><tr><th>#</th><th>step</th><th>took</th><th>tokens/cost</th>
     <th>queries issued &amp; validated output</th></tr>${steps}</table>
     ${doc}`,
  );
}
