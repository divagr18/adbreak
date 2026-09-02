/**
 * The /trace view. Its whole job is to make "deterministic" legible in ten
 * seconds: every step the agent took, in order, with the actual PromQL it
 * issued, what came back, how long it took and what it cost.
 *
 * Written for someone arriving cold. A judge or an on-call engineer who has
 * never seen this before should be able to tell, without reading the source,
 * what the agent concluded and why — and, where it declined to act, what
 * stopped it. Raw step output is kept one click away rather than dumped in
 * their face, because the summary is the point and the JSON is the evidence.
 *
 * Server-rendered strings on purpose — no build step, no framework, nothing
 * between the run record and what you see.
 */
import type { AgentRun, StepRecord } from './run.js';

const esc = (s: unknown): string =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const REPO = 'https://github.com/divagr18/adbreak';

const CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { background:#0d1117; color:#d5dae2; margin:0; padding:0 20px 60px;
  font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace; }
.wrap { max-width:1180px; margin:0 auto; }
header { padding:30px 0 22px; border-bottom:1px solid #1e242e; margin-bottom:24px; }
h1 { font-size:20px; letter-spacing:.01em; margin:0 0 6px; }
h1 .thin { color:#7d8694; font-weight:400; }
h2 { font-size:13px; margin:30px 0 10px; color:#8b95a4; font-weight:600;
  text-transform:uppercase; letter-spacing:.07em; }
.tag { font-size:12.5px; color:#7d8694; }
a { color:#6ea8fe; text-decoration:none; } a:hover { text-decoration:underline; }
.lede { color:#9aa4b2; margin:10px 0 0; max-width:74ch; font-size:13.5px; }
.lede strong { color:#d5dae2; font-weight:600; }

table { border-collapse:collapse; width:100%; font-size:13px; }
th,td { text-align:left; padding:9px 11px; border-bottom:1px solid #1a2029; vertical-align:top; }
th { color:#6f7885; font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.06em; }
tbody tr:hover { background:#11161e; }

pre { background:#12161d; border:1px solid #1e242e; border-radius:6px; padding:10px 12px;
  overflow-x:auto; margin:8px 0 0; white-space:pre-wrap; word-break:break-word; font-size:12.5px; }
pre.q { color:#8fd18f; border-color:#1f3324; background:#101a13; }

.pill { display:inline-block; padding:1px 9px; border-radius:999px; font-size:11.5px;
  border:1px solid; white-space:nowrap; }
.ok   { color:#6ee7a8; border-color:#245c40; background:#10251b; }
.bad  { color:#ff8f8f; border-color:#5c2424; background:#251010; }
.warn { color:#ffd479; border-color:#5c4a24; background:#251f10; }
.mut  { color:#9aa4b2; border-color:#2b323d; background:#161b23; }
.llm  { color:#c9a8ff; border-color:#3d2b5c; background:#1a1425; }

.cards { display:flex; gap:12px; flex-wrap:wrap; margin:18px 0 4px; }
.card { flex:1 1 150px; border:1px solid #1e242e; border-radius:8px; padding:12px 14px; background:#11161e; }
.card .l { color:#6f7885; font-size:11px; text-transform:uppercase; letter-spacing:.06em; }
.card .v { font-size:21px; margin-top:3px; }
.card .n { color:#6f7885; font-size:11.5px; margin-top:2px; }

.banner { border-radius:8px; padding:14px 16px; margin:20px 0; border:1px solid; }
.banner.hold { border-color:#5c4a24; background:#1f1a0e; }
.banner h3 { margin:0 0 5px; font-size:14px; color:#ffd479; }
.banner p { margin:0; color:#c8b78a; font-size:13px; }
.banner form { margin-top:12px; }
button { font:inherit; font-weight:600; cursor:pointer; padding:8px 18px; border-radius:6px;
  border:1px solid #6ee7a8; background:#10251b; color:#6ee7a8; font-size:13px; }
button:hover { background:#163226; }

.step { border:1px solid #1e242e; border-radius:8px; margin:10px 0; overflow:hidden; }
.step > summary { cursor:pointer; padding:11px 14px; background:#11161e; list-style:none;
  display:flex; gap:12px; align-items:baseline; flex-wrap:wrap; }
.step > summary::-webkit-details-marker { display:none; }
.step > summary:hover { background:#141a23; }
.step .n { color:#6f7885; min-width:18px; }
.step .name { font-weight:600; min-width:150px; }
.step .said { color:#9aa4b2; flex:1 1 300px; font-size:12.5px; }
.step .meta { color:#6f7885; font-size:12px; }
.step .body { padding:2px 14px 14px; }

.ev { margin:6px 0 0; padding-left:18px; color:#9aa4b2; font-size:12.5px; }
.ev li { margin:3px 0; }
.pre-l { color:#6f7885; font-size:11px; text-transform:uppercase; letter-spacing:.06em; margin-top:12px; }
footer { margin-top:44px; padding-top:18px; border-top:1px solid #1e242e; color:#6f7885; font-size:12.5px; }
`;

const page = (title: string, body: string): string =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${esc(title)}</title><style>${CSS}</style><div class="wrap">${body}` +
  `<footer>AdBreak — an autonomous SRE agent whose SLO is revenue realization, not uptime. ` +
  `Diagnosis runs on Vertex AI Gemini through the ADK; every read of and write back to Grafana ` +
  `goes through the Grafana MCP server. <a href="${REPO}">Source</a>.</footer></div>`;

/** What an outcome means, in the words you would use to a colleague. */
const OUTCOME_MEANING: Record<string, string> = {
  remediated: 'fixed, and the fix was verified against live telemetry',
  awaiting_approval: 'diagnosed and planned, waiting for a human to approve',
  blocked_on_approval: 'approved, but the plant had moved and the plan no longer applied',
  blocked: 'a runbook applied but its safety preconditions were not met',
  no_action: 'investigated, and deliberately did nothing',
  failed: 'the fix ran but recovery was not observed, so it was rolled back',
  killed_by_watchdog: 'stopped by its own supervisor',
};

const outcomePill = (outcome: string): string => {
  const cls =
    outcome === 'remediated'
      ? 'ok'
      : outcome === 'failed' || outcome === 'blocked' || outcome === 'blocked_on_approval'
        ? 'bad'
        : outcome === 'no_action'
          ? 'mut'
          : 'warn';
  return `<span class="pill ${cls}">${esc(outcome)}</span>`;
};

const secs = (a?: string, b?: string): string =>
  a && b ? `${((Date.parse(b) - Date.parse(a)) / 1000).toFixed(1)}s` : '—';

const when = (iso: string): string => esc(iso.replace('T', ' ').slice(0, 19));

// ---------------------------------------------------------------------------

export function renderRunList(runs: AgentRun[]): string {
  const done = runs.filter((r) => r.outcome !== 'awaiting_approval');
  const remediated = runs.filter((r) => r.outcome === 'remediated').length;
  const held = runs.filter((r) => r.outcome === 'awaiting_approval');
  const escalated = runs.filter((r) => r.outcome === 'no_action').length;
  const stopped = runs.filter((r) => r.outcome === 'killed_by_watchdog').length;
  const spend = runs.reduce((sum, r) => sum + r.costUsd, 0);
  const verified = runs.filter((r) => r.verifiedAt);
  const meanMttr = verified.length
    ? verified.reduce((s, r) => s + (Date.parse(r.verifiedAt!) - Date.parse(r.detectedAt)) / 1000, 0) /
      verified.length
    : 0;

  const rows = runs
    .map(
      (r) => `<tr>
      <td><a href="/trace/${esc(r.runId)}">${esc(r.runId)}</a></td>
      <td>${when(r.detectedAt)}</td>
      <td>${esc(r.incident.deviceClass)}</td>
      <td>${esc(r.failureClass ?? '—')}</td>
      <td>${esc(r.runbookId ?? '—')}</td>
      <td>${esc(r.tier ?? '—')}</td>
      <td>${outcomePill(r.outcome)}</td>
      <td>${secs(r.detectedAt, r.verifiedAt ?? r.remediatedAt)}</td>
      <td>$${r.costUsd.toFixed(4)}</td>
    </tr>`,
    )
    .join('');

  // A plan waiting on a human is the single most interesting thing on this page,
  // so it is said at the top rather than left to be noticed in a table row.
  const holdBanner = held.length
    ? `<div class="banner hold">
         <h3>${held.length} plan${held.length > 1 ? 's are' : ' is'} waiting for a human</h3>
         <p>A channel-wide change is classified T2, which this agent will not make on its own.
            It has diagnosed the fault, chosen the runbook and rendered the plan — and stopped.
            Open ${held
              .map((r) => `<a href="/trace/${esc(r.runId)}">${esc(r.runId)}</a>`)
              .join(', ')} to read it and decide.</p>
       </div>`
    : '';

  return page(
    'AdBreak — agent runs',
    `<header>
       <h1>AdBreak <span class="thin">— agent runs</span></h1>
       <p class="lede">This agent watches a live ad-insertion pipeline for <strong>revenue leaks that
       every delivery dashboard reports as healthy</strong>. Each row is one incident it handled by
       itself: what it concluded, whether it acted, how long it took and what the reasoning cost.
       Open any run to see every step, including the exact PromQL it issued.</p>
     </header>

     ${holdBanner}

     <div class="cards">
       <div class="card"><div class="l">incidents handled</div><div class="v">${runs.length}</div>
         <div class="n">${done.length} concluded</div></div>
       <div class="card"><div class="l">fixed &amp; verified</div><div class="v">${remediated}</div>
         <div class="n">recovery confirmed on live telemetry</div></div>
       <div class="card"><div class="l">held for a human</div><div class="v">${held.length}</div>
         <div class="n">too wide a blast radius to self-approve</div></div>
       <div class="card"><div class="l">escalated</div><div class="v">${escalated}</div>
         <div class="n">no safe automatic remedy exists</div></div>
       <div class="card"><div class="l">stopped by watchdog</div><div class="v">${stopped}</div>
         <div class="n">its own supervisor intervened</div></div>
       <div class="card"><div class="l">mean detect→verified</div><div class="v">${meanMttr.toFixed(0)}s</div>
         <div class="n">bounded by the ad-break cadence</div></div>
       <div class="card"><div class="l">total reasoning spend</div><div class="v">$${spend.toFixed(2)}</div>
         <div class="n">across every run on this page</div></div>
     </div>

     <h2>Runs</h2>
     <table>
       <thead><tr><th>run</th><th>detected</th><th>device</th><th>class</th><th>runbook</th>
       <th>blast radius</th><th>outcome</th><th>detect→verified</th><th>cost</th></tr></thead>
       <tbody>${rows || '<tr><td colspan="9">No runs yet — the agent is watching.</td></tr>'}</tbody>
     </table>`,
  );
}

// ---------------------------------------------------------------------------

/** One line saying what this step concluded, so the trace reads without unfolding. */
function summarise(s: StepRecord): string {
  const o = (s.output ?? {}) as Record<string, unknown>;
  const str = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '');
  switch (s.step) {
    case 'triage':
      return `severity ${str('severity') || '?'} · stages worth checking: ${
        (o.suspectedStages as string[] | undefined)?.join(', ') || '?'
      }`;
    case 'hypothesize':
      return `${str('failureClass')} at the ${str('stage')} stage${
        typeof o.confidence === 'number' ? ` · confidence ${(o.confidence as number).toFixed(2)}` : ''
      }`;
    case 'falsify':
      return o.survived === false
        ? 'hypothesis REFUTED by its own probes'
        : 'hypothesis survived every attempt to kill it';
    case 'plan':
      if (typeof o.decision === 'string') return str('decision');
      return `${str('runbookId')} · blast radius ${str('blastRadiusTier')} · ${
        ((o.verdict as Record<string, string> | undefined)?.verdict) ?? '?'
      }`;
    case 'act':
      return o.executed === true ? 'runbook executed' : 'nothing executed';
    case 'verify':
      return o.recovered === true
        ? 'recovery confirmed on live telemetry'
        : 'recovery NOT observed within the runbook budget';
    case 'rollback':
      return 'change reverted — the fix did not achieve recovery';
    case 'approve':
      return `approved by ${str('approvedBy') || 'a human'}${
        (o.stale as string[] | undefined)?.length ? ' — but the plan had gone stale' : ''
      }`;
    case 'document':
      return o.failed === true ? 'write-up failed; the outcome above still stands' : 'incident written up';
    default:
      if (s.step.startsWith('correlate')) {
        const n = (o.findings as string[] | undefined)?.length ?? 0;
        return `${n} finding${n === 1 ? '' : 's'} from the ${str('branch') || 'correlation'} branch`;
      }
      return '';
  }
}

/** The fields worth reading in prose, before the raw JSON. */
function highlights(s: StepRecord): string {
  const o = (s.output ?? {}) as Record<string, unknown>;
  const list = (label: string, items?: unknown): string => {
    const arr = Array.isArray(items) ? (items as unknown[]) : [];
    if (arr.length === 0) return '';
    return `<div class="pre-l">${esc(label)}</div><ul class="ev">${arr
      .map((x) => `<li>${esc(typeof x === 'string' ? x : JSON.stringify(x))}</li>`)
      .join('')}</ul>`;
  };
  const para = (label: string, text?: unknown): string =>
    typeof text === 'string' && text
      ? `<div class="pre-l">${esc(label)}</div><div class="ev">${esc(text)}</div>`
      : '';

  return [
    para('cause', o.cause),
    para('reasoning', o.reasoning),
    list('supporting evidence', o.supportingEvidence),
    list('findings', o.findings),
    list('classes it tried to rule the hypothesis out with', o.testsAttempted),
    list('contradictions', o.contradictions),
    list('preconditions checked against live telemetry', o.preconditions),
  ].join('');
}

function renderStep(s: StepRecord, i: number): string {
  const kind = `<span class="pill ${s.kind === 'llm' ? 'llm' : 'mut'}">${esc(s.kind)}${
    s.model ? ` ${esc(s.model)}` : ''
  }</span>`;
  const cost = s.costUsd ? ` · $${s.costUsd.toFixed(4)}` : '';
  const tokens = s.tokens ? ` · ${s.tokens.input}in/${s.tokens.output}out` : '';
  const queries = s.queries?.length
    ? `<div class="pre-l">PromQL issued through the Grafana MCP server</div>` +
      `<pre class="q">${s.queries.map(esc).join('\n\n')}</pre>`
    : '';
  return `<details class="step"${i < 2 ? ' open' : ''}>
    <summary>
      <span class="n">${i + 1}</span>
      <span class="name">${esc(s.step)}</span>
      <span class="said">${esc(summarise(s))}</span>
      <span class="meta">${kind} · ${(s.durationMs / 1000).toFixed(1)}s${tokens}${cost}</span>
    </summary>
    <div class="body">
      ${highlights(s)}
      ${queries}
      <div class="pre-l">raw validated output</div>
      <pre>${esc(JSON.stringify(s.output, null, 2)).slice(0, 6000)}</pre>
    </div>
  </details>`;
}

export function renderRun(r: AgentRun): string {
  const steps = r.steps.map(renderStep).join('');
  const doc = [
    r.postmortem ? `<h2>Postmortem</h2><pre>${esc(r.postmortem)}</pre>` : '',
    r.cfoBrief ? `<h2>CFO brief</h2><pre>${esc(r.cfoBrief)}</pre>` : '',
    r.error ? `<h2>Error</h2><pre>${esc(r.error)}</pre>` : '',
  ].join('');

  // The gate holding a T2 plan is only meaningful if a human can say yes.
  // Approval re-checks the preconditions against live telemetry first, so this
  // is a request to re-evaluate and act, not a rubber stamp.
  const approve =
    r.outcome === 'awaiting_approval'
      ? `<div class="banner hold">
           <h3>This plan is waiting for you</h3>
           <p>The agent classified this change <strong>T2</strong> — it alters what every viewer on
              the channel is served — so it stopped rather than applying it. The plan, its predicted
              impact and its rollback are in the <em>plan</em> step below. Approving re-measures the
              runbook's preconditions against live telemetry first, because the plant has kept
              moving while this waited.</p>
           <form method="post" action="/trace/${esc(r.runId)}/approve">
             <button type="submit">Approve and execute</button>
           </form>
         </div>`
      : '';

  const meaning = OUTCOME_MEANING[r.outcome] ?? '';
  const card = (l: string, v: string, n = ''): string =>
    `<div class="card"><div class="l">${l}</div><div class="v">${v}</div>${
      n ? `<div class="n">${n}</div>` : ''
    }</div>`;

  return page(
    `AdBreak run ${r.runId}`,
    `<header>
       <h1><a href="/trace">← all runs</a> <span class="thin">/ ${esc(r.runId)}</span></h1>
       <div class="tag">${esc(r.incident.deviceClass)} · ${esc(r.incident.region)} ·
         detected ${when(r.detectedAt)}</div>
       <p class="lede">${outcomePill(r.outcome)} &nbsp; ${esc(meaning)}</p>
     </header>

     ${approve}

     <div class="cards">
       ${card('failure class', esc(r.failureClass ?? '—'), 'graded against a ledger the agent cannot read')}
       ${card('runbook', esc(r.runbookId ?? 'none'), r.runbookId ? 'chosen by lookup, never by the model' : 'nothing mapped — escalate')}
       ${card('blast radius', `${esc(r.tier ?? '—')}`, esc(r.verdict ?? ''))}
       ${card('detect→remediate', secs(r.detectedAt, r.remediatedAt), 'what the agent controls')}
       ${card('detect→verified', secs(r.detectedAt, r.verifiedAt), 'bounded by the break cadence')}
       ${card('reasoning cost', `$${r.costUsd.toFixed(4)}`, 'Vertex AI Gemini, this run')}
       ${r.approvedBy ? card('approved by', esc(r.approvedBy), 'preconditions re-checked first') : ''}
       ${r.watchdog ? card('watchdog', esc(r.watchdog.reason), 'its own supervisor stopped this run') : ''}
     </div>

     <h2>Every step, in order</h2>
     <div class="tag" style="margin-bottom:10px">Only the model steps are a model. Plan is a lookup
       table, the blast-radius gate is policy, and the watchdog is arithmetic.</div>
     ${steps}
     ${doc}`,
  );
}
