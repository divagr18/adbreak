# AdBreak

**Revenue SRE for Live Streaming.**

> Your stream was up. Your revenue was down. Nobody paged.

An autonomous SRE agent whose SLO is not uptime — it's **money per ad avail**. AdBreak watches the live ad-insertion chain (SCTE-35 → packager → ad decisioning → SSAI stitch → CDN → player beacons), detects revenue leaks that every conventional dashboard reports as healthy, root-causes them through Grafana (via the Grafana MCP server), remediates with policy-gated deterministic runbooks, and is itself observed by the same observability stack it operates.

**Status: under construction** — Agentic Cinema hackathon build (Grafana track). See [VISION.md](VISION.md) for the full design.

## Quickstart

```bash
docker compose up --build          # the whole plant
npx tsx scripts/gate-a.ts          # watch a real break end-to-end, then break it
```

Then, in a player:

| What | URL |
|---|---|
| Personalized stream (ads stitched in) | `http://localhost:8084/session/demo-1/master.m3u8?device_class=roku&region=us-east&cdn=cdn-east` |
| Clean content stream | `http://localhost:8080/hls/content/master.m3u8` |
| Content manifest with SCTE-35 markers | `http://localhost:8081/content/live.m3u8` |
| Billing record (confirmed impressions) | `http://localhost:8085/stats` |

Inject the flagship fault — a beacon blackhole on one device class — and watch every
delivery metric stay green while the impressions disappear:

```bash
curl -X POST localhost:8086/inject -H 'content-type: application/json' \
  -d '{"fault":"F07","params":{"device_class":"roku"},"duration_s":300}'
curl localhost:8086/faults          # the whole catalogue, self-describing
curl -X DELETE localhost:8086/inject
```

## Telemetry

Metrics, logs and traces ship to Grafana Cloud via Grafana Alloy. Provision the
dashboards and the SLO alert with `npx tsx scripts/provision-grafana.ts`:

- **Delivery Health** — the conventional NOC view. Contains no revenue signal by design.
- **Revenue Realization** — RRR by device class, expected vs realized dollars, the ledger.
- **Alert**: `RRR < 0.98 for 2m`, which is what triggers the agent.

One trace per avail spans the whole chain. Trace context is created at playout and
handed downstream the way the ad signal is: on the cue bus, then inside the manifest
as an `X-ADBREAK-TRACE` daterange attribute, then over HTTP, then on the beacon URL —
so a revenue gap can be followed back to the exact break that caused it.

## Architecture

A simulated broadcast plant in TypeScript — playout emits real SCTE-35 cues onto a
Redis cue bus, the packager injects `EXT-X-DATERANGE`/`CUE-OUT` markers at segment
boundaries, a mock VAST 4.0 ad server decides pods, SSAI builds a personalized
manifest per session, a CDN edge fronts everything, and a fleet of synthetic players
fires IAB tracking beacons that a collector turns into the billing record.

On top of that: full-chain telemetry into Grafana Cloud, and a deterministic
multi-step ADK agent on Vertex AI Gemini that detects, root-causes and repairs
revenue leaks through the Grafana MCP server.

Two deliberate scope decisions, both noted rather than hidden: the CDN tier is a thin
TypeScript reverse proxy with fault-injection rules rather than Envoy, and ad creatives
are pre-conditioned to the content profile rather than transcoded on demand.

## Attribution

Demo stream content: *Big Buck Bunny* — © Blender Foundation | [peach.blender.org](https://peach.blender.org), licensed CC-BY 3.0.

## License

Apache-2.0 — see [LICENSE](LICENSE).
