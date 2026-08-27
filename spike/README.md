# Day-1 spike

Proves: ADK-TS `SequentialAgent` + Vertex Gemini + Grafana MCP toolset, read **and** write.

## Prereqs
1. Grafana Cloud stack + service-account token (Admin role) — see `docs/day1-notes.md`
2. `docker pull mcp/grafana`
3. GCP project with Vertex AI enabled + `gcloud auth application-default login`
   (or set `GEMINI_API_KEY` for a first smoke test without Vertex)

## Run
```powershell
cd spike
npm install
$env:GRAFANA_URL = "https://<you>.grafana.net"
$env:GRAFANA_SERVICE_ACCOUNT_TOKEN = "glsa_..."
$env:GOOGLE_GENAI_USE_ENTERPRISE = "true"
$env:GOOGLE_CLOUD_PROJECT = "adbreak-hack"
$env:GOOGLE_CLOUD_LOCATION = "us-central1"
npx adk run agent.ts
# then type: check grafana
```

## Pass criteria (record in docs/day1-notes.md)
- SequentialAgent runs both steps in order
- `query_prometheus` returns data (read ✓)
- `create_annotation` returns an id — verify it's visible in the Grafana UI (write ✓)
- Note whether Tempo/incident tools appear in the toolset listing

**Any gap → agent falls back to Python ADK (plant unaffected). Record the decision either way.**
