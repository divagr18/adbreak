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
/* Type: a system sans for prose, monospace only where character alignment
   carries meaning - PromQL, JSON, ids, money, durations.
   Layout: generous whitespace and one clear hierarchy. A visitor should be able
   to answer "how much money did this catch" before reading a single row. */
:root {
  --bg:#0b0f14; --surface:#111823; --raised:#161e2b; --border:#1f2937;
  --text:#eef2f7; --muted:#9fabbb; --dim:#7b8798;
  --blue:#7cb0ff; --green:#5fd39a; --red:#ff9a9a; --amber:#f2c46a; --violet:#c4a6ff;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
  color-scheme: dark;
}
* { box-sizing:border-box; }
body { background:var(--bg); color:var(--text); margin:0; padding:0 28px 96px;
  font:15px/1.7 var(--sans); -webkit-font-smoothing:antialiased; }
.wrap { max-width:1060px; margin:0 auto; }

header { padding:72px 0 0; }
.eyebrow { color:var(--dim); font-size:12px; font-weight:650; letter-spacing:.12em;
  text-transform:uppercase; margin-bottom:18px; }
h1 { font-size:34px; line-height:1.2; letter-spacing:-.022em; margin:0; font-weight:660; max-width:20ch; }
h1 .thin { color:var(--muted); font-weight:400; }
.lede { color:var(--muted); margin:20px 0 0; max-width:62ch; font-size:16px; line-height:1.75; }
.lede strong { color:var(--text); font-weight:600; }
h2 { font-size:12px; margin:0 0 20px; color:var(--dim); font-weight:650;
  text-transform:uppercase; letter-spacing:.1em; }
section { margin-top:72px; }
a { color:var(--blue); text-decoration:none; }
a:hover { text-decoration:underline; text-underline-offset:3px; }
.tag { font:13px var(--mono); color:var(--dim); }

