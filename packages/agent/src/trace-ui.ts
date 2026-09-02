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
/* Follows vercel.com/design: monochrome by default, colour only where it carries
   meaning, spacing and alignment before borders, and no cards wrapped around
   every metric. Density comes from removing chrome rather than shrinking text -
   body copy stays readable at 14px and the greys stay above AA.
   Geist first in the stack for anyone who has it; system fallback otherwise, so
   the page carries no font dependency. */
:root {
  --bg:#000; --panel:#0a0a0a; --hover:#0f0f0f;
  --b-subtle:#1a1a1a; --b:#242424; --b-strong:#333;
  --fg:#ededed; --fg-2:#a1a1a1; --fg-3:#7d7d7d;
  --accent:#ededed; --money:#f5a623; --good:#3ecf8e; --bad:#f56565;
  --sans:Geist,"Geist Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
  --mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color-scheme: dark;
}
* { box-sizing:border-box; }
body { background:var(--bg); color:var(--fg); margin:0; padding:0 24px 48px;
  font:14px/1.55 var(--sans); -webkit-font-smoothing:antialiased;
  font-variant-numeric:tabular-nums; }
.wrap { max-width:1200px; margin:0 auto; }

/* Header: one line of identity, one of orientation. No panel around it. */
header { padding:28px 0 20px; }
.eyebrow { color:var(--fg-3); font-size:11px; font-weight:500; letter-spacing:.08em;
  text-transform:uppercase; margin-bottom:10px; }
h1 { font-size:22px; line-height:1.25; letter-spacing:-.018em; margin:0; font-weight:600; }
h1 .thin { color:var(--fg-2); font-weight:400; }
.lede { color:var(--fg-2); margin:8px 0 0; max-width:78ch; font-size:13.5px; line-height:1.6; }
.lede strong { color:var(--fg); font-weight:500; }
h2 { font-size:11px; margin:0 0 10px; color:var(--fg-3); font-weight:500;
  text-transform:uppercase; letter-spacing:.08em; }
section { margin-top:26px; }
a { color:var(--fg); text-decoration:none; border-bottom:1px solid var(--b-strong); }
a:hover { border-bottom-color:var(--fg-2); }
.tag { font:12px var(--mono); color:var(--fg-3); }

/* Stats: a row aligned to a grid, separated by rules rather than boxed in cards. */
.stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(132px,1fr));
  border-top:1px solid var(--b); border-bottom:1px solid var(--b); }
.stat { padding:14px 22px 14px 0; min-width:0; }
.stat + .stat { border-left:1px solid var(--b-subtle); padding-left:22px; }
.stat .v, .stat .l, .stat .n { overflow-wrap:anywhere; }
.stat .l { color:var(--fg-3); font-size:11px; letter-spacing:.04em; }
.stat .v { font:500 24px/1.15 var(--sans); margin-top:5px; letter-spacing:-.02em; }
.stat .v.money { color:var(--money); }
.stat .v.good { color:var(--good); }
.stat .v.quiet { color:var(--fg-3); font-size:17px; }
.stat .n { color:var(--fg-3); font-size:11.5px; margin-top:3px; line-height:1.4; }

table { border-collapse:collapse; width:100%; font-size:13px; }
/* Every cell keeps a gutter on both sides. Right-aligned columns previously had
   padding-right:0, which let them run straight into the next column. */
th,td { text-align:left; padding:8px 14px 8px 0; border-bottom:1px solid var(--b-subtle);
  vertical-align:baseline; }
th:last-child,td:last-child { padding-right:0; }
th { color:var(--fg-3); font-weight:500; font-size:11px; letter-spacing:.05em;
  border-bottom-color:var(--b); padding-bottom:7px; white-space:nowrap; }
td.m,th.m { font-family:var(--mono); font-size:12.5px; white-space:nowrap; }
td.n,th.n { text-align:right; font-family:var(--mono); font-size:12.5px; white-space:nowrap; }
td.money,th.money { text-align:right; font-family:var(--mono); font-size:13px; color:var(--money);
  white-space:nowrap; }
td.money.zero { color:var(--fg-3); }
td.wide { min-width:112px; }
tbody tr:hover { background:var(--hover); }

pre { background:var(--panel); border:1px solid var(--b-subtle); border-radius:6px;
  padding:10px 12px; overflow-x:auto; margin:6px 0 0; white-space:pre-wrap; word-break:break-word;
  font:12.5px/1.55 var(--mono); color:var(--fg-2); }
pre.q { color:var(--good); }

.pill { display:inline-block; padding:1px 8px; border-radius:4px; font-size:11.5px;
  font-weight:500; border:1px solid var(--b); color:var(--fg-2); white-space:nowrap; }
