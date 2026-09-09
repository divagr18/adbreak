# AdBreak demo script — draft 2

Direction: follow the user's Fabric demo rhythm: question as pitch, concrete action, visible result by 20 seconds, explanation after proof, then a second challenge. The tagged live stream is central. Plain screen recording and human VO; no designed graphics.

The first payoff is detection and localization by second 20 of the edited video. Repair follows within the first minute. Capture the genuine process and cut waiting time; the VO explicitly marks the first time jump. Do not imply real-time detection or recovery within the edited duration.

| Time | Voiceover | Screen |
|---|---|---|
| 00:00–00:06 | What if your broadcast network could fix its own ad revenue leaks? | Playing stream, with its session parameters visible. |
| 00:06–00:10 | So, I'll block ad reporting for our Roku viewers. | Execute the prepared F07 injection; return to playback. |
| 00:10–00:16 | The video keeps playing. Skipping the alert wait, watch what AdBreak catches. | Playback continues; cut to the Roku impression gap and incident. |
| 00:16–00:20 | There it is. Missing impressions, isolated to Roku. | Incident's dimensional findings identifying Roku. |
| 00:20–00:29 | The ad played, but its billing report never arrived. A healthy stream can still lose money. | Same tagged stream beside the revenue evidence. |
| 00:29–00:39 | AdBreak checks the ad server and delivery metrics through Grafana MCP, then tries to disprove its diagnosis before acting. | Actual PromQL, hypothesis, falsify results. |
| 00:39–00:49 | The checks point to reporting. It selects the approved runbook and switches Roku to server-side reporting. | Plan: T1 ALLOW and measured preconditions. Act: executed patch. |
| 00:49–00:59 | And after the next complete ad break, impressions are coming through again. The stream kept playing throughout. | Cut forward to verified residual gap zero; show playback from the same test. |
| 00:59–01:10 | That is AdBreak: an autonomous revenue SRE for broadcast operations, built with Gemini on Vertex AI and Google's Agent Development Kit. | Completed incident, model labels, timing and cost. |
| 01:10–01:22 | This is our simulated broadcast plant. The live channel takes device, region, and CDN parameters, while 200 synthetic viewers exercise the ad pipeline. | Show device_class=roku, region=us-east, cdn=cdn-east and active fleet count. |
| 01:22–01:32 | This run repaired the fault in 78 seconds and verified recovery in about four minutes twenty, for roughly two cents in model cost. | Actual figures from run 506d395a; replace together for a fresh run. |
| 01:32–01:38 | Now, I'll make the ad server stop returning ads. | Begin a separate F04 test; show injection response. |
| 01:38–01:49 | AdBreak finds the no-fill problem and prepares a fallback. But this change would replace inventory across the channel. | F04 diagnosis, cached-inventory runbook, scope. |
| 01:49–01:59 | So it stops here. The plan is ready, but nothing executes until an operator approves it. | T2 approval banner and act: executed false. |
| 01:59–02:09 | Approval rechecks the live conditions first. If the situation has changed while the operator was away, the old plan doesn't get a free pass. | Plan preconditions and approval explanation. Do not click an old historical approval. |
| 02:09–02:15 | Now, what happens if the agent itself gets stuck? | Begin the separate watchdog loop test. |
| 02:15–02:26 | Here, we've forced repeated tool calls. Its watchdog catches the loop and stops the run, keeping the evidence it collected. | Watchdog loop reason and retained partial trace. |
| 02:26–02:37 | Grafana watches the agent too: its latency, model spend, and watchdog interventions. The operator can inspect the system doing the repairs. | Agent Fleet Health panels. |
| 02:37–02:49 | After a successful repair, AdBreak writes the incident report. The next operator can see what failed, what changed, and how recovery was verified. | Main F07 incident's postmortem and verify step. |
| 02:49–02:55 | You can inspect the incident traces and try the live channel at the project links. | Working public incident page, then live stream. |
| 02:55–03:00 | Keep the stream playing. Keep the ad revenue accounted for. | Playing stream and verified recovery result. |

## Recording notes

- Parameterized stream target: `https://stream.divagr.com/session/demo/playlist.m3u8?device_class=roku&region=us-east&cdn=cdn-east`. The query tags the session; a browser with that tag is not a physical Roku. Use an HLS-capable player, and keep the selected parameters legible.
- Browser playback alone does not prove billing. The synthetic fleet has the tracking implementation; pair playback with measured fleet/collector evidence. Do not describe an ordinary HLS player as firing the fleet's beacons unless implemented and verified.
- F07 success reference: `agent-data/agent-runs/506d395a.json`. Its actual values: 77.6s to remediation, 259.6s to verification, $0.0193 model cost, residual gap 0.
- F04 hold reference: `agent-data/agent-runs/d1ef1ec8.json`. Watchdog loop reference: `agent-data/agent-runs/c3234b7b.json`.
- The future-tense live actions in the script require fresh test footage. If using historical records instead, change “I'll” to “In this test, we” and identify the recorded test. Never pair a new injection with an unrelated old recovery as if they were one run.
- The stream continuity claim requires continuous source footage through the F07 test. Record the whole incident, then cut waits for pacing.
- Public stream and trace hosts returned Cloudflare 1033 during orientation; local Docker was stopped; Grafana requires browser authentication. Restore access before capture. No capture has been performed.
- For submission footage use original or organizer-cleared stream content; the rules restrict third-party content. The current README attributes the demo video to Big Buck Bunny.
- Official rules read 2026-09-09: https://agentic-cinema.devpost.com/rules. Keep final video at or under three minutes and include real runtime Grafana MCP evidence. See demo-plan.md for orientation notes; this draft supersedes its timing and opening.
