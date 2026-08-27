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

## Findings (verified 27 Aug, all four proofs PASS)

- **Grafana MCP server (`mcp/grafana`, stdio via Docker): 73 tools.** Read: `query_prometheus`,
  `query_loki_logs` ✓. Write: `create_annotation` (annotation ids 1 & 2 created), `update_dashboard`,
  `create_incident`, `alerting_manage_rules` ✓. **Tempo tools exist** (`tempo_traceql-search`,
  `tempo_get-trace` — proxied from the stack's traces datasource). `grafana_api_request` is a generic
  escape hatch, so any missing write stays MCP-native — risk 3's HTTP-shim fallback is retired.
- **Grafana Incident**: `create_incident`/`list_incidents` tools present; free tier includes IRM.
  (Open decision #5: use it; fall back to Firestore only if calls fail in Phase C.)
- **Stack**: `https://petitesandpiper3092.grafana.net` — datasource UIDs: `grafanacloud-prom`,
  `grafanacloud-logs`, `grafanacloud-traces`. Creds in `.env` (gitignored).
- **ADK-TS (`@google/adk` 2.0.0): DECISION — agent is TypeScript.** `SequentialAgent` +
  `ParallelAgent` + `MCPToolset` + `InMemoryRunner.runEphemeral` all work. Full spike run:
  Vertex Gemini → MCP read → MCP write, autonomous tool selection correct.
- Gotchas for Phase C:
  - `SequentialAgent` is deprecated in favor of a new `Workflow` API ("cannot yet be used as an
    LlmAgent sub-agent") — still works; evaluate `Workflow` when building the 9-step agent.
  - `@modelcontextprotocol/sdk` is an optional peer dep — must be installed explicitly.
  - Vertex needs concrete model ids: `gemini-flash-latest` 404s; **`gemini-2.5-flash` works**.
    Env var is now `GOOGLE_GENAI_USE_ENTERPRISE` (old `GOOGLE_GENAI_USE_VERTEXAI` is deprecated).
  - `query_prometheus` requires explicit `startTime`/`endTime` (e.g. `"now"`).
- **GCP**: project `adbreak-hack-2026` created, billing linked, Vertex AI enabled,
  ADC quota project set. Region `us-central1`.
- **Plant**: live HLS confirmed (rolling playlist, 4s segments, PROGRAM-DATE-TIME on); all 8
  service stubs healthy with /metrics.
