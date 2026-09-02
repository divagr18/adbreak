# AdBreak agent — evaluation

Scenarios: 11 · graded against ground-truth.jsonl, which the agent cannot read.

Incidents were triggered through the alert webhook with autonomous polling paused, so each
scenario grades exactly one deterministic run. The polling path itself is proven end to end
by Gate C.

- **RCA top-1 accuracy**: 100% (9/9)
- **Runbook selection**: 100% (9/9)
- **Handled correctly**: 100% (11/11)
- **False remediations**: 0
- **Mean MTTR** (detection to verified recovery): 78.6s
- **Mean cost per incident**: $0.0166

| scenario | truth | diagnosed | stage | runbook | outcome | RCA | cost |
|---|---|---|---|---|---|---|---|
| F07 beacon blackhole (roku) #1 | F07 | F07 | beacon | rb-beacon-fallback | remediated | ✓ | $0.0193 |
| F07 beacon blackhole (roku) #2 | F07 | F07 | beacon | rb-beacon-fallback | remediated | ✓ | $0.0200 |
| F07 beacon blackhole (roku) #3 | F07 | F07 | beacon | rb-beacon-fallback | remediated | ✓ | $0.0248 |
| F04 no-fill #1 | F04 | F04 | decide | rb-ads-failover | awaiting_approval | ✓ | $0.0153 |
| F04 no-fill #2 | F04 | F04 | decide | rb-ads-failover | awaiting_approval | ✓ | $0.0127 |
| F03 ADS latency #1 | F03 | F03 | decide | rb-ads-failover | awaiting_approval | ✓ | $0.0174 |
| F03 ADS latency #2 | F03 | F03 | decide | rb-ads-failover | awaiting_approval | ✓ | $0.0147 |
| F08 regional CDN 5xx #1 | F08 | F08 | deliver | — | no_action | ✓ | $0.0124 |
| F08 regional CDN 5xx #2 | F08 | F08 | deliver | — | no_action | ✓ | $0.0130 |
| clean control #1 | — | — | — | — | none | ✓ | $0.0000 |
| clean control #2 | — | — | — | — | none | ✓ | $0.0000 |