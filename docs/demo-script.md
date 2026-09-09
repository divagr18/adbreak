# AdBreak demo script — recorded cut 3

This version follows one visible cause-and-effect path. Every technical claim is paired with an interaction or changing runtime surface. The first fault and revenue evidence appear within 20 seconds.

| Time | Voiceover | Screen |
|---|---|---|
| 00:00–00:07 | What if your broadcast network could fix its own ad revenue leaks? | The tagged Roku, US East, CDN East channel is visibly playing. |
| 00:07–00:13 | I’ll block ad reporting for Roku. The stream itself keeps running, so an uptime monitor would call this healthy. | Hover and click **Block Roku reporting**; the deployed plant confirms F07. |
| 00:13–00:21 | But the revenue telemetry catches the gap. Ads are playing while their billable impressions disappear. | Live Grafana revenue panels update and scroll into the detailed breakdown. |
| 00:21–00:32 | AdBreak opens an incident, queries delivery and ad-server signals through Grafana MCP, and isolates the failure to Roku reporting. | Open the incident and expand triage, then the dimensional correlation evidence. |
| 00:32–00:43 | Before it changes anything, the agent tries to kill its own diagnosis. The reporting hypothesis survives those checks. | Expand and scroll through the falsification results. |
| 00:43–00:56 | It selects the beacon fallback runbook. This change is within the allowed blast radius, so AdBreak switches Roku to server-side reporting. | Open the plan and act steps; the executed POST and `status: 200` are visible. |
| 00:56–01:08 | Then it waits for a complete ad break and verifies live telemetry. Recovered is true, and the residual impression gap is zero. | Open verify and scroll through the recovery samples. |
| 01:08–01:14 | The whole diagnosis, action, and verification trail stays attached to the incident. | Collapse back to the completed incident summary. |
| 01:14–01:22 | And the viewer never lost the broadcast while AdBreak repaired its accounting path. | Return to uninterrupted channel playback. |
| 01:22–01:34 | Now consider a broader failure: the ad server returns no inventory. AdBreak finds a fallback, but replacing inventory affects the whole region. | Open the F04 incident and expand its proposed plan. |
| 01:34–01:48 | That crosses the policy boundary. The plan is ready, but the act step says nothing executed until an operator approves it. | Scroll from the T2 approval plan into `executed: false`. |
| 01:48–01:59 | Approval is not a rubber stamp. AdBreak rechecks live preconditions, and if the situation changed, the old plan is rejected as stale. | Open the approval recheck showing the plan had gone stale. |
| 01:59–02:05 | There is one more failure mode: the agent itself can get stuck. Here I force a repeated tool loop. | Click **Force agent loop** in the operator console. |
| 02:05–02:17 | The watchdog sees the same query repeat, terminates the run, and preserves the partial evidence for the operator. | Open the killed run and scroll across the watchdog evidence. |
| 02:17–02:25 | Grafana monitors the agent too: successful repairs, watchdog interventions, latency, and model spend. | Live Agent Fleet Health panels update and scroll. |
| 02:25–02:33 | Every successful repair also produces a postmortem with the fault, action, evidence, and prevention steps. | Scroll through the generated NOC postmortem. |
| 02:33–02:41 | This recorded run repaired the fault in 84 seconds, verified recovery in four minutes ten, and cost roughly two cents. | Return to the measured incident header and timing fields. |
| 02:41–03:00 | AdBreak is an autonomous revenue SRE built with Gemini on Vertex AI, Google’s Agent Development Kit, and Grafana MCP. Keep the broadcast playing. Keep the ad revenue accounted for. | Finish on the live tagged channel, visibly playing. |

## Recording facts

- Successful F07 run: `ccff7fff`.
- Remediation time: 83.5 seconds.
- Verified recovery: 250.2 seconds.
- Model cost: $0.0212.
- Verification result: `recovered: true`, `residualGap: 0`.
- Parameterized channel: `device_class=roku`, `region=us-east`, `cdn=cdn-east`.
- Final footage is silent so the narration can be recorded separately.
