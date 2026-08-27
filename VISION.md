# AdBreak

**Revenue SRE for Live Streaming.**

> Your stream was up. Your revenue was down. Nobody paged.

An autonomous SRE agent whose SLO is not uptime — it's **money per ad avail**. AdBreak watches the entire live ad-insertion chain (SCTE-35 → packager → ad decisioning → SSAI stitch → CDN → player beacons), detects revenue leaks that every conventional dashboard reports as healthy, performs root-cause analysis by correlating metrics, logs and traces through Grafana, executes a deterministic runbook remediation inside a policy-gated blast radius, verifies recovery, and writes the incident and postmortem itself.

And then it does the thing nobody else does: **it is observed by the same system it operates.** Every agent step, tool call, token and dollar emits telemetry into Grafana, and a deterministic watchdog detects a stalled, looping or runaway agent and kills it.

---

## Table of contents

1. [Why this exists](#1-why-this-exists)
2. [The core insight](#2-the-core-insight)
3. [What we are building](#3-what-we-are-building)
4. [Non-goals](#4-non-goals)
5. [Domain primer: how ad money actually flows](#5-domain-primer-how-ad-money-actually-flows)
6. [The failure taxonomy](#6-the-failure-taxonomy)
7. [System architecture](#7-system-architecture)
8. [The telemetry contract](#8-the-telemetry-contract)
9. [The agent](#9-the-agent)
10. [Runbooks and the safety model](#10-runbooks-and-the-safety-model)
11. [Feature set](#11-feature-set)
12. [The eval harness](#12-the-eval-harness)
13. [Repository layout](#13-repository-layout)
14. [Tech stack and hosting](#14-tech-stack-and-hosting)
15. [13-day plan](#15-13-day-plan)
16. [The demo](#16-the-demo)
17. [Risk register](#17-risk-register)
18. [Scope-cut ladder](#18-scope-cut-ladder)
19. [Judging traceability](#19-judging-traceability)
20. [Open decisions](#20-open-decisions)

---

## 1. Why this exists

Live streaming makes its money in roughly 90-second windows. A sports broadcaster running a national match sells avails at $25–$60 eCPM against a concurrency of a few hundred thousand to a few million. A single 30-second break across 800k concurrent viewers is on the order of **$20,000–$48,000**. There are 30–50 of them in a match.

When one of those breaks fails, one of two things happens:

- **It fails loudly** — players buffer, the stream glitches, viewers tweet, and the NOC pages within a minute. This case is well-handled by existing tooling.
- **It fails quietly** — the ad decision server times out and slate is inserted, or the creative fails conditioning, or the impression beacons never reach the ad server. The stream is bit-perfect. Every player is happy. The uptime dashboard is 100% green. And the break earned nothing.

The second case is the norm and it is essentially unmonitored, because the entire observability stack of a streaming operation is built around **delivery health**, not **revenue realization**. The teams are also split: the SRE team owns the CDN and origin, the ad-ops team owns the ADS and the creative pipeline, and neither one's dashboard spans the boundary where most failures live. Reconciliation happens at month-end, against the ad server's numbers, by which point the inventory is gone and the make-good is a negotiation.

Ad-ops teams describe discovering these failures the same way every time: a discrepancy report from the advertiser, weeks later.

AdBreak's premise is that this is a solved problem in a different industry. This is an SRE problem. It has an SLO, an error budget, a signal chain, a runbook, and a mean-time-to-recovery. It has simply never been instrumented as one, because the metric that matters — *did this avail earn what it should have earned* — spans six systems owned by three teams and is not emitted by any of them.

## 2. The core insight

**Availability is not the SLO. Revenue realization is.**

We define a single north-star metric:

```
Revenue Realization Ratio (RRR) = realized_revenue / expected_revenue
```

measured per channel, per region, per device class, over a rolling 5-minute window.

- `expected_revenue` = signaled avail seconds × eligible concurrent sessions × eCPM ÷ 1000, computed deterministically from the playout schedule and the session census.
- `realized_revenue` = confirmed billable impressions (quartile-verified beacons) × eCPM ÷ 1000.

The SLO is `RRR ≥ 0.98` over 15 minutes. The error budget is denominated **in dollars**, not in nines. A burn-rate alert on this single ratio catches every failure class in section 6, including the silent ones, because all of them terminate in the same place: money that should have been realized wasn't.

Everything else in AdBreak — the RCA, the runbooks, the watchdog, the postmortems — hangs off this one number. That is the product.

## 3. What we are building

Five components, all real, all running:

1. **A live ad-insertion pipeline** that genuinely works — real HLS, real SCTE-35 signaling, real manifest manipulation, real VAST ad decisioning, a synthetic player fleet firing real IAB beacons. Not a mock. A judge can open the HLS URL in a player and watch it.
2. **Full-chain observability** — OpenTelemetry instrumentation across every hop, metrics to Prometheus, logs to Loki, traces to Tempo, all surfaced in Grafana. One trace per avail, spanning all eight stages. Exemplars link every metric spike to the exact avail that caused it.
3. **A chaos injector** with a catalog of eleven named, parameterized faults, including combined faults designed to produce misleading correlations.
4. **The agent** — a deterministic ADK workflow on Vertex AI / Gemini that detects, triages, correlates, hypothesizes, verifies, remediates, re-verifies, and documents. It reaches Grafana exclusively through the Grafana MCP server, and it writes back — annotations, dashboards, incidents.
5. **The meta layer** — agent self-telemetry into the same Grafana, an "Agent Fleet Health" dashboard, and a deterministic watchdog that detects stalls, loops and cost runaways and terminates the run.

Plus an eval harness that scores all of it, in CI, on every commit.

## 4. Non-goals

Stating these up front so we don't drift:

- **Not building a real SSAI product.** The pipeline exists to be broken realistically, not to compete with MediaTailor.
- **Not doing video decode.** Synthetic players simulate playback on a wall clock and fire beacons. No frames are rendered. This is exactly how real load-test fleets work.
- **Not doing ad targeting, forecasting, or yield optimization.** We detect and repair leaks. We do not sell inventory.
- **Not a chat interface.** There is a conversational surface for interrogating an incident, but the agent is autonomous and event-triggered. A chat box would put us in the same bucket as every other submission.
- **Not multi-tenant.** One broadcaster, several channels. Multi-tenancy adds no demo value.

## 5. Domain primer: how ad money actually flows

Understanding this chain is the whole engineering problem, so it's written out in full. Eight stages:

| # | Stage | What happens | Owner in a real org |
|---|---|---|---|
| 1 | **Signal** | Playout automation emits an SCTE-35 message into the transport stream marking an upcoming avail: `splice_insert` or `time_signal` + segmentation descriptor, carrying avail ID, duration, and break type. | Broadcast ops |
| 2 | **Package** | The packager/origin converts SCTE-35 into manifest-level markers: `#EXT-X-CUE-OUT:30.000` / `#EXT-X-CUE-IN`, or `#EXT-X-DATERANGE` with `SCTE35-OUT` attributes for HLS; `EventStream` for DASH. | Video engineering |
| 3 | **Decide** | On seeing the cue, SSAI calls the Ad Decision Server with a VAST/VMAP request carrying session context (geo, device, content ID, pod duration). The ADS returns an ad pod — a list of creatives with durations and tracking URLs. | Ad ops |
| 4 | **Condition** | Returned creatives must be transcoded to match the stream's exact profile ladder, segment duration, and codec parameters. Uncached creatives fail here constantly. | Ad ops / video eng |
| 5 | **Stitch** | SSAI builds a *personalized manifest per session*, splicing conditioned ad segments into the content timeline with correct `EXT-X-DISCONTINUITY` markers and sequence numbering. | Ad ops |
| 6 | **Deliver** | CDN serves the personalized manifest and segments. Manifests are per-session and therefore uncacheable at the edge — a known scaling pressure point. | SRE |
| 7 | **Play** | The player fetches, buffers, and plays through the discontinuity into the ad, then back to content. | Client teams |
| 8 | **Beacon** | The player (or SSAI, server-side) fires IAB tracking events at `impression`, `start`, `firstQuartile`, `midpoint`, `thirdQuartile`, `complete`. **These beacons are the billing record.** No beacon, no revenue, regardless of whether a human watched the ad. | Ad ops |

The critical asymmetry: **stages 1–7 are watched obsessively. Stage 8 is where the money is counted and almost nobody alerts on it in real time.**

## 6. The failure taxonomy

Eleven fault classes. Each is a chaos scenario, a detector, a runbook, and an eval case. This table is the specification for most of the build.

> **13-day scope (27 Aug):** only **F03, F04, F07, F08** get built before the 9 Sep deadline (§15). The rest of the table stands as the domain spec and the post-deadline roadmap.

| ID | Fault | Injected at | Symptom on classic dashboards | Detector signal | Runbook | Loss profile |
|---|---|---|---|---|---|---|
| **F01** | Cue suppressed | Playout | **Nothing. All green.** | `avail_signaled_total` flat vs. schedule | `rb-cue-resignal` | 100% of avail |
| **F02** | Cue dropped by packager | Packager | Nothing | `signaled > manifested` divergence | `rb-packager-failover` | 100% of avail |
| **F03** | ADS latency spike | Ad decision server | Nothing | `ads_response_duration p99` > timeout, fill drops | `rb-ads-failover` | 60–100% |
| **F04** | Empty VAST / no-fill | ADS | Nothing | `ads_fill_ratio` collapse | `rb-ads-failover` | 100% |
| **F05** | Creative conditioning failure | Conditioner | Nothing | `creative_conditioning_failures_total` by creative | `rb-creative-quarantine` | Per-creative slot |
| **F06** | Discontinuity corruption | SSAI stitch | **Loud** — rebuffering at ad boundary | `stitch_errors_total`, player rebuffer at boundary | `rb-ssai-rollback` | Partial + QoE |
| **F07** | **Beacon blackhole** | CDN edge, one device class | **Nothing. Perfectly green.** | `impression_gap_ratio` by device × CDN | `rb-beacon-fallback` | 100%, invisible |
| **F08** | Regional CDN 5xx | CDN | **Loud** — segment errors | `cdn_5xx_total` by PoP | `rb-cdn-shift` | Partial + QoE |
| **F09** | Duration underfill | ADS | Nothing | `slate_seconds_total` up, pod duration < avail | `rb-ads-backfill` | Fractional |
| **F10** | Blackout violation | SSAI | Nothing (compliance risk) | Geo-rule assertion fails | `rb-blackout-enforce` | Legal, not revenue |
| **F11** | **Combined: F03 + F08** | ADS + CDN | Loud CDN errors *mask* the real cause | Requires trace correlation to disambiguate | Correct = `rb-ads-failover` | 60% + red herring |

**F07 is the flagship.** It is the purest expression of the thesis: the stream is flawless, every SRE dashboard is green, viewers are watching ads, and the company is being paid for none of them. It also has a beautiful remediation (switch that device class to server-side beacon emission) with a small blast radius, which makes it safe to auto-execute on camera.

**F11 is the credibility test.** A pattern-matching agent will see loud CDN 5xx errors and confidently blame the CDN. The correct answer requires noticing that the RRR degradation started 90 seconds *before* the CDN errors, and that the affected sessions span PoPs the CDN fault doesn't touch. If our agent gets F11 right on camera, no judge doubts it's doing real correlation.

## 7. System architecture

```
┌─────────────────────── SIMULATED BROADCAST PLANT (Docker Compose / GCE) ───────────────────────┐
│                                                                                                 │
│  playout ──cue bus (Redis)──► packager ──► origin ──► ssai ──► cdn(envoy) ──► player-fleet      │
│  (schedule,    SCTE-35        (HLS +      (segments)  (stitch)  (edge,        (N synthetic      │
│   avails)                      DATERANGE)      │       per-      fault         sessions,        │
│      │                                         │       session)  filter)       beacons)         │
│      │                                    ad-decision-server ◄──┘                  │            │
│      │                                    (mock VAST, knobs)                       │            │
│      │                                         │                                   ▼            │
│      │                                    conditioner                        beacon-collector   │
│      │                                    (creative prep)                     (billing record)  │
│      └──────────────────── chaos-injector (11 faults, ladder mode) ────────────────┘            │
└─────────────────────────────────────────────────┬───────────────────────────────────────────────┘
                                                  │ OpenTelemetry (traces, metrics, logs)
                                                  ▼
┌──────────────────────────── OBSERVABILITY (Grafana Cloud) ─────────────────────────────────────┐
│   Prometheus/Mimir  •  Loki  •  Tempo  •  Grafana dashboards  •  Grafana Alerting  •  Incident │
└─────────────────────────────────────────────────┬───────────────────────────────────────────────┘
                                                  │  Grafana MCP server (read AND write)
                                                  ▼
┌──────────────────────── ADBREAK AGENT (Cloud Run • ADK • Gemini) ──────────────────────────────┐
│  SequentialAgent:                                                                               │
│    1 Detect ─ 2 Triage ─ 3 Correlate ─ 4 Hypothesize ─ 5 Falsify ─ 6 Plan ─ 7 Act ─ 8 Verify   │
│                                                    ─ 9 Document                                 │
│  Tools: grafana.query_prometheus | query_loki | query_tempo | create_annotation |                │
│         create_dashboard | create_incident   ·   runbook.execute   ·   ledger.compute            │
│                                                  │                                              │
│  ├─ Revenue Ledger (deterministic $ attribution)                                                │
│  ├─ Blast-Radius Policy Gate (T0–T3, deterministic, no LLM)                                     │
│  └─ every step ──► OTel spans + agent_* metrics ──────────┐                                     │
└───────────────────────────────────────────────────────────┼─────────────────────────────────────┘
                                                            ▼
                              ┌──────────── WATCHDOG (deterministic, non-LLM) ────────────┐
                              │  stall detection · loop detection · cost ceiling · kill    │
                              │  → "Agent Fleet Health" dashboard in the same Grafana      │
                              └────────────────────────────────────────────────────────────┘
```

### Component specifications

**`playout`** — Owns the avail schedule (a YAML file: channel, wall-clock offsets, durations, break types). Publishes SCTE-35 messages to a Redis pub/sub cue bus. Emits `avail_signaled_total`. Chaos hook: suppress a cue (F01).

**`encoder`** — `ffmpeg` producing a real HLS ladder (3 renditions: 1080p/720p/480p, 4s segments) from a looping source file. Writes to a shared volume. This is a genuinely live stream, not a static playlist.

**`packager`** — Consumes the cue bus, owns the content manifest, injects `#EXT-X-DATERANGE` with `SCTE35-OUT`/`SCTE35-IN` attributes and `#EXT-X-CUE-OUT`/`CUE-IN` at the correct segment boundary. Emits `avail_manifested_total`. Chaos hook: drop or mis-time a cue (F02). *Owning the manifest ourselves rather than using an off-the-shelf packager is deliberate — it gives complete fault-injection control for ~400 lines of code.*

**`ad-decision-server`** — Mock VAST 4.x endpoint with runtime-tunable knobs: `latency_ms` distribution, `fill_rate`, `pod_fill_duration_ratio`, `error_rate`, per-region overrides. Returns creative references with tracking URLs. Chaos hooks: F03, F04, F09.

**`conditioner`** — Simulates creative transcode/conditioning with a cache. Cache miss = latency + failure probability. Emits `creative_conditioning_failures_total`. Chaos hook: F05.

**`ssai`** — The manifest manipulator. Per-session state, splices ad segments into the content timeline at cue boundaries with correct `EXT-X-DISCONTINUITY` and media-sequence handling. Enforces blackout rules. Chaos hooks: F06, F10.

**`cdn`** — Envoy with a fault-injection filter. Per-PoP, per-device-class, per-path rules. Chaos hooks: F07 (blackhole the beacon path for one device class), F08 (5xx a region).

**`player-fleet`** — Go/Node synthetic clients. 200–2,000 virtual sessions, each with a device class (roku / firetv / ios / android / web / smarttv), region, ISP, and CDN affinity. Fetches personalized manifests on a wall clock, "plays" segments, fires IAB beacons at the six quartile events, reports QoE (rebuffer, startup, bitrate). Runs at accelerated wall-clock in eval mode.

**`beacon-collector`** — The billing record. Receives tracking pings, deduplicates, writes confirmed impressions. The gap between `beacon_expected` and `beacon_fired` is the revenue leak.

**`chaos-injector`** — HTTP API + CLI. `POST /inject {fault: F07, params: {...}, duration_s: 300}`. Ladder mode runs a scripted escalating sequence. Every injection is recorded to a ground-truth log the agent cannot read but the eval harness can.

## 8. The telemetry contract

Names are frozen here so the pipeline team and the agent team can work in parallel from day one.

### Metrics (Prometheus)

```
# Signal chain integrity
adbreak_avail_signaled_total{channel,region,break_type}
adbreak_avail_manifested_total{channel,region,packager}
adbreak_avail_decided_total{channel,region,ads}

# Ad decisioning
adbreak_ads_request_total{ads,region,device_class}
adbreak_ads_response_duration_seconds{ads,region}          # histogram, exemplars on
adbreak_ads_fill_ratio{ads,region}
adbreak_ads_pod_duration_seconds{ads,region}               # vs. requested avail duration
adbreak_creative_conditioning_failures_total{creative_id,reason}

# Stitch & delivery
adbreak_stitch_errors_total{reason,device_class}
adbreak_slate_seconds_total{channel,region,reason}
adbreak_cdn_requests_total{pop,status,path_class}
adbreak_manifest_latency_seconds{pop,device_class}

# The money
adbreak_beacon_expected_total{event,device_class,cdn,isp,region}
adbreak_beacon_fired_total{event,device_class,cdn,isp,region}
adbreak_impression_gap_ratio{device_class,cdn,region}
adbreak_revenue_expected_usd_total{channel,region,advertiser}
adbreak_revenue_realized_usd_total{channel,region,advertiser}
adbreak_revenue_leak_usd_total{channel,region,failure_class}

# THE SLO
adbreak_rrr{channel,region,device_class}                   # realized / expected, 5m rolling
```

### Traces (Tempo)

One trace per avail, `trace_id` derived from `avail_id`. Span tree:

```
avail.lifecycle                             [root, attrs: avail_id, channel, duration, expected_usd]
├── signal.emit                             [playout]
├── package.inject_marker                   [packager]
├── decision.request                        [ssai → ads]
│   └── ads.respond                         [attrs: fill, pod_duration, creative_ids]
├── condition.prepare                       [per creative]
├── stitch.build_manifest                   [per session — sampled]
├── deliver.segment_fetch                   [cdn — sampled]
└── play.session                            [per session — sampled]
    └── beacon.fire                         [per quartile — attrs: event, ack_status]
```

Prometheus exemplars attach `trace_id` to histogram buckets, so a spike on `ads_response_duration_seconds` links directly to the offending avail's trace. **This is the mechanism that makes Grafana load-bearing rather than decorative** — the agent's correlation step is metric → exemplar → trace → structured log, and that path only exists because all three signals live in one correlated stack.

### Logs (Loki)

Structured JSON, every line carries `avail_id`, `session_id` (where applicable), `trace_id`, `component`, `severity`. Labels kept low-cardinality: `{component, channel, severity}`. Everything else is a field.

### Agent self-telemetry

```
agent_run_total{trigger,outcome}
agent_step_duration_seconds{step,run_id}
agent_tool_calls_total{tool,status}
agent_tool_duration_seconds{tool}
agent_tokens_total{model,step,kind}                        # kind: input|output|cached
agent_cost_usd_total{run_id,model}
agent_step_retries_total{step,reason}
agent_hypothesis_confidence{run_id}
agent_remediation_total{runbook,tier,approval,outcome}
agent_watchdog_intervention_total{reason}                  # stall|loop|cost|schema
agent_mttd_seconds / agent_mttr_seconds
```

## 9. The agent

Built on **ADK** (Agent Development Kit) as a `SequentialAgent` with two nested `ParallelAgent` fan-outs. The control flow is code. The LLM never chooses the next step — it only fills in the reasoning inside a step. This is the direct answer to the "deterministic, multi-step" criterion, and the trace UI makes it visible in ten seconds.

### The nine steps

| # | Step | Type | Input | Output (schema-validated) | Model |
|---|---|---|---|---|---|
| 1 | **Detect** | Deterministic | Grafana alert webhook (RRR burn rate) | `Incident{id, channel, region, started_at, rrr, budget_burn}` | — |
| 2 | **Triage** | LLM (fast) | Incident + top-level metric snapshot | `Triage{severity, suspected_stages[], affected_dimensions{}}` | Flash |
| 3 | **Correlate** | `ParallelAgent` fan-out | Suspected stages | `Evidence[]` — one branch per signal type: PromQL over the signal-chain metrics, LogQL over component logs, TraceQL over affected avails, plus a dimensional-slice branch (device × cdn × isp × region) | Flash ×4 |
| 4 | **Hypothesize** | LLM (deep) | All evidence | `Hypothesis{failure_class, stage, cause, confidence, supporting_evidence[], predicted_signature{}}` | Pro |
| 5 | **Falsify** | `ParallelAgent`, adversarial | Top hypothesis + runner-up | Each branch tries to *refute* the hypothesis by querying for a signal that should exist if it's true, or should not exist if it's true. `Falsification{survived: bool, contradictions[]}` | Pro ×2 |
| 6 | **Plan** | Deterministic + LLM | Surviving hypothesis | `Plan{runbook_id, params, blast_radius_tier, predicted_impact, rollback}` — runbook selected by a **lookup table** keyed on `failure_class`, never by the LLM | Flash |
| 7 | **Act** | Deterministic | Plan + policy gate verdict | `Execution{steps[], outcome, duration}` — or `AwaitingApproval` | — |
| 8 | **Verify** | Deterministic + LLM | Post-action metric window | `Verification{rrr_recovered: bool, residual_leak_usd, regression_detected}` — loops back to step 4 with the failed hypothesis excluded if not recovered (max 2 iterations) | Flash |
| 9 | **Document** | LLM | Full run trace | Grafana annotation + incident + postmortem markdown + CFO brief | Pro |

**Step 5 is the differentiator in the RCA.** Most agent demos stop at "here's my hypothesis." Ours spends a step actively trying to kill its own conclusion, and reports what it tried. For F11 (the combined fault with the red herring), the falsification step is exactly what saves it: the CDN hypothesis dies because the agent checks whether unaffected PoPs also show RRR degradation, and they do.

Every step's input and output is persisted to Firestore and emitted as an OTel span. The `/trace` UI renders the full run: step, duration, tokens, cost, the actual PromQL/LogQL/TraceQL issued, the raw result, and the validated output object.

### Model strategy

Gemini Flash for classification and query generation (steps 2, 3, 6, 8), Gemini Pro for synthesis and adversarial reasoning (steps 4, 5, 9). Target: **< $0.15 and < 60 seconds per incident.** Both are tracked as first-class metrics and shown on the Agent Fleet Health dashboard — cost per incident resolved is a number a judge will remember.

## 10. Runbooks and the safety model

### Runbook definition

Runbooks are versioned YAML in `runbooks/`, loaded at startup, never generated at runtime.

```yaml
id: rb-beacon-fallback
version: 3
title: Fail over to server-side beacon emission for an affected device class
applies_to: [F07]
blast_radius: T1                    # device class within one region
preconditions:
  - expr: 'adbreak_impression_gap_ratio{device_class="$device"} > 0.4'
    window: 3m
  - expr: 'adbreak_beacon_fired_total{device_class!="$device"} > 0'
    note: "other device classes healthy — confirms scoped, not global"
  - manual_override_active: false
predicted_impact:
  rrr_delta: +0.35
  sessions_affected_expr: 'sum(adbreak_sessions{device_class="$device",region="$region"})'
  risk: "duplicate impressions if client beacons resume mid-window"
actions:
  - type: config_patch
    target: ssai
    path: /beacon/mode/$device
    value: server_side
  - type: wait
    seconds: 30
verification:
  - expr: 'adbreak_impression_gap_ratio{device_class="$device"} < 0.05'
    window: 2m
    timeout: 180s
rollback:
  - type: config_patch
    target: ssai
    path: /beacon/mode/$device
    value: client_side
```

Three runbooks ship in the 13-day scope: `rb-beacon-fallback` (the flagship, built first), `rb-ads-failover`, `rb-cdn-shift`. The remaining five (`rb-cue-resignal`, `rb-packager-failover`, `rb-creative-quarantine`, `rb-ssai-rollback`, `rb-ads-backfill`) are post-deadline.

### Blast radius tiers

Deterministic classification. No LLM involvement.

| Tier | Scope | Default policy | During a live event |
|---|---|---|---|
| **T0** | Single session | Auto | Auto |
| **T1** | One device class within one region | Auto | Auto |
| **T2** | An entire region, or a device class globally | **Human approval** | Human approval |
| **T3** | Channel-wide, or any change to the content path | **Human approval + second approver** | Blocked |

The gate is a pure function: `(tier, event_mode, precondition_results, error_budget_remaining) → ALLOW | APPROVE | BLOCK`. It is unit-tested, and the tests are part of the eval suite. When the verdict is `APPROVE`, the agent posts the plan — including its predicted impact and rollback — to the incident channel and waits.

This matters more than it sounds. "We let an LLM run remediation against production" is a red flag to any operator on the judging panel. "We let a *deterministic policy gate* authorize a *pre-written, precondition-checked runbook* that the LLM only *selected via lookup table*" is an architecture a real SRE would sign off on. Say that sentence out loud in the video.

### The dry run

Before any execution, the agent computes and displays the blast radius: exact session count, regions, device classes, predicted RRR delta, and rollback path. On T2+ this is what the human approves. On T0/T1 it is logged and annotated into Grafana before the action fires, so the audit trail always precedes the change.

## 11. Feature set

Priorities: **P0** = the submission fails without it. **P1** = the submission is ordinary without it. **P2** = build if time remains.

| # | Feature | Pri | Why it's in |
|---|---|---|---|
| 1 | Live pipeline with real SCTE-35 / HLS / VAST / beacons | P0 | Everything rests on it being real |
| 2 | Full-chain OTel → Grafana (metrics, logs, traces, exemplars) | P0 | Makes the partner load-bearing |
| 3 | RRR SLO + dollar-denominated error budget | P0 | The thesis in one metric |
| 4 | **Revenue Loss Ledger** — live $ attribution per incident | P0 | Turns SRE into finance; the emotional core of the demo |
| 5 | Chaos injector — F07 first, then F03/F04/F08; rest cut | P0 | No faults, no demo |
| 6 | 9-step deterministic ADK agent w/ adversarial falsification | P0 | The stated judging criterion |
| 7 | Grafana MCP read **and write** (annotations, dashboards, incidents) | P0 | Write-back is what makes it undeniable |
| 8 | 8 runbooks + blast-radius policy gate + verified rollback | P0 | Credibility with operators |
| 9 | `/trace` UI — every step, query, token, dollar | P0 | Makes "deterministic" visible in 10 seconds |
| 10 | **Watchdog** — agent observed by its own stack | P1 | The thing judges have never seen |
| 11 | **Replay checks** — scripted, scored F07/F03 replays (no CI plumbing) | P1 | Honest numbers for the video's close; full harness is post-deadline |
| 12 | **Rehearsal** — pre-event synthetic avail certification | P2 | Strong product story, zero judged value per hour at 13 days. Post-deadline. |
| 13 | Auto-postmortem + **CFO Brief** (dual technical/business output) | P1 | One artifact for the NOC, one for the person who funds it |
| 14 | **Replay mode** — deterministic re-run from recorded telemetry | P1 | Demo insurance. See §17. |
| 15 | **Chaos Ladder / Game Day** — scripted escalating multi-fault run | P2 | Breadth (F03/F04/F08 in Phase D) covers "not a one-trick pony" more cheaply. Post-deadline. |
| 16 | **Learned runbook proposal** — novel incident → runbook PR | P2 | Closes the loop without being reckless. Never auto-merges. |
| 17 | Conversational incident interrogation | P2 | Nice, not differentiating |
| 18 | Slack/Teams incident surface | P2 | Only if free |

### Feature notes

**Revenue Loss Ledger (#4).** Every incident carries a running dollar figure computed deterministically: `leak_usd = Σ(affected_sessions × affected_avail_seconds × eCPM / 1000)`, attributed to a failure class, accumulating in real time on a Grafana panel and freezing at incident close. The postmortem states "$41,280 lost, $38,900 recovered by remediation at T+47s, $2,380 unrecoverable." This is the number that makes the project matter, and it is the single best thing to put on screen at second three of the video.

**Watchdog (#10).** Deliberately **not** an LLM. Three rules, all deterministic: (a) a step exceeding 3× its rolling p95 is a stall; (b) the same tool called with identical arguments three times is a loop; (c) run cost exceeding budget is a runaway. Any trigger → terminate, emit `agent_watchdog_intervention_total`, escalate to human with the partial trace. It renders on an "Agent Fleet Health" dashboard alongside step latency heatmaps and cost-per-incident. The pitch line: *"We instrumented the agent with the same observability stack the agent uses to fix production. When the agent breaks, the agent's own SRE catches it."*

**Rehearsal (#12).** Ninety minutes before kickoff, inject a synthetic avail into a canary session and walk all eight stages, asserting each one. Output is a pass/fail gate with a per-stage report: cue signaled ✓, marker in manifest ✓, ADS responded in 340ms ✓, creative cache warm ✓, stitch clean ✓, beacons acknowledged ✓. This converts AdBreak from "detects failures" to "prevents them," which is a materially stronger product story, and it costs almost nothing once the pipeline and detectors exist.

**Replay mode (#14).** Every chaos run records the full telemetry window to durable storage. Replay re-serves that window to the agent as if live. Same inputs, same tool responses, real agent reasoning. This exists so that if the live plant hiccups during recording — and it will — we have a deterministic path to a clean take that is still an honest demonstration. It is also how the eval harness runs fast in CI.

**Learned runbook proposal (#16).** When an incident's failure class doesn't map to any runbook, the agent drafts one in the YAML schema, with preconditions derived from the evidence it actually gathered, and opens a **pull request**. It never self-applies. Human merges it. Next occurrence, it's a known playbook. This is the most defensible version of "self-improving agent" — and the fact that it's gated is the point, not a limitation.

## 12. The eval harness

> **Deadline note (27 Aug):** the CI-integrated 25-scenario harness is cut for 9 Sep. What ships instead: the same scenario YAML and assertions below, run as a **manual replay-check script** (~10 repeated runs on F07/F03, scored). The video still closes on real, honest numbers; GitHub Actions integration is the first post-deadline task. The section stands as the design.

**This is the most under-appreciated point of leverage in the entire build.** Almost nobody at a hackathon can answer "how do you know it works?" with anything but a demo. We answer with a scoreboard.

`evals/scenarios/*.yaml` — 25 scenarios covering all 11 fault classes plus clean controls:

```yaml
id: EV-011
name: Beacon blackhole on Roku via CDN-East during peak
faults:
  - {id: F07, at_s: 120, params: {device_class: roku, cdn: east}, duration_s: 400}
load: {sessions: 1200, channel: sports-1, region_mix: {us-east: 0.5, us-west: 0.3, eu: 0.2}}
ground_truth:
  failure_class: F07
  stage: beacon
  root_cause_dimensions: {device_class: roku, cdn: east}
  correct_runbook: rb-beacon-fallback
  expected_leak_usd_range: [30000, 52000]
assertions:
  detected_within_s: 90
  rca_correct: true
  runbook_correct: true
  no_false_remediation: true
  resolved_within_s: 300
  cost_usd_max: 0.25
```

Scored metrics, tracked per commit and rendered — of course — on a Grafana dashboard:

- **MTTD** (alert → detection), **MTTR** (detection → verified recovery)
- **RCA top-1 accuracy** and **top-2 accuracy**
- **Runbook selection accuracy**
- **False remediation rate** ← the most important safety number; target 0%
- **Clean-control false positive rate** (scenarios with no fault injected)
- **Cost per incident**, **tokens per incident**
- **Dollars recovered / dollars lost**

Runs in GitHub Actions on every PR in replay mode. A regression in RCA accuracy fails the build.

Two things this buys us: the video can end on a real scoreboard ("23/25 scenarios, 0 false remediations, median MTTR 41 seconds against a 22-minute human baseline"), and it forces the agent to actually be good rather than demo-good.

## 13. Repository layout

```
adbreak/
├── LICENSE                       # Apache-2.0 — must be detectable in GitHub's About sidebar
├── README.md                     # what it is, 90-second quickstart, architecture, demo GIF
├── VISION.md                     # this document
├── docs/
│   ├── architecture.md
│   ├── failure-taxonomy.md
│   ├── telemetry-contract.md
│   ├── runbook-authoring.md
│   └── demo-script.md
├── plant/                        # the simulated broadcast pipeline
│   ├── playout/
│   ├── encoder/                  # ffmpeg wrapper + source loop
│   ├── packager/
│   ├── ad-decision-server/
│   ├── conditioner/
│   ├── ssai/
│   ├── cdn/                      # envoy config + fault filter
│   ├── player-fleet/
│   ├── beacon-collector/
│   └── chaos-injector/
├── agent/
│   ├── workflow.py               # the SequentialAgent — the DAG lives here
│   ├── steps/                    # one module per step, each with its output schema
│   ├── tools/
│   │   ├── grafana_mcp.py        # MCP client
│   │   ├── runbook_executor.py
│   │   └── ledger.py
│   ├── policy/
│   │   ├── blast_radius.py       # pure function, heavily unit-tested
│   │   └── gate.py
│   ├── watchdog/
│   └── telemetry/                # OTel instrumentation for the agent itself
├── runbooks/                     # 8 versioned YAML runbooks
├── dashboards/                   # Grafana JSON, provisioned as code
│   ├── revenue-realization.json
│   ├── signal-chain.json
│   ├── incident-detail.json
│   └── agent-fleet-health.json
├── evals/
│   ├── scenarios/                # 25 YAML scenarios
│   ├── runner.py
│   └── report.py
├── ui/                           # /trace viewer + incident view + ledger
├── infra/
│   ├── docker-compose.yml        # whole plant, one command
│   ├── terraform/                # GCP: Cloud Run, Firestore, Secret Manager, IAM
│   └── grafana/                  # datasource + dashboard provisioning
└── .github/workflows/
    ├── ci.yml                    # lint, test, blast-radius unit tests
    └── evals.yml                 # replay-mode eval suite, posts scoreboard to PR
```

## 14. Tech stack and hosting

| Layer | Choice | Rationale |
|---|---|---|
| Plant services | Go (packager, ssai, player-fleet — perf-sensitive), Python (playout, ads, chaos) | Go where we need 2k concurrent sessions |
| Encoder | ffmpeg in a container, looping source | Real HLS output |
| CDN sim | Envoy + fault filter | Real HTTP semantics, config-driven faults |
| Cue bus | Redis pub/sub | Trivial, observable |
| Agent | **ADK (Python)** on Cloud Run | Explicit workflow agents = the determinism story |
| Model | **Vertex AI Gemini** — Flash for classification, Pro for synthesis | Cost story + quality where it counts |
| Observability | **Grafana Cloud** (Mimir + Loki + Tempo + Alerting + Incident) | Free tier is sufficient; managed = one less thing to break on demo day |
| Partner interface | **Grafana MCP server** | Read *and* write. The judged integration. |
| State | Firestore (run traces, incidents, ledger) | Cheap, zero-ops |
| Secrets | Secret Manager | Never a committed key |
| UI | React + Vite, served from Cloud Run | Trace view, ledger, incident detail |
| IaC | Terraform | Reproducible, and it's a scored "enterprise" signal |

**Hosting plan:** one `e2-standard-4` GCE VM runs the entire plant via docker-compose (the plant is stateful and long-lived; Cloud Run is a poor fit). The agent, watchdog and UI run on Cloud Run with `min-instances=1` so the judge never hits a cold start. Grafana Cloud free tier. Estimated burn: **$40–70 for the full 45 days**, plus Gemini inference (trivial at Flash-heavy usage — budget $30).

The hosted URL for submission is the UI on Cloud Run, with a public read-only Grafana dashboard link and a live HLS playback URL alongside it. A judge should be able to click three links and see: the product, the telemetry, and the actual stream.

## 15. 13-day plan

**The 45-day plan is void.** The real deadline is **9 Sep 2026, 2:00 PM PDT** (10 Sep, 2:30 AM IST) — the 30 Sep date was the end of the *judging* window, not submission. As of 27 Aug the repo contains no code. This plan is priority-ordered by judged value: **killer features first, breadth second, mediocre features never.**

**Day 1 = 27 Aug. Submission complete = Day 13 (8 Sep) evening. Day 14 (9 Sep) is pure buffer.**

The build is a vertical slice: the thinnest end-to-end path that makes the F07 demo real, then the agent on top of it, then the twist (watchdog), then breadth (more faults), then ship. Nothing horizontal gets built before the F07 loop works.

### Phase A — the F07 vertical slice (Days 1–4, Aug 27–30)

**Day 1 (Aug 27):**
- GCP project, billing, Vertex AI enabled, Grafana Cloud account
- **Prove Grafana MCP read AND write from a local ADK agent today.** The track rules make the Grafana Cloud MCP server connection *mandatory*, so this is the first thing verified, not the thirtieth. If a specific write capability is missing, shim only that call via the HTTP API, keep every read on MCP, and disclose it (see risk 3).
- Repo initialized, Apache-2.0 LICENSE committed so GitHub's About sidebar shows it
- `docker-compose.yml` skeleton; telemetry contract (§8) stays frozen as-is
- ffmpeg → live HLS playing in VLC. **One rendition is enough**; the full ladder is a Phase D nicety.
- Decide solo vs. team **today** (§20) — rules cap teams at 4; even one collaborator on the plant materially raises the odds of shipping the full loop

**Days 2–3 (Aug 28–29):**
- Playout schedule + Redis cue bus + SCTE-35 emission
- Packager injecting `EXT-X-DATERANGE`/`CUE-OUT` at correct segment boundaries
- Mock VAST ADS with two knobs only: `latency_ms`, `fill_rate`
- SSAI stitch with correct discontinuity handling
- Player fleet: 200 sessions, all six beacon events; beacon collector recording confirmed impressions
- **Cut from the plant entirely: the conditioner (and F05 with it)**

**Day 4 (Aug 30) — ⚠️ GATE A: an ad break plays end-to-end and produces a billable impression record.** Also today: chaos injector with **F07 only**. If Gate A slips more than one day, execute §18 the same day — the decision is made on Day 5, not Day 10.

### Phase B — the money shot (Days 5–6, Aug 31 – Sep 1)

- OTel metrics per the §8 contract — **metrics first, logs second, traces only on the avail lifecycle**; exemplars only on `ads_response_duration_seconds`
- Two dashboards, not four: **delivery-health** (the all-green one) and **revenue-realization** (RRR + ledger)
- RRR computed, burn-rate alert firing
- Revenue Loss Ledger: deterministic $ attribution on a live panel

**⚠️ GATE B (Sep 1): inject F07 → every delivery panel green, RRR off a cliff, alert fires, ledger counts the loss in dollars.** Screen-record it the moment it works — it's the cold open and the insurance policy.

### Phase C — the agent (Days 7–10, Sep 2–5)

All nine steps, budget-conscious:
- Detect (alert webhook) → Triage (Flash) → Correlate (**two** parallel branches: PromQL signal-chain + dimensional slice; add the Loki/Tempo branches only if Phase B landed traces) → Hypothesize (Pro) → Falsify (**one** adversarial branch, not two) → Plan (lookup table) → Act → Verify → Document (annotation + incident + postmortem + CFO Brief)
- Blast-radius policy gate, unit-tested
- **One runbook: `rb-beacon-fallback`**, with its rollback path tested
- Firestore run persistence; minimal `/trace` UI — a table of steps with query, duration, tokens, cost is enough

**⚠️ GATE C (Sep 5): F07 detected → root-caused → remediated → verified → documented, autonomously, in under 90 seconds, on the live plant.** This is the submission. Everything after this line is bonus.

### Phase D — the twist, then breadth (Days 11–12, Sep 6–7)

Strict priority order — stop wherever the clock stops:

1. **Watchdog** (three deterministic rules) + agent self-telemetry + Agent Fleet Health dashboard + the on-camera agent-fault demo. Highest remaining value-per-hour on the board.
2. **F03/F04 + `rb-ads-failover`**, then **F08 + `rb-cdn-shift`** — breadth proves it isn't a one-trick pattern matcher
3. **Replay recording** of the best runs (demo insurance + fast repeat runs)
4. **Replay checks**: run F07/F03 scenarios ~10× scripted, score MTTD / MTTR / RCA accuracy / false-remediation rate — the honest numbers for the video's close
5. **Deploy** end of Day 12: plant on the GCE VM, agent + UI on Cloud Run `min-instances=1`, public Grafana dashboard, live HLS URL, README with a real quickstart

### Phase E — ship (Days 13–14, Sep 8–9)

- **Day 13 (Sep 8):** record in the morning — live take first, replay take as backup, capture the F07 green-dashboards moment several times. Edit to 3:00, burn in English captions, upload public (unlisted-is-not-public), verify in incognito. **Devpost submission the same evening**, track = Grafana, every URL verified from a logged-out browser.
- **Day 14 (Sep 9):** buffer, not work. If you are building on Day 14 you have already lost. The literal deadline is 2:30 AM IST on Sep 10 — treat **8 PM IST on Sep 9** as yours.

### Milestone summary

| Gate | Day | Date | Condition | Action if missed |
|---|---|---|---|---|
| **A** | 4 | Aug 30 | End-to-end ad break → billable impression | Cut to §18 L3 (detect + RCA only) same day |
| **B** | 6 | Sep 1 | F07: delivery green, RRR cliff, ledger ticking | F07 becomes the only fault; agent scope unchanged |
| **C** | 10 | Sep 5 | Full autonomous loop on F07, live | Ship RCA + dry-run plan awaiting approval; remediation shown, not executed |
| **D** | 12 | Sep 7 | Hosted and stable | Submit with local-run recorded video, disclosed in README |

## 16. The demo

Three minutes. No cinematic intro — the rules explicitly say a functional demo, not a trailer. Every second is the product working.

| Time | Beat | On screen |
|---|---|---|
| **0:00–0:12** | **Cold open — the money line.** "A single ad break on a national live match is worth forty thousand dollars. This one earned nothing. Every dashboard says the stream is healthy." | Split screen: left, a conventional uptime dashboard, all green, 100% availability, zero 5xx. Right, the Revenue Ledger ticking upward in red. |
| **0:12–0:30** | **What it is.** "AdBreak is an SRE agent whose SLO is revenue, not uptime." Architecture card, 6 seconds, then straight back to the product. | One clean architecture frame. Do not linger. |
| **0:30–0:55** | **Inject the fault, live.** F07 — beacon blackhole on Roku via CDN-East. Show the chaos command. Then show the CDN dashboard: green. Player QoE: green. Rebuffer ratio: flat. Then RRR: falling off a cliff. Burn-rate alert fires. | The contrast between the green panels and the falling RRR *is* the pitch. Hold on it. |
| **0:55–1:50** | **The agent works.** `/trace` panel on the left, Grafana on the right. Watch it: triage → four parallel correlation branches (show the actual PromQL and TraceQL it wrote) → hypothesis with 0.87 confidence → **falsification step killing the runner-up hypothesis** → blast radius computed as T1, auto-approved → `rb-beacon-fallback` executes → RRR recovers → verification passes. The Grafana annotation appears **live, in Grafana, on camera.** | Narrate the determinism: "the LLM never chose the runbook — a lookup table did." Show the elapsed clock: 47 seconds. |
| **1:50–2:15** | **The twist.** Cut to "Agent Fleet Health." Every step, tool call, token and dollar from the run just completed. Then inject a fault **into the agent** — stall a tool call. Watchdog detects, terminates, escalates, annotates. "We instrumented the agent with the same stack the agent uses. When the agent breaks, the agent's own SRE catches it." | This is the twenty seconds judges will remember. |
| **2:15–2:35** | **The artifacts.** Incident record. Postmortem with the timeline. CFO Brief: "$41,280 at risk, $38,900 recovered at T+47s." | Real documents, not mockups. |
| **2:35–3:00** | **Proof and close.** The replay scoreboard: repeated scripted runs, RCA accuracy, **zero false remediations**, median MTTR vs. a 22-minute human baseline, cost per incident. "Every number on this screen comes from scripted, repeatable replay runs — the assertions are in the repo." | End on the scoreboard + the ledger's recovered-dollars total, not on a logo. |

**Narration rules:** no music over dialogue, burn in English captions, screen-record at 1080p minimum, and cut all dead air — three minutes is brutally short and the F07 reveal plus the watchdog beat are non-negotiable.

## 17. Risk register

| # | Risk | P | Impact | Mitigation |
|---|---|---|---|---|
| 1 | **SCTE-35 / HLS plumbing eats the schedule** | High | Fatal | Gate A at Day 4 (Aug 30). We own the packager and SSAI ourselves precisely to avoid fighting third-party tools. If Gate A slips more than a day, cut immediately. |
| 2 | Live plant flakes during video recording | **High** | Severe | **Replay mode (#14).** Record the live take first; if it's ugly, the replay take is deterministic, still real, and honest. Also: record the morning of Day 13 (Sep 8), leaving the rest of the day plus the buffer day. |
| 3 | Grafana MCP server lacks a write capability we assumed | Medium | Severe | **Verify on Day 1**, not Day 10. Caution: the track rules make the **MCP server connection mandatory** — a wholesale HTTP-API fallback would break the track requirement. Keep every read on MCP; shim only the specific missing write via the HTTP API, and disclose it in the README. |
| 4 | ~~Agent gets F11 (the red herring) wrong on camera~~ | — | — | Retired: F11 is cut from the 13-day scope. The falsification step still demos on F07 (killing the runner-up hypothesis). F11 returns post-deadline. |
| 5 | Scope creep — 18 features is a lot | **High** | Severe | §18 ladder, and the P0/P1/P2 split is enforced at each gate. Features 16–18 are explicitly expendable. |
| 6 | Cloud Run cold start or plant VM dies during judging | Medium | Severe | `min-instances=1`, VM on a managed instance group with auto-restart, uptime check + alert to your own phone, and a recorded fallback linked in the README. |
| 7 | Cost overrun on Gemini during eval loops | Low | Minor | Flash-first, replay mode caches tool responses, hard budget ceiling enforced by the watchdog. |
| 8 | 1,000+ synthetic sessions overwhelm the dev machine | Medium | Moderate | Go for the fleet, accelerated wall clock in eval mode, and scale to 200 sessions locally / 1,200 on the VM. |
| 9 | Solo build, 13 days, day job | **High** | Severe | Phases A and C are the only true critical path. Phase D items 2–4 all drop cleanly. Solo realistically lands at §18 L1–L2; recruit one collaborator for the plant if at all possible (teams of up to 4 allowed). |
| 10 | Judges read "simulated pipeline" as "fake" | Low | Moderate | Pre-empt it in the video and README: real HLS, real SCTE-35, real VAST, real IAB beacons, playable URL. Show the stream playing in a real player for two seconds. |

## 18. Scope-cut ladder

Rebuilt for the 13-day clock. Cut in this order; each level is still a coherent, submittable project.

- **L0 — the §15 plan in full.** F07 autonomous loop + watchdog + F03/F04/F08 breadth + replay checks.
- **L1 — drop breadth.** F07 is the only fault, `rb-beacon-fallback` the only runbook, replay checks on F07 only. *Loses "not a one-trick pony"; keeps every killer beat of the video.*
- **L2 — drop the watchdog.** *Loses the twist — the twenty seconds judges remember. Only if Day 11 has evaporated.*
- **L3 — drop remediation.** Detect + RCA + document, with the plan, blast radius and predicted impact rendered as a dry run awaiting approval. *Still a strong diagnostic agent with real MCP write-back.*
- **L4 — replay-only.** No live plant at judging time; the agent runs against recorded telemetry. *Weakest acceptable version. Disclose it in the README — a judge who discovers it themselves will penalize you far harder than one you told.*

**Never cut, at any level:** the F07 story, the Revenue Ledger, Grafana MCP write-back, the `/trace` view, or video-editing time. A slightly worse project with a clean 3-minute video beats a better project with a rushed one.

**Already cut before L0 — do not resurrect before Sep 9:** conditioner/F05, F01, F02, F09, F10, F11, the CI eval harness, Rehearsal, Chaos Ladder, learned-runbook PRs, chat interrogation, Slack.

## 19. Judging traceability

| Requirement | Where satisfied |
|---|---|
| Functional agent powered by Gemini | ADK `SequentialAgent`, 9 steps, Vertex AI Gemini Flash + Pro. `agent/workflow.py`. |
| Built on Google Cloud Agent Builder / Gemini Enterprise Agent Platform | ADK + Vertex AI; deployed on Cloud Run with Firestore state and Secret Manager. |
| Partner product genuinely integrated at runtime | Grafana MCP server, called in `agent/tools/grafana_mcp.py`, **read and write** — queries Mimir/Loki/Tempo, creates annotations, dashboards and incidents. Removing Grafana removes the product. |
| Real media & entertainment workflow | Live linear ad insertion — SCTE-35, SSAI, VAST, IAB beacons. The failure taxonomy is drawn from real ad-ops failure modes. |
| **Deterministic, multi-step** | Control flow is code, not model choice. Runbook selection is a lookup table. The policy gate is a pure function. The `/trace` UI renders the DAG. Scripted replay checks prove consistency across repeated runs. |
| Solves enterprise friction | Revenue leakage in live ad insertion, quantified in dollars per incident, with a measured MTTR improvement against a human baseline. |
| Hosted URL | Cloud Run UI + public Grafana dashboard + live HLS playback URL. |
| Public repo, complete source, runnable | `docker compose up` for the plant; Terraform for cloud; README quickstart; seed data included. |
| OSS license detectable in About | Apache-2.0 at repo root, committed Day 1. |
| 3-minute demo video, public, English | §16. Burned-in captions. |
| Track selection | **Grafana.** |

## 20. Open decisions

Things to settle in Phase 0, before code:

1. **Solo or team?** If team of 2–3, the natural split is: one person owns `plant/` + `chaos/` (Phases 1–2), one owns `agent/` + `runbooks/` (Phases 3–4), one owns `ui/` + `evals/` + `dashboards/`. The telemetry contract in §8 is the interface that lets them work in parallel from Day 4. If solo, Phase 1 and Phase 3 are sequential and L2 is the realistic target.
2. **Grafana Cloud vs. self-hosted Grafana.** Recommendation: Cloud. Free tier covers this, the managed stack is one fewer failure mode on demo day, and the partner track judge will be a Grafana person who'd rather see their product than a container.
3. **Content source for the encoder.** Needs to be something we can legally show on YouTube. Use Blender Foundation open-movie content (Tears of Steel / Big Buck Bunny, CC-BY) or self-shot footage. Decide Day 1, note the attribution in the README.
4. **eCPM model.** Flat $32 eCPM or a per-advertiser table? Recommendation: a small table with 4 advertisers at differing rates — it makes the ledger richer and enables per-advertiser attribution in the CFO Brief at almost no cost.
5. **Does Grafana Incident exist on the free tier?** Verify Day 1. If not, model incidents in Firestore and annotate Grafana — the write-back story survives intact.
6. **Human-approval surface for T2+.** Simplest option: a card in our own UI. Slack is nicer but is P2. Recommendation: build it in the UI, mention Slack as roadmap.

---

## The one-sentence pitch

*AdBreak is an SRE agent for the money, not the machines: it watches the live ad-insertion chain end to end, catches the revenue failures that leave every dashboard green, root-causes them by correlating metrics, logs and traces through Grafana, repairs them with policy-gated deterministic runbooks, and is itself watched by the same observability stack it operates.*

---

*Document version 2.0 — 27 Aug 2026. Owner: div18. **Deadline: 9 Sep 2026, 2:00 PM PDT (10 Sep, 2:30 AM IST).** Track: Grafana. v1.0 planned against 30 Sep — that was the judging window, not the submission deadline; §15 and §18 are rebuilt for the 13 days that actually remain.*
