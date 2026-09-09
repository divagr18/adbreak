# AdBreak: three-minute screen recording

Prepared 2026-09-09. User direction: show the project working within the first 15–20 seconds. Plain screen recording and human voiceover, with simple cuts and no graphics work.

## Rules that shape this recording

Official source read: https://agentic-cinema.devpost.com/rules

The video should be at most three minutes, show working functionality, be public on YouTube or Vimeo, and use English or English subtitles. Judging weights implementation, design, impact, and idea equally. Grafana MCP must be used at runtime; observability alone is insufficient. The hosted project and public licensed repository must support testing. The rules also restrict third-party content and non-Google AI/agent tooling. This note records a reading, not acceptance of terms or a full eligibility audit.

## Recommended sequence

Open on an actual incident and reveal the verified outcome by second 20. Then walk through how it happened. Use the same incident throughout the main story; say that waiting time was cut. Do not imply the system recovered in 20 seconds.

| Time | Screen action | Voiceover direction |
|---|---|---|
| 0:00–0:06 | Grafana Delivery Health during F07: CDN availability and errors. | “This stream looks healthy.” |
| 0:06–0:11 | Revenue Realization at the same incident time: Roku gap or RRR cliff. | “But Roku ad impressions have stopped reaching the billing record.” |
| 0:11–0:20 | Cut to that incident's completed trace. Expand verify; show recovered and residual gap. | “AdBreak found the reporting failure, switched to server-side reporting, and verified impressions returned. This recording cuts out the wait.” |
| 0:20–0:38 | Hold revenue chart with expected versus realized and device split. | Name broadcaster operations as the user. Explain expected versus confirmed billable impressions, and that this is a simulated broadcast plant. |
| 0:38–1:12 | Incident trace: triage, dimensional correlation, hypothesis, then falsify. Keep only the relevant detail expanded. | Show Gemini's diagnosis, actual PromQL through Grafana MCP, healthy upstream checks, and the Roku-only scope. Explain the attempt to disprove the diagnosis. |
| 1:12–1:38 | Expand plan, then act. | Show lookup-selected beacon fallback, T1 permission, measured preconditions, and executed configuration patch. |
| 1:38–2:00 | Expand verify, then show incident timing and cost. | Explain that verification waits for a whole subsequent ad break. Distinguish repair time from verified recovery time. |
| 2:00–2:20 | Separate F04 incident: approval banner and act showing nothing executed. | A change to channel-wide inventory requires a human. Identify this as a separate safety test. Do not click approval on an old incident. |
| 2:20–2:40 | Agent Fleet Health, then a saved watchdog loop incident. | Grafana also watches the agent. A deterministic supervisor stops repeated calls and retains the partial trace. |
| 2:40–2:55 | Return to the main incident's business brief and verified result. | Explain the operational handoff and that recovered billing prevents future leakage; it does not retroactively recover missed inventory. |
| 2:55–3:00 | Hold the successful incident header. | “AdBreak gives broadcast operations an on-call agent for revenue leaks.” |

## Voiceover draft after the opening

For a broadcaster, an ad playing and an ad being billable are two different events. AdBreak compares expected impressions with confirmed reports. This is our simulated broadcast plant, with a real streaming pipeline and synthetic viewers.

Here is the incident behind that recovery. Gemini runs through Google's ADK on Vertex AI. The agent queries Grafana through its MCP server. It finds the gap on Roku while the other devices, ad server, and delivery metrics look healthy.

Before acting, it tries to disprove the diagnosis. It checks competing explanations, including missing ads and CDN errors. Those checks leave the beacon reporting failure as the supported cause.

The repair comes from a fixed runbook mapping. The agent checks the preconditions, passes the T1 policy gate, and switches Roku reporting to the server. The record shows the actual configuration change.

A successful request is only the start of verification. AdBreak waits for a whole subsequent ad break and measures whether impressions return. Here are the residual gap, time to repair, time to verified recovery, and model cost for this run.

This separate test shows where it stops. Replacing inventory across the channel needs human approval. The agent has prepared the plan, but nothing has executed.

