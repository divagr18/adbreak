# AdBreak

**Revenue SRE for live streaming.**

> Your stream was up. Your revenue was down. Nobody paged.

An autonomous SRE agent whose SLO is not uptime — it is **money per ad avail**. AdBreak
watches the live ad-insertion chain (SCTE-35 → packager → ad decisioning → SSAI stitch →
CDN → player beacons), detects revenue leaks that every conventional dashboard reports as
healthy, root-causes them through Grafana via the Grafana MCP server, repairs them with
policy-gated deterministic runbooks, and is watched by the same observability stack it
operates.

Agentic Cinema hackathon — **Grafana track**.

## See it running

| | |
|---|---|
| Personalized HLS stream | `http://34.135.234.146:8084/session/demo/playlist.m3u8?device_class=web&region=us-east&cdn=cdn-east` |
| Agent run traces | http://34.135.234.146:8090/trace |

The trace UI is the thing to look at: every run shows each step, the PromQL it issued,
what it concluded, how long it took, what it cost, and — where relevant — why it decided
**not** to act.

The plant runs continuously. The SLO is computed over a 15-minute window, so give it that
long after any restart before judging it by its dashboards.

## Results

Both gates run against the live plant. Faults are injected without telling the agent, and
its conclusions are graded against `data/ground-truth.jsonl` — a ledger the agent's
container cannot mount.

**Gate C — can it handle an incident alone? 14/14**

```
detect → remediate          67.1s
detect → verified recovery  248.8s
cost per incident           $0.0208
false remediations          0 across the control window
```

**Gate D — can it be trusted? 7/7**

| | |
|---|---|
| watchdog kills a stalled / looping / runaway run | keeps the partial trace |
| a healthy run is **not** killed | the regression that matters most |
| F04 is diagnosed, classified T2 and **held** for a human | nothing executed |
| approving it executes and verifies | with the fault still injected |
| F08 has no runbook, so it escalates | rather than improvising |

`detect → verified recovery` is bounded by the plant, not the agent: a fix cannot prove
itself until a whole ad break has run after it landed, and the break already in flight
when it arrives is unrecoverable. That is roughly two break cadences. The agent's own
contribution is the 67s to remediation.

## Quickstart

```bash
docker compose up --build            # the whole plant, 14 services
npx tsx scripts/q.ts health          # is the plant settled enough to measure?
```

Then inject the flagship fault — a beacon blackhole on one device class — and watch every
delivery metric stay green while the money disappears:

```bash
curl -X POST localhost:8086/inject -H 'content-type: application/json' \
  -d '{"fault":"F07","params":{"device_class":"roku"},"duration_s":600}'

curl localhost:8086/faults           # the whole catalogue, self-describing
curl -X DELETE localhost:8086/inject
```

Watch the agent pick it up at http://localhost:8090/trace — or run the gates yourself:

```bash
npx tsx scripts/gate-c.ts            # autonomous incident handling, ~20 min
npx tsx scripts/gate-d.ts            # the safety machinery, ~45 min
npx tsx scripts/gate-d.ts approval   # one scenario, ~7 min
```

| What | URL |
|---|---|
| Personalized stream (ads stitched in) | `localhost:8084/session/demo-1/master.m3u8?device_class=roku&region=us-east&cdn=cdn-east` |
| Clean content stream | `localhost:8080/hls/content/master.m3u8` |
| Content manifest with SCTE-35 markers | `localhost:8081/content/live.m3u8` |
| Billing record (confirmed impressions) | `localhost:8085/stats` |
| Agent traces | `localhost:8090/trace` |

### Working on the plant

Source under `packages/` is bind-mounted into the containers, but **apply code changes
with `docker compose restart <service>`**. `docker compose up -d` is a no-op when only
mounted source changed, and `tsx watch` does not reload either: inotify events do not
cross a Docker bind mount from a Windows host, so the container keeps running the code it
started with.

## How the agent works