/* The headline number. Everything else on the page is subordinate to it. */
.hero { margin:52px 0 0; padding:36px 40px; border:1px solid var(--border); border-radius:16px;
  background:linear-gradient(160deg,#0f1922,#0d131b); }
.hero .l { color:var(--dim); font-size:12px; font-weight:650; letter-spacing:.1em; text-transform:uppercase; }
.hero .money { font:660 56px/1.05 var(--mono); letter-spacing:-.03em; margin:14px 0 0; color:var(--amber); }
.hero .money.good { color:var(--green); }
.hero .n { color:var(--muted); font-size:15px; margin-top:14px; max-width:56ch; line-height:1.7; }
.hero .split { display:flex; gap:56px; flex-wrap:wrap; margin-top:34px; padding-top:28px;
  border-top:1px solid var(--border); }
.hero .split div .l { font-size:11px; }
.hero .split div .v { font:600 24px/1.2 var(--mono); margin-top:8px; }

.cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:16px; }
.card { border:1px solid var(--border); border-radius:12px; padding:22px 24px; background:var(--surface); }
.card .l { color:var(--dim); font-size:11px; text-transform:uppercase; letter-spacing:.09em; font-weight:650; }
.card .v { font:600 30px/1.15 var(--mono); margin-top:10px; letter-spacing:-.02em; }
.card .n { color:var(--muted); font-size:13px; margin-top:8px; line-height:1.6; }

table { border-collapse:collapse; width:100%; font-size:14px; }
th,td { text-align:left; padding:16px 14px; border-bottom:1px solid var(--border); vertical-align:top; }
th { color:var(--dim); font-weight:650; font-size:11px; text-transform:uppercase; letter-spacing:.09em;
  padding-bottom:12px; }
.mono { font-family:var(--mono); font-size:13px; }
.num { font-family:var(--mono); font-size:13.5px; text-align:right; white-space:nowrap; }
th.num { text-align:right; }
.money-cell { font-family:var(--mono); font-size:14px; text-align:right; white-space:nowrap; color:var(--amber); }
.money-cell.zero { color:var(--dim); }
tbody tr:hover { background:var(--surface); }

pre { background:var(--surface); border:1px solid var(--border); border-radius:10px;
  padding:16px 18px; overflow-x:auto; margin:10px 0 0; white-space:pre-wrap; word-break:break-word;
  font:13px/1.65 var(--mono); color:var(--muted); }
pre.q { color:var(--green); border-color:#1e3a2a; background:#0d1a13; }

.pill { display:inline-block; padding:3px 11px; border-radius:999px; font-size:12px;
  font-weight:600; border:1px solid; white-space:nowrap; }
.ok{color:var(--green);border-color:#245c40;background:#0f2419}
.bad{color:var(--red);border-color:#5c2828;background:#241111}
.warn{color:var(--amber);border-color:#5c4a24;background:#241e10}
.mut{color:var(--muted);border-color:var(--border);background:var(--surface)}
.llm{color:var(--violet);border-color:#3d2b5c;background:#191325}

.banner { border-radius:14px; padding:26px 30px; margin:44px 0 0; border:1px solid var(--amber);
  background:linear-gradient(160deg,#241e10,#1a1710); }
.banner h3 { margin:0 0 10px; font-size:19px; color:var(--amber); font-weight:650; letter-spacing:-.01em; }
.banner p { margin:0; color:#dcc79a; font-size:15px; line-height:1.75; max-width:66ch; }
.banner form { margin-top:22px; }
button { font:600 15px var(--sans); cursor:pointer; padding:12px 26px; border-radius:10px;
  border:1px solid var(--green); background:#0f2419; color:var(--green); transition:background .12s; }
button:hover { background:#16311f; }
button:focus-visible { outline:2px solid var(--green); outline-offset:3px; }

.step { border:1px solid var(--border); border-radius:12px; margin:14px 0; overflow:hidden; background:var(--surface); }
.step > summary { cursor:pointer; padding:18px 22px; list-style:none;
  display:grid; grid-template-columns:26px 160px 1fr auto; gap:18px; align-items:baseline; }
.step > summary::-webkit-details-marker { display:none; }
.step > summary:hover { background:var(--raised); }
.step[open] > summary { border-bottom:1px solid var(--border); }
.step .n { color:var(--dim); font:13px var(--mono); }
.step .name { font-weight:650; font-size:15px; font-family:var(--mono); }
.step .said { color:var(--muted); font-size:14.5px; line-height:1.55; }
.step .meta { color:var(--dim); font:12px var(--mono); white-space:nowrap; }
.step .body { padding:8px 22px 26px; }
@media (max-width:780px){ .step>summary{grid-template-columns:22px 1fr} .step .said,.step .meta{grid-column:2} }

.ev { margin:8px 0 0; padding-left:22px; color:var(--muted); font-size:14.5px; line-height:1.7; }
.ev li { margin:7px 0; }
div.ev { padding-left:0; }
.pre-l { color:var(--dim); font-size:11px; text-transform:uppercase; letter-spacing:.09em;
  margin-top:24px; font-weight:650; }
footer { margin-top:88px; padding-top:28px; border-top:1px solid var(--border);
  color:var(--dim); font-size:13.5px; line-height:1.8; max-width:74ch; }
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
  const money = (n: number): string =>
    n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(2)}`;

  const remediated = runs.filter((r) => r.outcome === 'remediated').length;
  const held = runs.filter((r) => r.outcome === 'awaiting_approval');
  const escalated = runs.filter((r) => r.outcome === 'no_action').length;
  const stopped = runs.filter((r) => r.outcome === 'killed_by_watchdog').length;
  const priced = runs.filter((r) => typeof r.revenueAtRiskUsd === 'number');
  const caught = priced.reduce((sum, r) => sum + (r.revenueAtRiskUsd ?? 0), 0);
  // Only count as stopped what was actually verified as recovered.
  const stoppedLeak = runs
    .filter((r) => r.recovered === true && typeof r.revenueAtRiskUsd === 'number')
    .reduce((sum, r) => sum + (r.revenueAtRiskUsd ?? 0), 0);
  const spend = runs.reduce((sum, r) => sum + r.costUsd, 0);
  const verified = runs.filter((r) => r.verifiedAt);
  const meanMttr = verified.length
    ? verified.reduce((s, r) => s + (Date.parse(r.verifiedAt!) - Date.parse(r.detectedAt)) / 1000, 0) /
      verified.length
    : 0;

  const rows = runs
    .map((r) => {
      const atRisk = r.revenueAtRiskUsd;
      const cell =
        typeof atRisk === 'number'
          ? `<td class="money-cell${atRisk < 0.01 ? ' zero' : ''}">${money(atRisk)}</td>`
          : `<td class="money-cell zero">—</td>`;
      return `<tr>
        <td class="mono"><a href="/trace/${esc(r.runId)}">${esc(r.runId)}</a></td>
        <td class="mono">${when(r.detectedAt)}</td>
        <td>${esc(r.incident.deviceClass)}</td>
        <td class="mono">${esc(r.failureClass ?? '—')}</td>
        ${cell}
        <td>${outcomePill(r.outcome)}</td>
        <td class="num">${secs(r.detectedAt, r.verifiedAt ?? r.remediatedAt)}</td>
      </tr>`;
    })
    .join('');

  const holdBanner = held.length
    ? `<div class="banner">
         <h3>${held.length} plan${held.length > 1 ? 's are' : ' is'} waiting for a human</h3>
         <p>A channel-wide change is classified T2, which this agent will not make on its own. It has
            diagnosed the fault, chosen the runbook and rendered the plan &mdash; and stopped. Open
            ${held.map((r) => `<a href="/trace/${esc(r.runId)}">${esc(r.runId)}</a>`).join(', ')}
            to read it and decide.</p>
       </div>`
    : '';

  return page(
    'AdBreak — money not earned',
    `<header>
       <div class="eyebrow">AdBreak · revenue SRE for live streaming</div>
       <h1>A detector for <span class="thin">money the stream never earned.</span></h1>
       <p class="lede">Ad breaks fail quietly. The video keeps playing, every delivery dashboard
         stays green, and the impressions that were supposed to be billed simply never arrive.
         This agent watches for <strong>revenue that should have been realised and was not</strong>,
         finds the stage responsible, and repairs it &mdash; or stops and asks, when the fix would
         touch every viewer on the channel.</p>
     </header>

     <div class="hero">
       <div class="l">Unearned revenue caught</div>
       <div class="money">${money(caught)}</div>
       <div class="n">Ad inventory that was signalled, served, and never billed &mdash; measured
         across the fifteen minutes before each incident was detected. Every dollar here was
         invisible to delivery monitoring.</div>
       <div class="split">
         <div><div class="l">leak stopped &amp; verified</div>
              <div class="v" style="color:var(--green)">${money(stoppedLeak)}</div></div>
         <div><div class="l">incidents</div><div class="v">${runs.length}</div></div>
         <div><div class="l">mean time to verified fix</div><div class="v">${meanMttr.toFixed(0)}s</div></div>
         <div><div class="l">cost to run the agent</div><div class="v" style="color:var(--dim)">${money(spend)}</div></div>
       </div>
     </div>

     ${holdBanner}

     <section>
       <h2>What it did about them</h2>
       <div class="cards">
         <div class="card"><div class="l">fixed &amp; verified</div><div class="v" style="color:var(--green)">${remediated}</div>
           <div class="n">the fix was confirmed against live telemetry, not assumed</div></div>
         <div class="card"><div class="l">held for a human</div><div class="v" style="color:var(--amber)">${held.length}</div>
           <div class="n">too wide a blast radius for the agent to self-approve</div></div>
         <div class="card"><div class="l">escalated</div><div class="v">${escalated}</div>
           <div class="n">diagnosed, but no safe automatic remedy exists</div></div>
         <div class="card"><div class="l">stopped by watchdog</div><div class="v">${stopped}</div>
           <div class="n">its own supervisor cut the run short</div></div>
       </div>
     </section>

     <section>
       <h2>Every incident</h2>
       <table>
         <thead><tr><th>run</th><th>detected</th><th>device</th><th>cause</th>
           <th class="num">unearned</th><th>what it did</th><th class="num">time to fix</th></tr></thead>
         <tbody>${rows || '<tr><td colspan="7">No incidents yet — the agent is watching.</td></tr>'}</tbody>
       </table>
     </section>`,
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
  // The CFO brief comes first deliberately: on a page about money, the plain
  // business account of what was lost and recovered is the more useful of the
  // two write-ups, and the technical postmortem is there for whoever inherits it.
  const doc = [
    r.cfoBrief ? `<section><h2>What this cost, in plain terms</h2><pre>${esc(r.cfoBrief)}</pre></section>` : '',
    r.postmortem ? `<section><h2>Postmortem for the NOC</h2><pre>${esc(r.postmortem)}</pre></section>` : '',
    r.error ? `<section><h2>Error</h2><pre>${esc(r.error)}</pre></section>` : '',
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
  const money = (n: number): string => `$${n.toFixed(2)}`;
  const atRisk = r.revenueAtRiskUsd;
  const after = r.revenueLeakAfterUsd;

  // The headline for a single incident is what it was costing, not what the
  // reasoning cost. The agent's own bill belongs in the footnotes, and is put
  // beside the leak deliberately so the ratio between them is visible.
  const hero =
    typeof atRisk === 'number'
      ? `<div class="hero">
           <div class="l">Unearned revenue when this was caught</div>
           <div class="money${atRisk < 0.01 ? ' good' : ''}">${money(atRisk)}</div>
           <div class="n">Ad inventory signalled and served over the preceding fifteen minutes
             that was never billed. Delivery monitoring reported this period as healthy.</div>
           <div class="split">
             ${
               typeof after === 'number'
                 ? `<div><div class="l">still leaking after the fix</div>
                      <div class="v" style="color:${after < atRisk * 0.2 ? 'var(--green)' : 'var(--amber)'}">${money(after)}</div></div>`
                 : ''
             }
             <div><div class="l">time to verified fix</div>
                  <div class="v">${secs(r.detectedAt, r.verifiedAt)}</div></div>
             <div><div class="l">cost to diagnose &amp; repair</div>
                  <div class="v" style="color:var(--dim)">$${r.costUsd.toFixed(4)}</div></div>
           </div>
         </div>`
      : '';

  const card = (l: string, v: string, n = ''): string =>
    `<div class="card"><div class="l">${l}</div><div class="v">${v}</div>${
      n ? `<div class="n">${n}</div>` : ''
    }</div>`;

  return page(
    `AdBreak — incident ${r.runId}`,
    `<header>
       <div class="eyebrow"><a href="/trace">← all incidents</a></div>
       <h1>${esc(r.failureClass ?? 'Incident')} <span class="thin">on ${esc(
         r.incident.deviceClass,
       )}</span></h1>
       <p class="lede">${outcomePill(r.outcome)} &nbsp; ${esc(meaning)}</p>
       <div class="tag" style="margin-top:14px">${esc(r.incident.region)} ·
         detected ${when(r.detectedAt)}</div>
     </header>

     ${hero}
     ${approve}

     <section>
       <h2>How it decided</h2>
       <div class="cards">
         ${card('cause', esc(r.failureClass ?? '—'), 'graded against a ledger the agent cannot read')}
         ${card(
           'runbook',
           esc(r.runbookId ?? 'none'),
           r.runbookId ? 'chosen by lookup table, never by the model' : 'nothing mapped — escalate to a human',
         )}
         ${card('blast radius', `${esc(r.tier ?? '—')}`, esc(r.verdict ?? ''))}
         ${card('detect→remediate', secs(r.detectedAt, r.remediatedAt), 'the part the agent controls')}
         ${r.approvedBy ? card('approved by', esc(r.approvedBy), 'preconditions re-checked against live telemetry first') : ''}
         ${r.watchdog ? card('watchdog', esc(r.watchdog.reason), 'its own supervisor stopped this run') : ''}
       </div>
     </section>

     <section>
       <h2>Every step it took</h2>
       <p class="lede" style="margin:-8px 0 24px">Only the steps marked <em>llm</em> are a model.
         The runbook is chosen by a lookup table, the blast-radius gate is policy, and the
         watchdog is arithmetic.</p>
       ${steps}
     </section>
     ${doc}`,
  );
}
