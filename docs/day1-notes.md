# Day 1 notes (27 Aug)

## Account setup — USER ACTION REQUIRED (do these today, ~45 min total)

### Grafana Cloud (blocks the MCP proof — highest priority)
1. Sign up: https://grafana.com/auth/sign-up/create-user (free tier)
2. Create a stack; note the stack URL (e.g. `https://<you>.grafana.net`)
3. Administration → Users and access → Service accounts → new account,
   role **Admin** (needs dashboard/annotation/incident writes) → create token.
4. Save as env vars (do NOT commit):
   - `GRAFANA_URL=https://<you>.grafana.net`
   - `GRAFANA_SERVICE_ACCOUNT_TOKEN=glsa_...`
5. While in the UI, check: is **Grafana Incident** available on the free tier?
   (VISION open decision #5 — if not, incidents live in Firestore + annotations.)

### GCP (blocks the ADK spike, not the plant)
1. Console → new project `adbreak-hack` + billing
2. Enable **Vertex AI API**
3. `gcloud auth application-default login` (run as `! gcloud auth application-default login` in this session)
4. Note project id + region (recommend `us-central1`)

## MCP + ADK-TS spike (runs once creds exist — see spike/)
- [ ] `mcp-grafana` runs locally (Docker, stdio) against the cloud stack
- [ ] `query_prometheus` works (read proof)
- [ ] `create_annotation` works (write proof)
- [ ] Tempo query tools present? (uncertain from docs — traces are stretch)
- [ ] Grafana Incident tools work on free tier?
- [ ] ADK-TS: SequentialAgent + Vertex Gemini + Grafana MCP toolset → PASS/FAIL
- [ ] Decision recorded: agent language = TS / Python fallback

## Findings

(fill in as verified)