Nine steps, and only four of them are a model:

```
detect → triage → correlate (2 parallel branches) → hypothesize → falsify
       → plan → act → verify → document
```

- **Plan is a lookup table, never the model.** A failure class maps to a runbook or to
  nothing. F08 maps to nothing on purpose: there is no safe automatic remedy for a
  regional CDN failure from where this agent sits, so it escalates with its evidence.
- **Falsify tries to kill the hypothesis** before anything is allowed to act on it.
- **A blast-radius gate** classifies each runbook T0–T3. T1 auto-executes; T2 —
  anything that changes what every viewer on the channel is served — stops and waits for
  a human, who can approve it from the run's own trace page. Approval re-measures the
  runbook's preconditions against live telemetry first, because a plan is a snapshot and
  the plant keeps moving while it waits.
- **Verify measures the outcome, not the action.** Executing a runbook proves nothing;
  the run is only successful if billable impressions actually return. If they do not, it
  rolls back.
- **A deterministic watchdog** — no model involved — kills a run that stalls, loops, or
  spends past its ceiling, and keeps whatever work it had done.

## Telemetry

Metrics, logs and traces ship to Grafana Cloud through Grafana Alloy. Provision the
dashboards and the SLO alert with `npx tsx scripts/provision-grafana.ts`:

- **Delivery Health** — the conventional NOC view. Contains no revenue signal by design;
  it is the dashboard that stays green while the money leaks.
- **Revenue Realization** — RRR by device class, expected against realized dollars, and
  the loss ledger in dollars.
- **Agent Fleet Health** — the agent watched by the stack it operates: runs by outcome,
  watchdog interventions by reason, step durations, tokens, cost per incident.
- **Alerts** — `RRR < 0.98 for 2m`, which is what wakes the agent, and a second that
  fires whenever the agent's own watchdog has had to stop a run.

One trace spans an entire avail. Trace context is created at playout and handed
downstream the way the ad signal itself is: onto the cue bus, into the manifest as an
`X-ADBREAK-TRACE` daterange attribute, over HTTP, then onto the beacon URL — so a revenue
gap can be followed back to the exact break that caused it.

## Architecture

A simulated broadcast plant in TypeScript. Playout emits real binary SCTE-35 cues onto a
Redis cue bus; the packager injects `EXT-X-DATERANGE`/`CUE-OUT` markers at segment
boundaries; a mock VAST 4.0 ad server decides pods; SSAI builds a personalized manifest
per session with 1:1 segment substitution; a CDN edge fronts everything with
fault-injection rules; and 200 synthetic players fire the six IAB tracking beacons per
creative, which a collector deduplicates into the billing record.

On top of that: full-chain telemetry into Grafana Cloud, and a deterministic multi-step
agent on Vertex AI Gemini that detects, root-causes and repairs revenue leaks through the
Grafana MCP server.

### Deployment

`./deploy/deploy.sh` puts the whole stack on one GCE VM. It deploys as a single machine
rather than being split across managed services, so the deployed topology is the same one
every gate was run against. The agent authenticates to Vertex through the VM's attached
service account — there is no credential file on the box — and that account holds
`roles/aiplatform.user` and nothing else. Only the edge and the trace UI are exposed; the
chaos injector is unreachable from the internet, because it writes the ground-truth
ledger and nothing public should be able to.

### Scope decisions, noted rather than hidden

- The CDN tier is a thin TypeScript reverse proxy with fault-injection rules, not Envoy.
- Ad creatives are pre-conditioned to the content profile rather than transcoded on demand.
- Gate D and the evaluation pause the agent's autonomous polling so each scenario grades
  exactly one deterministic run. The polling path itself is what Gate C proves.

## Attribution

Demo stream content: *Big Buck Bunny* — © Blender Foundation |
[peach.blender.org](https://peach.blender.org), licensed CC-BY 3.0.

## License

Apache-2.0 — see [LICENSE](LICENSE).
