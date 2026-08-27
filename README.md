# AdBreak

**Revenue SRE for Live Streaming.**

> Your stream was up. Your revenue was down. Nobody paged.

An autonomous SRE agent whose SLO is not uptime — it's **money per ad avail**. AdBreak watches the live ad-insertion chain (SCTE-35 → packager → ad decisioning → SSAI stitch → CDN → player beacons), detects revenue leaks that every conventional dashboard reports as healthy, root-causes them through Grafana (via the Grafana MCP server), remediates with policy-gated deterministic runbooks, and is itself observed by the same observability stack it operates.

**Status: under construction** — Agentic Cinema hackathon build (Grafana track). See [VISION.md](VISION.md) for the full design.

## Quickstart (will be real by submission)

```bash
docker compose up --build
# live stream:      http://localhost:8084/hls/content/master.m3u8  (open in VLC)
# chaos injector:   POST http://localhost:8086/inject {"fault":"F07", ...}
```

## Architecture

Simulated broadcast plant (playout → packager → ADS → SSAI → CDN edge → synthetic player fleet → beacon collector) in TypeScript, full-chain telemetry into Grafana Cloud, and a deterministic multi-step ADK agent on Vertex AI Gemini that detects, root-causes, and repairs revenue leaks.

Note: the CDN tier is a thin TypeScript reverse-proxy with fault-injection rules (stand-in for Envoy — deliberate scope decision for the hackathon timeline).

## Attribution

Demo stream content: *Big Buck Bunny* — © Blender Foundation | [peach.blender.org](https://peach.blender.org), licensed CC-BY 3.0.

## License

Apache-2.0 — see [LICENSE](LICENSE).