The agent is monitored too. Grafana tracks its calls, latency, and cost. In this test, the supervisor caught repeated queries and stopped the run. The partial evidence remains available.

Once the repair is verified, AdBreak writes a technical postmortem and a business summary. Broadcast operations can see what failed, what changed, and whether billing resumed. AdBreak gives broadcast operations an on-call agent for revenue leaks.

## Surfaces inspected once

- `packages/agent/src/trace-ui.ts`: incident list and summary, individual run, expandable reasoning and PromQL, plan and rollback, act, verify, approval form, watchdog error, business brief and technical postmortem. Rendered the existing UI against saved records and inspected it in the browser.
- `dashboards/delivery-health.json`: CDN availability, 5xx, active sessions, stitch errors, latency, fetch errors, signal-chain counts.
- `dashboards/revenue-realization.json`: RRR, lost revenue, impression gap, device-class cliff, expected versus realized, device/CDN slices, fill and no-fill, slate, ADS latency.
- `dashboards/agent-fleet-health.json`: watchdog interventions, outcomes, model spend, cost per incident, step latency, tokens, detection/recovery time and remediation tiers.
- Stream URLs expose HLS manifests; there is no dedicated visual player page in the main application. Synthetic players do not render video. A playback shot requires a player and working stream. The core opening works with dashboards alone. Avoid including Big Buck Bunny footage or branded creatives in the submitted cut given the rules' third-party-content restrictions.
- Chaos injection and billing stats are API/terminal surfaces. Raw manifests, infrastructure listings and repository tours add little to this three-minute cut.
- Evaluation and gates provide supporting evidence, but are not the main visual narrative.

## Useful genuine saved records

- F07 success: `agent-data/agent-runs/506d395a.json`. T1 ALLOW; 77.6 seconds to remediation; 259.6 seconds to verification; cost $0.0193; verified residual gap 0. These figures belong together. Do not combine them with the different Gate C figures in README.
- F04 held: `agent-data/agent-runs/d1ef1ec8.json`. T2; awaiting approval; act executed false.
- Watchdog loop: `agent-data/agent-runs/c3234b7b.json`. Three repeated calls; stopped with partial trace retained.
- F08 escalation: `agent-data/agent-runs/fe87690f.json`. No mapped runbook. Optional reserve shot; omit from the main cut to protect pacing.

Old records lack the newer `revenueAtRiskUsd` and `revenueLeakAfterUsd` fields. Their overview renders $0.00 aggregates. Avoid that overview as financial proof. The saved business brief contains model-written dollar claims; substantiate them before narrating a dollar-loss number. Prefer measured impression gap and per-run timing/cost.

## Capture status and method

At inspection, both public hosts, trace.divagr.com and stream.divagr.com, returned Cloudflare error 1033. Docker Desktop's Linux engine was unavailable. Grafana reached its login screen in the connected browser; dashboards were inspected from their definitions, not authenticated live renders.

OBS is installed at `C:/Program Files/obs-studio/bin/64bit/obs64.exe`. FFmpeg is available at `C:/ffmpeg/bin/ffmpeg.exe`. Playwright is not installed in the project. No recording has been made or capture configuration tested yet.

Recommended capture: one application window at 1920x1080, 30 fps, silent clips with several seconds of handles, readable dashboard panels, deliberate cursor movement, and hard cuts assembled with FFmpeg. Record the long fault/recovery sequence once; cut its waiting periods. Record the approval and watchdog examples separately. User records the voiceover against the assembled timeline. Aim for a final file slightly under three minutes.

A read-only saved-record preview was created at `data/demo-prep/preview.ts`, served on `http://127.0.0.1:8091/trace`. It uses the project's renderer and adds a saved-record label; POST actions are disabled. It may need restarting with `node node_modules/tsx/dist/cli.mjs data/demo-prep/preview.ts`. This is suitable for rehearsal and transparently identified historical trace shots, not evidence that the live plant currently works.

Before recording the complete flow, restore the chosen plant and tunnel, authenticate the recording browser to Grafana, and establish one coherent incident time window. Follow the repository's one-plant-per-Grafana guidance; do not start local telemetry alongside deployed telemetry without checking the handover state.
