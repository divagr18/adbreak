# AdBreak: An AI Revenue Reliability Agent for Live Streaming and Broadcast Media

> AdBreak uses Gemini on Vertex AI and the official Grafana MCP server to detect, trace, and repair silent ad revenue leaks across live broadcast delivery pipelines before viewers or advertisers notice.

[Personalized HLS Stream](https://stream.divagr.com/session/demo/playlist.m3u8?device_class=web&region=us-east&cdn=cdn-east) · [Live Agent Trace UI](https://trace.divagr.com/trace) · [Watch the Demo (YouTube)](https://youtu.be/7Q-yO0Z3GRc) · [Revenue Realization Dashboard](https://petitesandpiper3092.grafana.net/public-dashboards/5dd92f11c68d4dd3a8123d1facc2a736) · [Delivery Health NOC Dashboard](https://petitesandpiper3092.grafana.net/public-dashboards/b09da6f7c5a4401f8f197e65ad2759c0) · [Agent Fleet Health Dashboard](https://petitesandpiper3092.grafana.net/public-dashboards/95d4a6259bb74559b9d223336ab144cb) · [Explore the Source Code (Apache 2.0)](https://github.com/divagr18/adbreak)

---

### Inspiration: The Silent Uptime Illusion

What if a broadcast could look completely healthy while its ad revenue quietly disappeared?

That happens when the video keeps playing but an ad server returns no ads, stitching fails, or tracking beacons never reach the billing system. Delivery dashboards stay green, viewers see no outage, and the loss may remain hidden until reconciliation.

AdBreak watches **Revenue Realization Rate (RRR)**, the share of expected ad revenue that is confirmed by billable impressions:

$$\text{RRR} = \frac{\text{Confirmed Ad Revenue}}{\text{Expected Ad Revenue}}$$

When revenue and delivery diverge, AdBreak uses Gemini on Vertex AI and the official Grafana MCP server to investigate the signal chain, choose a pre-approved runbook, and verify the result against live billing telemetry.

---

### What It Does

AdBreak compares video delivery with expected and confirmed ad impressions across devices, CDNs, and regions. When those signals diverge, Gemini investigates upstream ad decisions and downstream delivery in parallel, then tries to disprove its own diagnosis before a fix is allowed.

The model never writes executable fixes. A verified diagnosis can only select a versioned runbook, and the incident closes only after live impression counters show that revenue recovered. Failed fixes are rolled back.

#### Demonstrated Workflow 1: Device-Class Beacon Blackhole

An edge fault blocks tracking beacons from Roku sessions while their video segments continue to return HTTP 200. AdBreak localizes the loss to the beacon stage, selects `rb-beacon-fallback`, switches that device class to server-side reporting, and verifies that confirmed impressions return.

#### Demonstrated Workflow 2: Ad Server No-Fill

The ad server returns empty ad pods across a region. AdBreak selects `rb-ads-failover`, but the change would affect every viewer in that region, so it waits for approval. When the operator clicks **Approve**, AdBreak rechecks the live conditions, applies the cached fallback, and verifies recovery.

---

### First-Class Human Collaboration (HITL)

Many AI agents either execute unchecked actions or stop at a written recommendation. AdBreak includes human operators directly in the control loop:

* **Blast-Radius Policy Gating (T0–T3):** Every runbook has a strictly enforced blast-radius classification. Low-impact actions (e.g., switching a single device class to server-side beacon reporting) qualify as **Tier 1** and run automatically. High-impact operations that alter video creative delivery for all viewers (e.g., enabling fallback ad inventory) are flagged as **Tier 2** and require human sign-off.
* **Non-Blocking Approval Cards:** When a Tier 2 action is planned, AdBreak halts execution and renders a structured approval card directly on the Live Trace UI, presenting the financial loss rate, root-cause evidence, and exact runbook parameters.
* **Pre-Execution Telemetry Re-Measurement:** Human operators may take several minutes to review an alert. Before applying an approved runbook, AdBreak re-evaluates all preconditions against live Grafana metrics to guarantee the incident state has not drifted. If the issue self-resolved in the interim, the stale plan is rejected without execution.

### Why AdBreak Is a Strong Fit for Grafana MCP

Grafana already contains the signals needed to understand whether an ad break played, reached viewers, and generated billable impressions. The official Grafana MCP server gives AdBreak one consistent way to read those metrics.

The agent uses that evidence to trace a loss to the broken stage, test its diagnosis, and verify that a fix restored revenue. It also writes its plan and final outcome back to Grafana, so operators can inspect the full decision trail in the Live Trace UI.
---

### Architecture and Google Cloud Stack

AdBreak combines a media simulation with Google Cloud AI and Grafana Cloud observability:

* **Broadcast plant:** A fourteen-service Compose stack models playout, SCTE-35 signaling, ad decisions, SSAI, edge delivery, 200 players, beacon collection, and billing.
* **AI agent:** Gemini runs on Vertex AI through Google's Agent Development Kit. Deterministic code controls runbooks, approvals, verification, rollback, and watchdog limits.
* **Observability:** Grafana Alloy ships plant metrics and structured logs to Grafana Cloud, while OpenTelemetry captures traces across the ad-break path. The agent reads live metrics and writes its decisions back through Grafana MCP.
---

### How the Agent and MCP Are Implemented

AdBreak follows a simple loop: detect a revenue gap, diagnose the broken stage, choose a safe response, and prove that revenue recovered.

Gemini handles the investigation and explanation. The actions remain controlled by code: a diagnosis can only select an existing runbook, broad changes wait for operator approval, and every fix is checked against fresh Grafana telemetry. If the numbers do not recover, AdBreak rolls the change back.
---

### Engineering Challenges Overcome

* **The Bounded Cadence Problem:** A fix cannot prove itself until later ad breaks produce new impressions. AdBreak waits for complete post-fix cycles and compares the new expected and confirmed impression totals, so losses from the break already in progress do not distort the result.
* **Eliminating Hallucinated Remediation:** LLMs frequently invent speculative shell commands or invalid configuration flags. We eliminated model-generated code entirely: Gemini formulates the root cause, while remediation uses the versioned `rb-beacon-fallback` and `rb-ads-failover` runbooks. Unmapped failure scenarios (such as major CDN transit blackouts) escalate safely to human engineers instead of improvising.
* **The Stale Approval Window:** When human approval takes several minutes, the underlying broadcast state can change. We implemented mandatory precondition re-evaluation that queries live Grafana telemetry when an operator clicks Approve, rejecting stale plans if conditions shifted.
* **Infinite Loop & Spend Runaways:** We implemented an external, model-free supervisor watchdog that halts repeating query loops, bounds reasoning cost to <$0.05 per incident, and preserves partial triage traces for human inspection.

---

### Measured on the Live Plant

We injected faults without telling the agent and compared its conclusions with a separate ground-truth record that the agent could not access.

| Measure | Recorded result |
| :--- | :--- |
| Root-cause accuracy | 100% across 9 fault scenarios |
| Correct runbook selection | 100% across 9 fault scenarios |
| Correct handling | 100% across all 11 scenarios |
| Mean time to recovery | 78.6 seconds |
| Mean reasoning cost | $0.0166 per incident |
| False remediations | 0 |

We also tested the safety controls: the watchdog stopped stalled, looping, and over-budget runs; broad changes waited for approval; healthy runs continued normally; and failures without a safe runbook were handed to an operator.
---

### What's Next

* **Predictive ADS Pre-warming:** Pre-querying ad decision servers ahead of incoming SCTE-35 markers to detect depleted ad inventories before the splice cue fires.
* **Dynamic Multi-CDN Bidding Protection:** Extending the Revenue Realization SLO to OpenRTB / Prebid Mobile exchanges to catch client-side auction timeouts during programmatic live streaming.

---

### Testing Instructions for Hackathon Judges

Everything needed to understand AdBreak is public and requires no login:

1. Watch the [demo video](https://youtu.be/7Q-yO0Z3GRc).
2. Open the [Live Agent Trace UI](https://trace.divagr.com/trace) and select an incident to see what failed, what evidence the agent found, and what it did next.
3. Compare [Delivery Health](https://petitesandpiper3092.grafana.net/public-dashboards/b09da6f7c5a4401f8f197e65ad2759c0) with [Revenue Realization](https://petitesandpiper3092.grafana.net/public-dashboards/5dd92f11c68d4dd3a8123d1facc2a736). The key result is visible when delivery stays healthy while billable impressions fall.

The [source repository](https://github.com/divagr18/adbreak) includes the local setup and fault-injection commands for a full reproduction.

---

### Open-Source License

AdBreak is open-source software under the [Apache License 2.0](https://github.com/divagr18/adbreak/blob/master/LICENSE). The license permits use, modification, and distribution subject to its terms.

The demo stream uses *Big Buck Bunny* under CC BY 3.0. The repository generates its own color-card ad creatives and test audio.