.pill.ok { color:var(--good); border-color:#1d3d2e; }
.pill.bad { color:var(--bad); border-color:#3d1d1d; }
.pill.warn { color:var(--money); border-color:#3d321d; }

/* The one place colour and a border are warranted: something needs a human. */
.banner { border:1px solid #3d321d; border-radius:6px; padding:14px 18px; margin:20px 0 0; }
.banner h3 { margin:0 0 4px; font-size:14px; color:var(--money); font-weight:600; }
.banner p { margin:0; color:var(--fg-2); font-size:13px; line-height:1.6; max-width:80ch; }
.banner form { margin-top:12px; }
button { font:500 13px var(--sans); cursor:pointer; padding:7px 16px; border-radius:6px;
  border:1px solid var(--b-strong); background:var(--fg); color:#000; }
button:hover { background:#fff; }
button:focus-visible { outline:2px solid var(--money); outline-offset:2px; }

.step { border-bottom:1px solid var(--b-subtle); }
.step > summary { cursor:pointer; padding:9px 0; list-style:none;
  display:grid; grid-template-columns:20px minmax(0,210px) minmax(0,1fr) auto; gap:16px;
  align-items:baseline; }
.step > summary::-webkit-details-marker { display:none; }
.step > summary:hover { background:var(--hover); }
.step .n { color:var(--fg-3); font:12px var(--mono); }
.step .name { font-weight:500; font-size:13px; font-family:var(--mono);
  overflow-wrap:anywhere; }
.step .said { color:var(--fg-2); font-size:13px; line-height:1.5; overflow-wrap:anywhere;
  min-width:0; }
.step .meta { color:var(--fg-3); font:11.5px var(--mono); white-space:nowrap; }
.step .body { padding:2px 0 16px 34px; }
@media (max-width:820px){ .step>summary{grid-template-columns:18px 1fr} .step .said,.step .meta{grid-column:2}
  .step .body{padding-left:0} }

.ev { margin:5px 0 0; padding-left:18px; color:var(--fg-2); font-size:13px; line-height:1.6; }
.ev li { margin:3px 0; }
div.ev { padding-left:0; }
.pre-l { color:var(--fg-3); font-size:10.5px; text-transform:uppercase; letter-spacing:.07em;
  margin-top:14px; font-weight:500; }
/* A legend, collapsed by default so it costs one line until it is wanted.
   The states here are domain-specific - nobody arriving cold can be expected to
   know that no_action is a deliberate escalation rather than a failure. */
.legend { margin-top:22px; border-top:1px solid var(--b-subtle); }
.legend > summary { cursor:pointer; list-style:none; padding:11px 0; color:var(--fg-2);
  font-size:12.5px; display:flex; align-items:center; gap:8px; }
.legend > summary::-webkit-details-marker { display:none; }
.legend > summary::before { content:"+"; color:var(--fg-3); font:12px var(--mono); }
.legend[open] > summary::before { content:"−"; }
.legend > summary:hover { color:var(--fg); }
.legend .cols { display:grid; grid-template-columns:repeat(auto-fit,minmax(330px,1fr));
  gap:0 40px; padding:4px 0 20px; }
.legend h4 { font-size:11px; color:var(--fg-3); font-weight:500; letter-spacing:.07em;
  text-transform:uppercase; margin:10px 0 8px; }
.legend dl { margin:0; display:grid; grid-template-columns:auto 1fr; gap:5px 14px; align-items:baseline; }
.legend dt { font:12px var(--mono); color:var(--fg); white-space:nowrap; }
.legend dd { margin:0; color:var(--fg-2); font-size:12.5px; line-height:1.5; }
footer { margin-top:40px; padding-top:16px; border-top:1px solid var(--b-subtle);
  color:var(--fg-3); font-size:12.5px; line-height:1.65; max-width:88ch; }
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
          ? ''
          : 'warn';
  return `<span class="pill ${cls}">${esc(outcome.replace(/_/g, ' '))}</span>`;
};

const secs = (a?: string, b?: string): string =>
  a && b ? `${((Date.parse(b) - Date.parse(a)) / 1000).toFixed(1)}s` : '—';

const when = (iso: string): string => esc(iso.replace('T', ' ').slice(0, 19));

// ---------------------------------------------------------------------------

/**
 * What the columns and states mean.
 *
 * Rendered once and shared, because the outcomes appear on both views and a
 * definition that drifts between two places is worse than none. Collapsed by
 * default: a returning operator does not need it, and someone seeing the page
 * for the first time should not have to guess that `no action` is a deliberate
 * escalation rather than a failure to do anything.
 */
function legend(): string {
  const dl = (rows: [string, string][]): string =>
    `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;

  return `<details class="legend">
    <summary>What the columns and outcomes mean</summary>
    <div class="cols">
      <div>
        <h4>Columns</h4>
        ${dl([
          ['run', 'One incident, start to finish. Open it for every step, the PromQL issued and what came back.'],
          ['detected', 'When the revenue SLO alert was picked up. The agent confirms the leak is still live before engaging.'],
          ['device', 'The device class the loss was scoped to. Most faults hit one slice, not the whole channel.'],
          ['cause', 'The failure class it settled on, graded against a ledger of what chaos actually did — which the agent cannot read.'],
          ['runbook', 'The repair, chosen by a lookup table from the failure class. Never chosen by the model.'],
          ['unearned', 'Ad inventory signalled, served, and never billed in the fifteen minutes before detection. The money this exists to find.'],
          ['to fix', 'Detection to verified recovery. Bounded by the ad-break cadence rather than by the agent — a fix cannot prove itself until a whole break has run after it.'],
          ['cost', 'Vertex AI spend on the reasoning for that one incident.'],
        ])}
      </div>
      <div>
        <h4>Outcomes</h4>
        ${dl([
          ['remediated', 'Fixed, and recovery confirmed against live telemetry rather than assumed.'],
          ['awaiting approval', 'Diagnosed and planned, then stopped. The fix would change what every viewer on the channel is served, which the agent will not do on its own.'],
          ['no action', 'Diagnosed, but nothing safe is mapped to this failure class — so it escalated with its evidence instead of improvising.'],
          ['blocked', 'A runbook applied, but its safety preconditions were not met at the moment of acting.'],
          ['blocked on approval', 'A human approved, but by then the plant had moved and the plan no longer applied.'],
          ['failed', 'The fix ran and recovery was not observed inside the runbook budget, so it was rolled back.'],
          ['killed by watchdog', 'Its own supervisor stopped the run for stalling, looping, or spending past its ceiling. The partial trace is kept.'],
        ])}
        <h4>Blast radius</h4>
        ${dl([
          ['T1', 'One device class in one region. The agent may act alone.'],
          ['T2', 'Channel-wide. Planned, then held for a human.'],
          ['T3', 'Wider than the agent is trusted with at all.'],
        ])}
      </div>
    </div>
  </details>`;
}

export function renderRunList(runs: AgentRun[]): string {
  const usd = (n: number): string => (n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(2)}`);

  const remediated = runs.filter((r) => r.outcome === 'remediated').length;
  const held = runs.filter((r) => r.outcome === 'awaiting_approval');
  const escalated = runs.filter((r) => r.outcome === 'no_action').length;
  const stopped = runs.filter((r) => r.outcome === 'killed_by_watchdog').length;
  const caught = runs.reduce((sum, r) => sum + (r.revenueAtRiskUsd ?? 0), 0);
  const stoppedLeak = runs
    .filter((r) => r.recovered === true)
    .reduce((sum, r) => sum + (r.revenueAtRiskUsd ?? 0), 0);
  const spend = runs.reduce((sum, r) => sum + r.costUsd, 0);
  const verified = runs.filter((r) => r.verifiedAt);
  const meanMttr = verified.length
    ? verified.reduce((s, r) => s + (Date.parse(r.verifiedAt!) - Date.parse(r.detectedAt)) / 1000, 0) /
      verified.length
    : 0;

  const stat = (l: string, v: string, cls = '', n = ''): string =>
    `<div class="stat"><div class="l">${l}</div><div class="v ${cls}">${v}</div>${
      n ? `<div class="n">${n}</div>` : ''
    }</div>`;

  const rows = runs
    .map((r) => {
      const atRisk = r.revenueAtRiskUsd;
      const money =
        typeof atRisk === 'number'
          ? `<td class="money${atRisk < 0.01 ? ' zero' : ''}">${usd(atRisk)}</td>`
          : `<td class="money zero">—</td>`;
      return `<tr>
        <td class="m"><a href="/trace/${esc(r.runId)}">${esc(r.runId)}</a></td>
        <td class="m">${when(r.detectedAt).slice(5)}</td>
        <td>${esc(r.incident.deviceClass)}</td>
        <td class="m">${esc(r.failureClass ?? '—')}</td>
        <td class="m">${esc(r.runbookId?.replace('rb-', '') ?? '—')}</td>
        ${money}
        <td class="wide">${outcomePill(r.outcome)}</td>
        <td class="n">${secs(r.detectedAt, r.verifiedAt ?? r.remediatedAt)}</td>
        <td class="n">$${r.costUsd.toFixed(3)}</td>
      </tr>`;
    })
    .join('');

  const holdBanner = held.length
    ? `<div class="banner">
         <h3>${held.length} plan${held.length > 1 ? 's' : ''} waiting for a human</h3>
         <p>A channel-wide change is classified T2, which this agent will not make on its own. It
            diagnosed the fault, chose the runbook, rendered the plan &mdash; and stopped.
            ${held.map((r) => `<a href="/trace/${esc(r.runId)}">${esc(r.runId)}</a>`).join(' · ')}</p>
       </div>`
    : '';

  return page(
    'AdBreak — money not earned',
    `<header>
       <div class="eyebrow">AdBreak · revenue SRE for live streaming</div>
       <h1>A detector for <span class="thin">money the stream never earned.</span></h1>
       <p class="lede">Ad breaks fail quietly: the video keeps playing, every delivery dashboard
         stays green, and impressions that should have been billed never arrive. This agent watches
         for <strong>revenue that should have been realised and was not</strong>, finds the stage
         responsible, and repairs it &mdash; or stops and asks, when the fix would touch every
         viewer on the channel.</p>
     </header>

     <div class="stats">
       ${stat('unearned revenue caught', usd(caught), 'money', 'signalled, served, never billed')}
       ${stat('leak stopped &amp; verified', usd(stoppedLeak), 'good', 'confirmed on live telemetry')}
       ${stat('incidents', String(runs.length), '', `${remediated} fixed · ${held.length} held · ${escalated} escalated`)}
       ${stat('mean time to verified fix', `${meanMttr.toFixed(0)}s`, '', 'bounded by the break cadence')}
       ${stat('stopped by watchdog', String(stopped), '', 'its own supervisor intervened')}
       ${stat('cost to run the agent', `$${spend.toFixed(2)}`, 'quiet', 'Vertex AI, all runs')}
     </div>

     ${holdBanner}

     <section>
       <h2>Every incident</h2>
       <table>
         <thead><tr><th class="m">run</th><th class="m">detected</th><th>device</th><th class="m">cause</th>
           <th class="m">runbook</th><th class="money">unearned</th><th class="wide">what it did</th>
           <th class="n">to fix</th><th class="n">cost</th></tr></thead>
         <tbody>${rows || '<tr><td colspan="9">No incidents yet — the agent is watching.</td></tr>'}</tbody>
       </table>
       ${legend()}
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
      <span class="name">${esc(s.step.replace(':', ' · ').replace(/_/g, ' '))}</span>
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
  const usd = (n: number): string => `$${n.toFixed(2)}`;
  const atRisk = r.revenueAtRiskUsd;
  const after = r.revenueLeakAfterUsd;

  const stat = (l: string, v: string, cls = '', n = ''): string =>
    `<div class="stat"><div class="l">${l}</div><div class="v ${cls}">${v}</div>${
      n ? `<div class="n">${n}</div>` : ''
    }</div>`;

  return page(
    `AdBreak — incident ${r.runId}`,
    `<header>
       <div class="eyebrow"><a href="/trace">all incidents</a> · ${esc(r.runId)}</div>
       <h1>${esc(r.failureClass ?? 'Incident')} <span class="thin">on ${esc(
         r.incident.deviceClass,
       )} in ${esc(r.incident.region)}</span></h1>
       <p class="lede">${outcomePill(r.outcome)} &nbsp; ${esc(meaning)} &middot;
         detected ${when(r.detectedAt)}</p>
     </header>

     <div class="stats">
       ${
         typeof atRisk === 'number'
           ? stat('unearned when caught', usd(atRisk), 'money', 'ad inventory never billed, prior 15m')
           : ''
       }
       ${
         typeof after === 'number'
           ? stat('still leaking after', usd(after), after < (atRisk ?? 1) * 0.2 ? 'good' : 'money', 'same measure, after the fix')
           : ''
       }
       ${stat('cause', esc(r.failureClass ?? '—'), '', 'graded against a ledger it cannot read')}
       ${stat('runbook', esc(r.runbookId?.replace('rb-', '') ?? 'none'), '', r.runbookId ? 'chosen by lookup, never the model' : 'nothing mapped — escalated')}
       ${stat('blast radius', esc(r.tier ?? '—'), '', esc(r.verdict ?? ''))}
       ${stat('detect→remediate', secs(r.detectedAt, r.remediatedAt), '', 'the part the agent controls')}
       ${stat('detect→verified', secs(r.detectedAt, r.verifiedAt), '', 'bounded by the break cadence')}
       ${stat('cost to diagnose', `$${r.costUsd.toFixed(4)}`, 'quiet', 'Vertex AI, this incident')}
       ${r.approvedBy ? stat('approved by', esc(r.approvedBy), '', 'preconditions re-checked first') : ''}
       ${r.watchdog ? stat('watchdog', esc(r.watchdog.reason), '', 'its supervisor stopped this run') : ''}
     </div>

     ${approve}

     <section>
       <h2>Every step it took</h2>
       <p class="lede" style="margin:-8px 0 24px">Only the steps marked <em>llm</em> are a model.
         The runbook is chosen by a lookup table, the blast-radius gate is policy, and the
         watchdog is arithmetic.</p>
       ${steps}
       ${legend()}
     </section>
     ${doc}`,
  );
}
